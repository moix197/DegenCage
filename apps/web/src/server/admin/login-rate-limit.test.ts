import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ADMIN_LOGIN_RATE_LIMIT_MAX, ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS, attemptAdminLogin, recordRateLimitedLoginEventOnce } from './login-rate-limit';

/**
 * The throttle that closes the online-guessing oracle a security audit flagged on
 * `POST /api/admin/login`, and the follow-up audit's TOCTOU fix: `attemptAdminLogin` runs
 * the count check, the secret comparison, and the attempt insert inside one transaction, so
 * concurrent callers can no longer all observe "under the limit" before any of their inserts
 * land.
 */

const { reapExpiredAdminLoginAttemptsMock } = vi.hoisted(() => ({ reapExpiredAdminLoginAttemptsMock: vi.fn() }));
vi.mock('./login-attempt-reaper', () => ({ reapExpiredAdminLoginAttempts: reapExpiredAdminLoginAttemptsMock }));

const { recordEventMock } = vi.hoisted(() => ({ recordEventMock: vi.fn() }));
vi.mock('../../observability/events', () => ({ recordEvent: recordEventMock }));

const NOW = new Date('2026-08-26T12:00:00Z');
const CLIENT_KEY = 'client-key-hash';

interface FakeAttemptRow {
  clientKey: string;
  succeeded: boolean;
  attemptedAt: Date;
}

/**
 * A minimal in-memory stand-in for `Database`, whose `.transaction()` genuinely serializes
 * callback invocations one at a time (an async queue) — modeling the property
 * `pg_advisory_xact_lock` guarantees in real Postgres. This is what makes the concurrency
 * test below meaningful: it proves `attemptAdminLogin`'s own logic holds the budget to
 * exactly `ADMIN_LOGIN_RATE_LIMIT_MAX` *given* a serializing transaction primitive. It does
 * not, and cannot, prove Postgres's own lock semantics — that is out of scope for a
 * hermetic unit test (`.ai/decisions/migration-and-test-tooling.md`: no test opens a real
 * database connection).
 */
