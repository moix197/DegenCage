import { createHash } from 'node:crypto';

import { and, count, eq, gt } from 'drizzle-orm';

import { type DatabaseExecutor } from '../../observability/events';
import { logger } from '../../observability/logger';
import { siwsChallenges } from '../db/schema';

/**
 * The throttle on `POST /api/auth/nonce`.
 *
 * That endpoint is unauthenticated by necessity — a challenge is what a caller needs
 * *before* it has an identity — and every call writes a `siws_challenges` row. Unthrottled,
 * a loop fills the table for free.
 *
 * Counted in Postgres rather than in process memory on purpose: an in-memory window is
 * per-instance, so it bounds nothing once there are two of them, and the thing being
 * protected here *is* the shared table. No new dependency and no Redis — the rate-limit
 * cache arrives with the Phase 4 worker (`.ai/decisions/single-source-of-truth-database.md`);
 * until then the rows we already write are their own counter.
 */

/** Issuances one client may buy per window. Generous for a human clicking "connect". */
export const CHALLENGE_RATE_LIMIT_MAX = 10;

/**
 * Matches the challenge TTL, so the window can never outlive the rows it counts: the
 * reaper only removes challenges that expired long ago, which keeps the count honest.
 */
export const CHALLENGE_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1_000;

/**
 * Every caller we cannot tell apart shares one bucket. Stricter than handing each
 * unidentifiable caller its own allowance, which would be no limit at all.
 */
const UNIDENTIFIED_CLIENT_KEY = 'unidentified';

/**
 * The client's address, hashed. A raw IP is personal data with no purpose here — the limit
 * only ever asks "is this the same caller as a moment ago", which a one-way hash answers.
 */
function hashClientAddress(address: string): string {
  return createHash('sha256').update(address).digest('hex').slice(0, 32);
}

/** The first hop is the client; the rest of `X-Forwarded-For` is our own proxy chain. */
function readForwardedAddress(request: Request): string | undefined {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();

  return forwarded || request.headers.get('x-real-ip')?.trim() || undefined;
}

export function clientKeyForRequest(request: Request): string {
  const address = readForwardedAddress(request);

  if (!address) {
    logger.debug('challenge request has no forwarded client address, using shared bucket');

    return UNIDENTIFIED_CLIENT_KEY;
  }

  return hashClientAddress(address);
}

export class ChallengeRateLimited extends Error {
  constructor() {
    super('challenge rate limit exceeded');
    this.name = 'ChallengeRateLimited';
  }
}

/** Seconds a rejected caller should wait — the whole window, since it is a fixed one. */
export const CHALLENGE_RATE_LIMIT_RETRY_AFTER_SECONDS = CHALLENGE_RATE_LIMIT_WINDOW_MS / 1_000;

async function countRecentChallenges(
  executor: DatabaseExecutor,
  clientKey: string,
  since: Date,
): Promise<number> {
  const rows = await executor
    .select({ issued: count() })
    .from(siwsChallenges)
    .where(and(eq(siwsChallenges.clientKey, clientKey), gt(siwsChallenges.issuedAt, since)));

  return rows[0]?.issued ?? 0;
}

/**
 * Throws `ChallengeRateLimited` when this client has had its share of the window.
 *
 * A database that will not answer throws too, and is deliberately not caught here: the
 * caller turns that into a failed request. Falling through to "issue it anyway" would make
 * the limit disappear at exactly the moment the database is already under load.
 */
export async function assertWithinChallengeRateLimit(
  executor: DatabaseExecutor,
  clientKey: string,
  correlationId: string,
  now: Date,
): Promise<void> {
  const since = new Date(now.getTime() - CHALLENGE_RATE_LIMIT_WINDOW_MS);
  const issued = await countRecentChallenges(executor, clientKey, since);

  if (issued < CHALLENGE_RATE_LIMIT_MAX) {
    return;
  }

  // Logged, never recorded as an event: `events` is append-only product data and this path
  // is reachable without any identity, so writing a row per rejected call would hand an
  // attacker the unbounded table the limit exists to deny them.
  logger.warn('siws challenge rate limit exceeded', { correlationId, clientKey, issued });

  throw new ChallengeRateLimited();
}
