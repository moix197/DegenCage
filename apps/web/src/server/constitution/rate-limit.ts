import { and, count, eq, gt } from 'drizzle-orm';

import { getDb } from '../db/client';
import { events } from '../db/schema';
import { CHALLENGE_RATE_LIMIT_MAX, CHALLENGE_RATE_LIMIT_WINDOW_MS } from '../auth/challenge-rate-limit';
import { logger } from '../../observability/logger';

/**
 * The per-user throttle on constitution write actions whose audit trail a session can
 * otherwise loop unbounded — `constitution.drafted` (`POST /api/constitution`) and
 * `constitution.activation_rejected_early` (`POST /api/constitution/activate`, replayed
 * before the deadline). Both routes are session-gated (never anonymous like
 * `POST /api/auth/nonce`), so this counts by `userId`, never a hashed client address.
 *
 * Same count-then-compare shape as `server/auth/challenge-rate-limit.ts` — reusing its
 * window/threshold constants rather than inventing new ones — against the same Postgres
 * database rather than an in-memory window (which bounds nothing once there is a second
 * instance). The table differs (`events`, not `siws_challenges`) because that file's
 * counting query is intentionally specific to the row shape it protects; generalizing it
 * would mean editing `server/auth/*`, which this phase does not touch.
 */

export class ConstitutionActionRateLimited extends Error {
  constructor() {
    super('constitution action rate limit exceeded');
    this.name = 'ConstitutionActionRateLimited';
  }
}

async function countRecentActions(userId: string, eventType: string, since: Date): Promise<number> {
  const rows = await getDb()
    .select({ issued: count() })
    .from(events)
    .where(and(eq(events.userId, userId), eq(events.eventType, eventType), gt(events.occurredAt, since)));

  return rows[0]?.issued ?? 0;
}

/**
 * Throws `ConstitutionActionRateLimited` once this user has recorded its share of a given
 * event type inside the window. A database that will not answer throws too — not caught
 * here — so callers decide what "cannot tell if this is throttled" means for them.
 */
export async function assertWithinConstitutionActionRateLimit(
  userId: string,
  eventType: string,
  correlationId: string,
  now: Date,
): Promise<void> {
  const since = new Date(now.getTime() - CHALLENGE_RATE_LIMIT_WINDOW_MS);
  const issued = await countRecentActions(userId, eventType, since);

  if (issued < CHALLENGE_RATE_LIMIT_MAX) {
    return;
  }

  logger.warn('constitution action rate limit exceeded', { correlationId, userId, eventType, issued });

  throw new ConstitutionActionRateLimited();
}