function createFakeDb() {
  const rows: FakeAttemptRow[] = [];
  let queue: Promise<unknown> = Promise.resolve();

  const tx = {
    execute: async () => undefined,
    select: () => ({
      from: () => ({
        where: () => {
          const since = new Date(NOW.getTime() - ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS);
          const failed = rows.filter((row) => row.clientKey === CLIENT_KEY && !row.succeeded && row.attemptedAt > since).length;

          return Promise.resolve([{ failed }]);
        },
      }),
    }),
    insert: () => ({
      values: (value: FakeAttemptRow) => {
        rows.push(value);

        return Promise.resolve(undefined);
      },
    }),
  };

  return {
    rows,
    transaction: (callback: (transactionClient: typeof tx) => Promise<unknown>) => {
      // Chains onto the shared queue so concurrent `transaction()` calls run their
      // callbacks strictly one at a time, never interleaved — the property a real
      // `pg_advisory_xact_lock` provides.
      const run = queue.then(() => callback(tx));
      queue = run.catch(() => undefined);

      return run;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  reapExpiredAdminLoginAttemptsMock.mockResolvedValue(0);
});

describe('attemptAdminLogin', () => {
  it('succeeds and records the attempt when under the limit and the secret is correct', async () => {
    const db = createFakeDb();

    const outcome = await attemptAdminLogin(db as never, CLIENT_KEY, 'corr-1', NOW, () => true);

    expect(outcome).toBe('succeeded');
    expect(db.rows).toEqual([{ clientKey: CLIENT_KEY, attemptedAt: NOW, succeeded: true }]);
  });

  it('fails and records the attempt when under the limit and the secret is wrong', async () => {
    const db = createFakeDb();

    const outcome = await attemptAdminLogin(db as never, CLIENT_KEY, 'corr-1', NOW, () => false);

    expect(outcome).toBe('failed');
    expect(db.rows).toEqual([{ clientKey: CLIENT_KEY, attemptedAt: NOW, succeeded: false }]);
  });

  it('rate-limits without ever calling verifySecret, once the failed budget is exhausted', async () => {
    const db = createFakeDb();
    for (let i = 0; i < ADMIN_LOGIN_RATE_LIMIT_MAX; i += 1) {
      await attemptAdminLogin(db as never, CLIENT_KEY, 'corr-1', NOW, () => false);
    }

    const verifySecret = vi.fn(() => true);
    const outcome = await attemptAdminLogin(db as never, CLIENT_KEY, 'corr-1', NOW, verifySecret);

    expect(outcome).toBe('rate_limited');
    // The whole point of closing the oracle: a throttled call never even reaches the secret
    // comparison, and no new row is written for it.
    expect(verifySecret).not.toHaveBeenCalled();
    expect(db.rows).toHaveLength(ADMIN_LOGIN_RATE_LIMIT_MAX);
  });

  it('a successful attempt does not reset or consume the failed-attempt budget', async () => {
    const db = createFakeDb();
    await attemptAdminLogin(db as never, CLIENT_KEY, 'corr-1', NOW, () => false);
    await attemptAdminLogin(db as never, CLIENT_KEY, 'corr-1', NOW, () => true);

    const since = new Date(NOW.getTime() - ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS);
    const failedCount = db.rows.filter((row) => !row.succeeded && row.attemptedAt > since).length;
    expect(failedCount).toBe(1);
  });

  it('reaps expired attempts opportunistically after deciding the outcome', async () => {
    const db = createFakeDb();

    await attemptAdminLogin(db as never, CLIENT_KEY, 'corr-1', NOW, () => true);

    expect(reapExpiredAdminLoginAttemptsMock).toHaveBeenCalledWith(db, 'corr-1', NOW);
  });

  /**
   * The security-audit-requested test: fires many concurrent attempts (all with a wrong
   * secret, so every one that gets through becomes a "failed" attempt) and asserts the
   * 5-attempt budget holds exactly, rather than ballooning to the burst size — the TOCTOU
   * this fix closes.
   */
  it('holds the budget at exactly ADMIN_LOGIN_RATE_LIMIT_MAX under a burst of concurrent attempts', async () => {
    const db = createFakeDb();
    const BURST_SIZE = 50;

    const outcomes = await Promise.all(
      Array.from({ length: BURST_SIZE }, () => attemptAdminLogin(db as never, CLIENT_KEY, 'corr-burst', NOW, () => false)),
    );

    const failedCount = outcomes.filter((outcome) => outcome === 'failed').length;
    const rateLimitedCount = outcomes.filter((outcome) => outcome === 'rate_limited').length;

    expect(failedCount).toBe(ADMIN_LOGIN_RATE_LIMIT_MAX);
    expect(rateLimitedCount).toBe(BURST_SIZE - ADMIN_LOGIN_RATE_LIMIT_MAX);
    expect(db.rows).toHaveLength(ADMIN_LOGIN_RATE_LIMIT_MAX);
  });

  it('different client keys never contend for the same budget', async () => {
    const db = createFakeDb();

    const outcomes = await Promise.all([
      attemptAdminLogin(db as never, 'key-a', 'corr-1', NOW, () => false),
      attemptAdminLogin(db as never, 'key-b', 'corr-1', NOW, () => false),
    ]);

    expect(outcomes).toEqual(['failed', 'failed']);
  });
});

describe('recordRateLimitedLoginEventOnce', () => {
  const selectMock = vi.fn();

  function existenceReturns(rows: unknown[]) {
    selectMock.mockReturnValueOnce({ from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }) });
  }

  function executor() {
    return { select: selectMock } as never;
  }

  beforeEach(() => {
    selectMock.mockReset();
  });

  it('records the event when none exists yet for this client key in the window', async () => {
    existenceReturns([]);

    await recordRateLimitedLoginEventOnce(executor(), CLIENT_KEY, 'corr-1', NOW);

    expect(recordEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'admin.login_rate_limited', payload: { clientKey: CLIENT_KEY } }),
      expect.anything(),
    );
  });

  it('skips recording when a matching event already exists — the query itself is scoped to this client key, so any row found means "already recorded for this key"', async () => {
    existenceReturns([{ id: 'evt-1' }]);

    await recordRateLimitedLoginEventOnce(executor(), CLIENT_KEY, 'corr-1', NOW);

    expect(recordEventMock).not.toHaveBeenCalled();
  });
});

describe('window/max constants', () => {
  it('are positive and sane', () => {
    expect(ADMIN_LOGIN_RATE_LIMIT_MAX).toBeGreaterThan(0);
    expect(ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS).toBeGreaterThan(0);
  });
});
