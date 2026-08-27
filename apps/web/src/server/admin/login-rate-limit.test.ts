import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ADMIN_LOGIN_RATE_LIMIT_MAX,
  ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS,
  AdminLoginRateLimited,
  assertWithinAdminLoginRateLimit,
  recordAdminLoginAttempt,
  recordRateLimitedLoginEventOnce,
} from './login-rate-limit';

/**
 * The throttle that closes the online-guessing oracle a security audit flagged on
 * `POST /api/admin/login`: repeated *failed* attempts from one client key must eventually be
 * rejected outright (`AdminLoginRateLimited`), before the route ever compares the caller's
 * guess against the real secret again.
 */

const { recordEventMock } = vi.hoisted(() => ({ recordEventMock: vi.fn() }));
vi.mock('../../observability/events', () => ({ recordEvent: recordEventMock }));

const NOW = new Date('2026-08-26T12:00:00Z');
const CLIENT_KEY = 'client-key-hash';

const selectMock = vi.fn();
const insertMock = vi.fn();

/** Mimics drizzle's `select().from().where()` chain, which resolves without a `.limit()` — same shape as `challenge-rate-limit.test.ts`'s `countReturning`. */
function countReturns(failed: number) {
  selectMock.mockReturnValueOnce({ from: () => ({ where: () => Promise.resolve([{ failed }]) }) });
}

function existenceReturns(rows: { payload: Record<string, unknown> }[]) {
  selectMock.mockReturnValueOnce({ from: () => ({ where: () => Promise.resolve(rows) }) });
}

function insertReturns() {
  const valuesSpy = vi.fn();
  insertMock.mockReturnValueOnce({ values: (v: unknown) => { valuesSpy(v); return Promise.resolve(undefined); } });
  return valuesSpy;
}

function executor() {
  return { select: selectMock, insert: insertMock } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('assertWithinAdminLoginRateLimit', () => {
  it('resolves when this client is under the failed-attempt max', async () => {
    countReturns(ADMIN_LOGIN_RATE_LIMIT_MAX - 1);

    await expect(assertWithinAdminLoginRateLimit(executor(), CLIENT_KEY, 'corr-1', NOW)).resolves.toBeUndefined();
  });

  it('throws AdminLoginRateLimited once this client has hit the max failed attempts — the oracle is closed', async () => {
    countReturns(ADMIN_LOGIN_RATE_LIMIT_MAX);

    await expect(assertWithinAdminLoginRateLimit(executor(), CLIENT_KEY, 'corr-1', NOW)).rejects.toBeInstanceOf(AdminLoginRateLimited);
  });

  it('throws for a count beyond the max too, not only exactly at it', async () => {
    countReturns(ADMIN_LOGIN_RATE_LIMIT_MAX + 5);

    await expect(assertWithinAdminLoginRateLimit(executor(), CLIENT_KEY, 'corr-1', NOW)).rejects.toBeInstanceOf(AdminLoginRateLimited);
  });

  it('propagates a database error rather than silently allowing the login through', async () => {
    const dbError = new Error('database unreachable');
    selectMock.mockReturnValueOnce({ from: () => ({ where: () => Promise.reject(dbError) }) });

    await expect(assertWithinAdminLoginRateLimit(executor(), CLIENT_KEY, 'corr-1', NOW)).rejects.toBe(dbError);
  });
});

describe('recordAdminLoginAttempt', () => {
  it('inserts one row carrying the client key, outcome, and timestamp', async () => {
    const valuesSpy = insertReturns();

    await recordAdminLoginAttempt(executor(), CLIENT_KEY, false, NOW);

    expect(valuesSpy).toHaveBeenCalledWith({ clientKey: CLIENT_KEY, attemptedAt: NOW, succeeded: false });
  });
});

describe('recordRateLimitedLoginEventOnce', () => {
  it('records the event when none exists yet for this client key in the window', async () => {
    existenceReturns([]);

    await recordRateLimitedLoginEventOnce(executor(), CLIENT_KEY, 'corr-1', NOW);

    expect(recordEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'admin.login_rate_limited', payload: { clientKey: CLIENT_KEY } }),
      executor(),
    );
  });

  it('skips recording when this client key already has one in the window — bounding growth under sustained hammering', async () => {
    existenceReturns([{ payload: { clientKey: CLIENT_KEY } }]);

    await recordRateLimitedLoginEventOnce(executor(), CLIENT_KEY, 'corr-1', NOW);

    expect(recordEventMock).not.toHaveBeenCalled();
  });

  it("does not skip for a different client key's existing event", async () => {
    existenceReturns([{ payload: { clientKey: 'someone-else' } }]);

    await recordRateLimitedLoginEventOnce(executor(), CLIENT_KEY, 'corr-1', NOW);

    expect(recordEventMock).toHaveBeenCalledTimes(1);
  });
});

describe('window/max constants', () => {
  it('are positive and sane', () => {
    expect(ADMIN_LOGIN_RATE_LIMIT_MAX).toBeGreaterThan(0);
    expect(ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS).toBeGreaterThan(0);
  });
});
