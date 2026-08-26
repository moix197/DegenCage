import { lt } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { siwsChallenges, type SiwsChallengeRow } from '../db/schema';
import { CHALLENGE_RETENTION_MS, reapExpiredChallenges } from './challenge-reaper';

const NOW = new Date('2026-08-26T12:00:00Z');
const CUTOFF = new Date(NOW.getTime() - CHALLENGE_RETENTION_MS);
const CHALLENGE_TTL_MS = 5 * 60 * 1_000;

const deleteMock = vi.fn();
const whereSpy = vi.fn();

function deleteReturning(rows: { nonce: string }[]) {
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

function challenge(overrides: Partial<SiwsChallengeRow>): SiwsChallengeRow {
  const issuedAt = overrides.issuedAt ?? NOW;

  return {
    nonce: 'nonce',
    input: {
      domain: 'degencage.test',
      statement: 'statement',
      nonce: 'nonce',
      issuedAt: issuedAt.toISOString(),
      expirationTime: new Date(issuedAt.getTime() + CHALLENGE_TTL_MS).toISOString(),
    },
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + CHALLENGE_TTL_MS),
    consumedAt: null,
    clientKey: 'client-key-hash',
    rejectionRecordedAt: null,
    ...overrides,
  };
}

/** The predicate the reaper asked the database to apply, evaluated against one row. */
function wouldBeReaped(row: SiwsChallengeRow): boolean {
  return row.expiresAt.getTime() < CUTOFF.getTime();
}

beforeEach(() => {
  vi.clearAllMocks();
  deleteReturning([]);
});

describe('reapExpiredChallenges', () => {
  it('deletes by expiry alone, past the retention window', async () => {
    await reapExpiredChallenges(executor(), 'trade-intent-1', NOW);

    expect(whereSpy).toHaveBeenCalledWith(lt(siwsChallenges.expiresAt, CUTOFF));
  });

  it('reports how many rows went', async () => {
    deleteReturning([{ nonce: 'a' }, { nonce: 'b' }]);

    await expect(reapExpiredChallenges(executor(), 'trade-intent-2', NOW)).resolves.toBe(2);
  });

  /**
   * The property that matters: a sign-in in flight cannot be broken by the reaper, and it
   * is the *predicate* that guarantees it, not timing. A live challenge's expiry is in the
   * future, and the cutoff is an hour in the past — it is not reachable from this `WHERE`
   * even in principle.
   */
  it('cannot touch a live unconsumed challenge', async () => {
    const live = challenge({ issuedAt: new Date(NOW.getTime() - 60_000) });

    expect(live.consumedAt).toBeNull();
    expect(live.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
    expect(wouldBeReaped(live)).toBe(false);
  });

  /**
   * Recently expired rows stay a while: `challenge-rate-limit` counts issuances inside a
   * five-minute window, and deleting a row that window still needs would quietly refund the
   * caller its allowance.
   */
  it('leaves a recently expired challenge alone until the retention window passes', async () => {
    const justExpired = challenge({ issuedAt: new Date(NOW.getTime() - 6 * 60 * 1_000) });

    expect(justExpired.expiresAt.getTime()).toBeLessThan(NOW.getTime());
    expect(wouldBeReaped(justExpired)).toBe(false);
  });

  it('takes long-expired challenges, consumed or not', async () => {
    const issuedAt = new Date(NOW.getTime() - 2 * CHALLENGE_RETENTION_MS);
    const abandoned = challenge({ issuedAt });
    const spent = challenge({ issuedAt, consumedAt: new Date(issuedAt.getTime() + 1_000) });

    expect(wouldBeReaped(abandoned)).toBe(true);
    expect(wouldBeReaped(spent)).toBe(true);
  });
});
