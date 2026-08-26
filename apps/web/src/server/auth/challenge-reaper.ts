import { lt } from 'drizzle-orm';

import { type DatabaseExecutor } from '../../observability/events';
import { logger } from '../../observability/logger';
import { siwsChallenges } from '../db/schema';

/**
 * Garbage collection for `siws_challenges`.
 *
 * A challenge is worthless the moment it expires — expiry is checked against the stored
 * row on every verification, so a row past `expires_at` can never buy a session again,
 * consumed or not. Left alone they accumulate forever.
 *
 * Deliberately not a scheduled job: there is no worker process until Phase 4, and standing
 * up scheduling infrastructure to delete a handful of rows would be more moving parts than
 * the problem has. It runs opportunistically on the one write path that creates the rows.
 */

/**
 * How long an expired challenge is kept before deletion.
 *
 * Not zero: `challenge-rate-limit` counts issuances inside a 5-minute window, and reaping
 * a row that window still needs would quietly refund the caller its allowance. Anything
 * comfortably longer than the window keeps the two independent.
 */
export const CHALLENGE_RETENTION_MS = 60 * 60 * 1_000;

/**
 * Deletes challenges that expired more than `CHALLENGE_RETENTION_MS` ago.
 *
 * Keyed on `expires_at` alone, and never on `consumed_at`: a live unconsumed challenge has
 * its expiry in the future and is therefore unreachable from this predicate, which is what
 * makes "the reaper cannot break a sign-in in flight" a property of the query rather than
 * of timing. Backed by `siws_challenges_expires_at_idx`.
 *
 * @returns How many rows went.
 */
export async function reapExpiredChallenges(
  executor: DatabaseExecutor,
  correlationId: string,
  now: Date,
): Promise<number> {
  const cutoff = new Date(now.getTime() - CHALLENGE_RETENTION_MS);

  const reaped = await executor
    .delete(siwsChallenges)
    .where(lt(siwsChallenges.expiresAt, cutoff))
    .returning({ nonce: siwsChallenges.nonce });

  if (reaped.length > 0) {
    logger.info('expired siws challenges reaped', { correlationId, reaped: reaped.length });
  }

  return reaped.length;
}
