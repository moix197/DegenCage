import { lt } from 'drizzle-orm';

import { type DatabaseExecutor } from '../../observability/events';
import { logger } from '../../observability/logger';
import { adminLoginAttempts } from '../db/schema';

/**
 * Garbage collection for `admin_login_attempts` — same pattern as
 * `server/auth/challenge-reaper.ts` for `siws_challenges`, not a second mechanism: no
 * scheduled job (there is no worker process until Phase 4), run opportunistically on the one
 * write path that creates the rows (`login-rate-limit.ts`'s `attemptAdminLogin`).
 *
 * Left unreaped, this table grows from unauthenticated traffic with no volume cap of its
 * own: an attacker with many distinct client keys (trivial over IPv6, where a single actor
 * controls a huge address block) writes one row per key per attempt, and the per-key
 * throttle in `login-rate-limit.ts` bounds *guessing speed* per key, not the *number of
 * keys* that can each open their own small budget.
 */

/**
 * How long a row is kept before deletion. Comfortably longer than
 * `ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS` (15 min) for the same reason `challenge-reaper.ts` picks
 * its own retention relative to `CHALLENGE_RATE_LIMIT_WINDOW_MS`: reaping a row the throttle's
 * own window still needs to count would quietly refund the caller's allowance early.
 */
export const ADMIN_LOGIN_ATTEMPT_RETENTION_MS = 60 * 60 * 1_000;

/**
 * Deletes attempts older than `ADMIN_LOGIN_ATTEMPT_RETENTION_MS`.
 *
 * Keyed on `attempted_at` alone, backed by `admin_login_attempts_client_key_attempted_at_idx`
 * (the same index the throttle's own count query uses).
 *
 * @returns How many rows went.
 */
export async function reapExpiredAdminLoginAttempts(executor: DatabaseExecutor, correlationId: string, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - ADMIN_LOGIN_ATTEMPT_RETENTION_MS);

  const reaped = await executor
    .delete(adminLoginAttempts)
    .where(lt(adminLoginAttempts.attemptedAt, cutoff))
    .returning({ id: adminLoginAttempts.id });

  if (reaped.length > 0) {
    logger.info('expired admin login attempts reaped', { correlationId, reaped: reaped.length });
  }

  return reaped.length;
}
