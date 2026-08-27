import { and, count, eq, gt, sql } from 'drizzle-orm';

import { captureError } from '../../observability/error-tracking';
import { recordEvent, type DatabaseExecutor } from '../../observability/events';
import { logger } from '../../observability/logger';
import { type Database } from '../db/client';
import { adminLoginAttempts, events } from '../db/schema';
import { reapExpiredAdminLoginAttempts } from './login-attempt-reaper';

/**
 * The throttle on `POST /api/admin/login` — a small sibling to
 * `server/auth/challenge-rate-limit.ts`'s shape, not an extension of
 * `server/constitution/rate-limit.ts`: that helper is keyed by `(userId, eventType)` against
 * `events.user_id`, a real FK to `users`, and login is unauthenticated (there is no user yet
 * to key on) — bending it to accept an arbitrary hashed client key in place of a user id
 * would change what that column means for every existing caller. `clientKeyForRequest`
 * (`challenge-rate-limit.ts`) is reused as-is for deriving the key; only the counting query
 * and the table it counts against are new, against a dedicated table (`admin_login_attempts`)
 * instead of `siws_challenges`.
 *
 * The client key's trust boundary is inherited from `clientKeyForRequest` — see
 * `.ai/decisions/rate-limit-forwarded-header-trust.md`, now extended to cover this throttle
 * too. On a non-Vercel deploy this budget is only as real as the forwarded header it keys on.
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

async function countRecentFailedAttempts(executor: DatabaseExecutor, clientKey: string, since: Date): Promise<number> {
  const rows = await executor
    .select({ failed: count() })
    .from(adminLoginAttempts)
    .where(and(eq(adminLoginAttempts.clientKey, clientKey), eq(adminLoginAttempts.succeeded, false), gt(adminLoginAttempts.attemptedAt, since)));

  return rows[0]?.failed ?? 0;
}

export type AdminLoginAttemptOutcome = 'rate_limited' | 'succeeded' | 'failed';

/**
 * Atomically decides *and records* one login attempt. Check-and-insert used to be two
 * separate steps with no transaction between them (a `SELECT count` in what was
 * `assertWithinAdminLoginRateLimit`, an `INSERT` later in the route once the secret was
 * verified). A security audit found that was TOCTOU under concurrency: a burst of N
 * simultaneous `POST`s could all read `failed < 5` before any of their inserts committed, so
 * the *effective* budget under a burst was N, not 5 — the throttle's stated bound was simply
 * wrong. This closes it by running the count, the secret check, and the insert inside one
 * transaction, serialized per client key via `pg_advisory_xact_lock(hashtext(clientKey))` —
 * the exact technique `challenge-rate-limit.ts`'s own doc comment already names as the fix
 * for this class of race (that file accepts the race instead, for a lower-stakes resource;
 * an online-guessing budget is exactly the case where the stated bound has to be real).
 * `hashtext` is a built-in Postgres function, no extension required. Different client keys
 * still proceed fully in parallel — the lock is scoped to one hashed key's transaction, not
 * global (modulo the small chance two different keys hash to the same 32-bit int, which only
 * costs extra contention between unrelated callers, never a security failure).
 *
 * `verifySecret` runs *inside* the transaction, between the count check and the insert, so
 * "is this attempt allowed" and "did it succeed" are one atomic decision per client key —
 * there is no window in which a second concurrent request for the same key can observe a
 * stale count.
 *
 * A database/transaction error propagates rather than being caught here: the caller fails
 * closed (denies the login) rather than falling through to "allow it, we couldn't check."
 */
export async function attemptAdminLogin(
  db: Database,
  clientKey: string,
  correlationId: string,
  now: Date,
  verifySecret: () => boolean,
): Promise<AdminLoginAttemptOutcome> {
  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${clientKey}))`);

    const since = new Date(now.getTime() - ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS);
    const failed = await countRecentFailedAttempts(tx, clientKey, since);

    if (failed >= ADMIN_LOGIN_RATE_LIMIT_MAX) {
      return 'rate_limited' as const;
    }

    const succeeded = verifySecret();

    await tx.insert(adminLoginAttempts).values({ clientKey, attemptedAt: now, succeeded });

    return succeeded ? ('succeeded' as const) : ('failed' as const);
  });

  if (outcome === 'rate_limited') {
    logger.warn('admin login rate limit exceeded', { correlationId, clientKey });
  }

  // Housekeeping, on the write path that produces the garbage — same shape as
  // `solana-siws.ts`'s `reapOpportunistically`. Never fatal: the outcome above is already
  // decided, so a failed reap must not turn a successful/failed login into a 503.
  try {
    await reapExpiredAdminLoginAttempts(db, correlationId, now);
  } catch (error) {
    captureError(error, { correlationId, operation: 'reapExpiredAdminLoginAttempts' });
  }

  return outcome;
}

const ADMIN_LOGIN_RATE_LIMITED_EVENT_TYPE = 'admin.login_rate_limited';

/**
 * True if a `admin.login_rate_limited` event already exists for *this* client key inside the
 * window. Filtered by `clientKey` directly in the query (a jsonb path predicate,
 * `payload->>'clientKey'`), not in JS across every client key's events — an earlier version
 * fetched every recent `admin.login_rate_limited` row regardless of key and filtered in
 * application code, which a code review correctly flagged: the "bounded set" claim in that
 * version's comment was true *per key* but false *across keys* — a distributed attacker
 * hammering from many client keys would make every throttled request scan an ever-growing
 * set. This query is bounded per key instead, matching what it's actually guarding.
 */
async function hasRecentRateLimitedLoginEvent(executor: DatabaseExecutor, clientKey: string, since: Date): Promise<boolean> {
  const rows = await executor
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.eventType, ADMIN_LOGIN_RATE_LIMITED_EVENT_TYPE), gt(events.occurredAt, since), sql`${events.payload}->>'clientKey' = ${clientKey}`))
    .limit(1);

  return rows.length > 0;
}

/**
 * Records `admin.login_rate_limited` at most once per client key per window — without this
 * guard, every subsequent millisecond-spaced request from an already-locked-out caller would
 * each write a new `events` row for the rest of the window, since a throttled call never
 * lands a new `admin_login_attempts` row (the thing that would otherwise naturally bound it).
 * Same self-throttle *purpose* as `constitution/pending-changes.ts`'s
 * `recordRateLimitedAttempt`, implemented as an existence check instead of that function's
 * generic userId-keyed limiter — there is no userId here to key on.
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
