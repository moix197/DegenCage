import { lt } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { adminLoginAttempts } from '../db/schema';
import { ADMIN_LOGIN_ATTEMPT_RETENTION_MS, reapExpiredAdminLoginAttempts } from './login-attempt-reaper';

/**
 * Mirrors `challenge-reaper.test.ts` — same pattern (opportunistic deletion, keyed on
 * `attempted_at` alone) applied to `admin_login_attempts` instead of `siws_challenges`, per
 * the security-audit direction to reuse the existing mechanism rather than invent a second
 * one.
 */

const NOW = new Date('2026-08-26T12:00:00Z');
const CUTOFF = new Date(NOW.getTime() - ADMIN_LOGIN_ATTEMPT_RETENTION_MS);

const deleteMock = vi.fn();
const whereSpy = vi.fn();

function deleteReturning(rows: { id: string }[]) {
  deleteMock.mockReturnValue({
    where: (predicate: unknown) => {
      whereSpy(predicate);

      return { returning: async () => rows };
    },
  });
}

function executor() {
  return { delete: deleteMock } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  deleteReturning([]);
});

describe('reapExpiredAdminLoginAttempts', () => {
  it('deletes by attempted_at alone, past the retention window', async () => {
    await reapExpiredAdminLoginAttempts(executor(), 'corr-1', NOW);

    expect(whereSpy).toHaveBeenCalledWith(lt(adminLoginAttempts.attemptedAt, CUTOFF));
  });

  it('reports how many rows went', async () => {
    deleteReturning([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);

    await expect(reapExpiredAdminLoginAttempts(executor(), 'corr-2', NOW)).resolves.toBe(3);
  });

  it('is a no-op (reports 0) when nothing is old enough', async () => {
    deleteReturning([]);

    await expect(reapExpiredAdminLoginAttempts(executor(), 'corr-3', NOW)).resolves.toBe(0);
  });

  /**
   * Retention is comfortably longer than `ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS` (15 min) so the
   * throttle's own count query never loses a row it still needs — same reasoning
   * `challenge-reaper.ts`'s `CHALLENGE_RETENTION_MS` documents for its own window.
   */
  it('retention window is longer than the throttle window it must not interfere with', () => {
    const ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1_000;

    expect(ADMIN_LOGIN_ATTEMPT_RETENTION_MS).toBeGreaterThan(ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS);
  });
});
