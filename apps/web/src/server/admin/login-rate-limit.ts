import { and, count, eq, gt } from 'drizzle-orm';

import { recordEvent, type DatabaseExecutor } from '../../observability/events';
import { logger } from '../../observability/logger';
import { adminLoginAttempts, events } from '../db/schema';

/**
 * The throttle on `POST /api/admin/login` — a small sibling to
 * `server/auth/challenge-rate-limit.ts`'s shape, not an extension of
 * `server/constitution/rate-limit.ts`: that helper is keyed by `(userId, eventType)` against
 * `events.user_id`, a real FK to `users`, and login is unauthenticated (there is no user yet
 * to key on) — bending it to accept an arbitrary hashed client key in place of a user id
 * would change what that column means for every existing caller. `clientKeyForRequest`
 * (`challenge-rate-limit.ts`) is reused as-is for deriving the key; only the counting query
 * and the table it counts against are new, mirroring that same file's own
 * `assertWithinChallengeRateLimit`/`countRecentChallenges` shape against a dedicated table
 * (`admin_login_attempts`) instead of `siws_challenges`.
 */

/** Failed attempts one client may make per window before being locked out. */
export const ADMIN_LOGIN_RATE_LIMIT_MAX = 5;

/**
 * Deliberately longer than the nonce endpoint's 5-minute window: this gates a single shared
 * secret with no per-identity backing, so the cost of a false lockout (a legitimate operator
 * waits longer) is far lower than the cost of a fast retry budget against a brute-force
 * guesser.
 */
export const ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1_000;

export const ADMIN_LOGIN_RATE_LIMIT_RETRY_AFTER_SECONDS = ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS / 1_000;

export class AdminLoginRateLimited extends Error {
  constructor() {
    super('admin login rate limit exceeded');
    this.name = 'AdminLoginRateLimited';
  }
}

async function countRecentFailedAttempts(executor: DatabaseExecutor, clientKey: string, since: Date): Promise<number> {
  const rows = await executor
    .select({ failed: count() })
    .from(adminLoginAttempts)
    .where(and(eq(adminLoginAttempts.clientKey, clientKey), eq(adminLoginAttempts.succeeded, false), gt(adminLoginAttempts.attemptedAt, since)));

  return rows[0]?.failed ?? 0;
}

/**
 * Throws `AdminLoginRateLimited` once this client has had its share of *failed* attempts
 * inside the window — a successful login never counts against the caller's own budget, but
 * also never resets it early; the window is fixed, same as the challenge limiter.
 *
 * A database that will not answer throws too, deliberately not caught here: the route fails
 * closed (denies the login attempt) rather than falling through to "allow it, we couldn't
 * check" — the same shape as every other rate limiter in this codebase.
 */
export async function assertWithinAdminLoginRateLimit(executor: DatabaseExecutor, clientKey: string, correlationId: string, now: Date): Promise<void> {
  const since = new Date(now.getTime() - ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS);
  const failed = await countRecentFailedAttempts(executor, clientKey, since);

  if (failed < ADMIN_LOGIN_RATE_LIMIT_MAX) {
    return;
  }

  logger.warn('admin login rate limit exceeded', { correlationId, clientKey, failed });

  throw new AdminLoginRateLimited();
}

/**
 * Records one attempt — win or lose — for future throttle checks. Only ever called *after*
 * `assertWithinAdminLoginRateLimit` has passed (never for an already-throttled call), which
 * is what keeps this table's growth bounded to `ADMIN_LOGIN_RATE_LIMIT_MAX` failed rows per
 * client key per window, the same accepted-cost shape `siws_challenges` already has.
 */
export async function recordAdminLoginAttempt(executor: DatabaseExecutor, clientKey: string, succeeded: boolean, now: Date): Promise<void> {
  await executor.insert(adminLoginAttempts).values({ clientKey, attemptedAt: now, succeeded });
}

const ADMIN_LOGIN_RATE_LIMITED_EVENT_TYPE = 'admin.login_rate_limited';

/**
 * True if a `admin.login_rate_limited` event already exists for this client key inside the
 * window — filtered in JS over a small, bounded row set (this event type is itself
 * self-throttled to at most one per client key per window, so the set being scanned never
 * grows unbounded), the same "query broadly, filter in application code" convention
 * `server/metrics/queries.ts` and `dashboard/violations-feed.ts` already use for payload
 * fields with no dedicated index.
 */
async function hasRecentRateLimitedLoginEvent(executor: DatabaseExecutor, clientKey: string, since: Date): Promise<boolean> {
  const rows = await executor
    .select({ payload: events.payload })
    .from(events)
    .where(and(eq(events.eventType, ADMIN_LOGIN_RATE_LIMITED_EVENT_TYPE), gt(events.occurredAt, since)));

  return rows.some((row) => row.payload.clientKey === clientKey);
}

/**
 * Records `admin.login_rate_limited` at most once per client key per window — without this
 * guard, every subsequent millisecond-spaced request from an already-locked-out caller would
 * each write a new `events` row for the rest of the window, since a throttled call never
 * reaches `recordAdminLoginAttempt` (the thing that would otherwise naturally bound it). Same
 * self-throttle *purpose* as `constitution/pending-changes.ts`'s `recordRateLimitedAttempt`,
 * implemented as an existence check instead of that function's generic userId-keyed limiter
 * — there is no userId here to key on.
 */
export async function recordRateLimitedLoginEventOnce(executor: DatabaseExecutor, clientKey: string, correlationId: string, now: Date): Promise<void> {
  const since = new Date(now.getTime() - ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS);
  const alreadyRecorded = await hasRecentRateLimitedLoginEvent(executor, clientKey, since);

  if (alreadyRecorded) {
    return;
  }

  await recordEvent(
    { eventType: ADMIN_LOGIN_RATE_LIMITED_EVENT_TYPE, occurredAt: now, correlationId, userId: null, payload: { clientKey } },
    executor,
  );
}
