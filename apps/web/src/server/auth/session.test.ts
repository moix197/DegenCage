import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildSessionCookie,
  establishSession,
  isSessionUsable,
  parseRevocationReason,
  resolveSession,
  revokeSession,
  SESSION_COOKIE_NAME,
  supersedePreviousSession,
  type SessionIdentity,
  type StoredSession,
} from './session';

const { selectMock, updateMock, insertMock, cookieGetMock, recordEventMock, captureErrorMock } =
  vi.hoisted(() => ({
    selectMock: vi.fn(),
    updateMock: vi.fn(),
    insertMock: vi.fn(),
    cookieGetMock: vi.fn(),
    recordEventMock: vi.fn(),
    captureErrorMock: vi.fn(),
  }));

vi.mock('../db/client', () => ({
  getDb: () => ({ select: selectMock, update: updateMock, insert: insertMock }),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: cookieGetMock }) }));
vi.mock('../../observability/events', () => ({ recordEvent: recordEventMock }));
vi.mock('../../observability/error-tracking', () => ({ captureError: captureErrorMock }));

const SESSION_ID = 'opaque-session-id';
const WALLET_ADDRESS = 'So11111111111111111111111111111111111111112';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function storedSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    walletAddress: WALLET_ADDRESS,
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    walletId: 'wallet-1',
    userId: 'user-1',
    ...overrides,
  };
}

/** Mimics drizzle's `select().from().innerJoin().where().limit()` chain. */
function lookupReturning(result: StoredSession[] | Error) {
  selectMock.mockReturnValue({
    from: () => ({
      innerJoin: () => ({
        where: () => ({
          limit: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)),
        }),
      }),
    }),
  });
}

/** Captures drizzle's `update().set().where()` — awaitable, and `.returning()`-able. */
function captureUpdate(returning: unknown[] = []) {
  const setSpy = vi.fn();
  const whereSpy = vi.fn();

  updateMock.mockReturnValue({
    set: (values: unknown) => {
      setSpy(values);
      return {
        where: (predicate: unknown) => {
          whereSpy(predicate);
          const promise = Promise.resolve(returning);

          return Object.assign(promise, { returning: () => Promise.resolve(returning) });
        },
      };
    },
  });

  return { setSpy, whereSpy };
}

beforeEach(() => {
  vi.clearAllMocks();
  cookieGetMock.mockReturnValue(undefined);
  captureUpdate();
});

describe('buildSessionCookie', () => {
  it('is httpOnly, Secure, SameSite=Lax and path-wide', () => {
    const expiresAt = new Date('2026-09-25T00:00:00Z');
    const cookie = buildSessionCookie(SESSION_ID, expiresAt);

    expect(cookie.name).toBe(SESSION_COOKIE_NAME);
    expect(cookie.value).toBe(SESSION_ID);
    expect(cookie.options).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      expires: expiresAt,
    });
  });
});

describe('establishSession', () => {
  function executorForNewWallet() {
    const sessionValues = vi.fn().mockResolvedValue(undefined);

    return {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
      insert: (table: unknown) => ({
        values: (row: unknown) => {
          if (row && typeof row === 'object' && 'idHash' in row) {
            return sessionValues(row);
          }

          return {
            returning: async () => [{ id: 'user-1' }],
          };
        },
        table,
      }),
      sessionValues,
    };
  }

  it('stores only the hash of the session id, never the id itself', async () => {
    const executor = executorForNewWallet();

    const session = await establishSession(
      executor as never,
      WALLET_ADDRESS,
      'trade-intent-1',
    );

    const stored = executor.sessionValues.mock.calls[0]?.[0] as { idHash: string };
    expect(stored.idHash).toBe(sha256(session.cookie.value));
    expect(stored.idHash).not.toBe(session.cookie.value);
  });

  it('expires 30 days out and records the event through the same executor', async () => {
    const executor = executorForNewWallet();

    const session = await establishSession(executor as never, WALLET_ADDRESS, 'trade-intent-2');

    const lifetimeMs = session.expiresAt.getTime() - Date.now();
    expect(lifetimeMs).toBeGreaterThan(29 * 24 * 60 * 60 * 1_000);
    expect(lifetimeMs).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1_000);
    expect(recordEventMock).toHaveBeenCalledOnce();
    expect(recordEventMock.mock.calls[0]?.[0]).toMatchObject({
      eventType: 'auth.session_created',
      correlationId: 'trade-intent-2',
    });
    expect(recordEventMock.mock.calls[0]?.[1]).toBe(executor);
  });
});

describe('isSessionUsable', () => {
  const now = new Date('2026-08-26T12:00:00Z');

  it('rejects an unknown session id', () => {
    expect(isSessionUsable(undefined, now)).toBe(false);
  });

  it('rejects a revoked session even while it is still inside its expiry window', () => {
    const row = storedSession({
      revokedAt: new Date('2026-08-26T11:00:00Z'),
      expiresAt: new Date('2026-09-25T00:00:00Z'),
    });

    expect(isSessionUsable(row, now)).toBe(false);
  });

  it('rejects an expired session', () => {
    expect(isSessionUsable(storedSession({ expiresAt: new Date('2026-08-26T11:59:59Z') }), now)).toBe(
      false,
    );
  });

  it('accepts a live, unrevoked session', () => {
    expect(isSessionUsable(storedSession({ expiresAt: new Date('2026-08-27T00:00:00Z') }), now)).toBe(
      true,
    );
  });
});

describe('resolveSession', () => {
  it('returns null with no cookie, without touching the database', async () => {
    await expect(resolveSession()).resolves.toBeNull();
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('resolves the wallet and user bound to a live session', async () => {
    lookupReturning([storedSession()]);

    await expect(resolveSession(SESSION_ID)).resolves.toMatchObject({
      walletAddress: WALLET_ADDRESS,
      walletId: 'wallet-1',
      userId: 'user-1',
    });
  });

  it('slides the expiry forward on every resolved request', async () => {
    lookupReturning([storedSession()]);
    const { setSpy } = captureUpdate();

    const session = await resolveSession(SESSION_ID);

    expect(setSpy).toHaveBeenCalledOnce();
    const values = setSpy.mock.calls[0]?.[0] as { expiresAt: Date };
    expect(values.expiresAt).toEqual(session?.expiresAt);
  });

  it('fails a revoked session', async () => {
    lookupReturning([storedSession({ revokedAt: new Date() })]);

    await expect(resolveSession(SESSION_ID)).resolves.toBeNull();
  });

  it('fails an expired session', async () => {
    lookupReturning([storedSession({ expiresAt: new Date(Date.now() - 1) })]);

    await expect(resolveSession(SESSION_ID)).resolves.toBeNull();
  });

  it('fails an unknown session id', async () => {
    lookupReturning([]);

    await expect(resolveSession(SESSION_ID)).resolves.toBeNull();
  });

  it('fails closed when the database is unreachable, and reports it', async () => {
    lookupReturning(new Error('connection terminated'));

    await expect(resolveSession(SESSION_ID)).resolves.toBeNull();
    expect(captureErrorMock).toHaveBeenCalledOnce();
    expect(captureErrorMock.mock.calls[0]?.[1]).toMatchObject({ failedClosed: true });
  });

  it('reads the request cookie when no id is passed', async () => {
    cookieGetMock.mockReturnValue({ value: SESSION_ID });
    lookupReturning([storedSession()]);

    await expect(resolveSession()).resolves.not.toBeNull();
    expect(cookieGetMock).toHaveBeenCalledWith(SESSION_COOKIE_NAME);
  });
});

describe('revokeSession', () => {
  it('marks the session revoked and records the event with its reason', async () => {
    cookieGetMock.mockReturnValue({ value: SESSION_ID });
    const { setSpy } = captureUpdate([{ walletAddress: WALLET_ADDRESS }]);

    await revokeSession('trade-intent-3', 'account_switch');

    expect((setSpy.mock.calls[0]?.[0] as { revokedAt: Date }).revokedAt).toBeInstanceOf(Date);
    expect(recordEventMock.mock.calls[0]?.[0]).toMatchObject({
      eventType: 'auth.session_revoked',
      correlationId: 'trade-intent-3',
      payload: { walletAddress: WALLET_ADDRESS, reason: 'account_switch' },
    });
  });

  it('is a no-op without a session cookie', async () => {
    await revokeSession('trade-intent-4', 'client_request');

    expect(updateMock).not.toHaveBeenCalled();
    expect(recordEventMock).not.toHaveBeenCalled();
  });
});

describe('parseRevocationReason', () => {
  it('keeps a reason it recognises', () => {
    expect(parseRevocationReason('wallet_disconnected')).toBe('wallet_disconnected');
  });

  it('never writes an invented reason into the audit trail', () => {
    expect(parseRevocationReason('<script>alert(1)</script>')).toBe('client_request');
    expect(parseRevocationReason(null)).toBe('client_request');
  });
});

describe('supersedePreviousSession', () => {
  const OTHER_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  function previousSession(walletAddress: string): SessionIdentity {
    return {
      walletAddress,
      walletId: 'wallet-1',
      userId: 'user-1',
      expiresAt: new Date(Date.now() + 60_000),
    };
  }

  beforeEach(() => {
    cookieGetMock.mockReturnValue({ value: SESSION_ID });
  });

  /**
   * The regression for the switch going unnoticed. The wallet had already moved to another
   * account; whether or not the extension ever said so, the moment a signature proves a
   * different address the session bound to the old one has to die here — server-side, in
   * the request that proved it, with nothing to rely on but the cookie and the signature.
   */
  it('revokes the session the request arrived with when a different wallet signs in', async () => {
    const { setSpy } = captureUpdate([{ walletAddress: WALLET_ADDRESS }]);

    await supersedePreviousSession(previousSession(WALLET_ADDRESS), OTHER_ADDRESS, 'trade-intent-5');

    expect((setSpy.mock.calls[0]?.[0] as { revokedAt: Date }).revokedAt).toBeInstanceOf(Date);
    expect(recordEventMock.mock.calls.map((call) => call[0])).toMatchObject([
      {
        eventType: 'auth.wallet_account_switched',
        correlationId: 'trade-intent-5',
        userId: 'user-1',
        payload: { previousAddress: WALLET_ADDRESS, verifiedAddress: OTHER_ADDRESS },
      },
      { eventType: 'auth.session_revoked', payload: { reason: 'account_switch' } },
    ]);
  });

  it('supersedes the old session when the same wallet signs in again, without crying switch', async () => {
    captureUpdate([{ walletAddress: WALLET_ADDRESS }]);

    await supersedePreviousSession(previousSession(WALLET_ADDRESS), WALLET_ADDRESS, 'trade-intent-6');

    expect(recordEventMock.mock.calls.map((call) => call[0])).toMatchObject([
      { eventType: 'auth.session_revoked', payload: { reason: 'superseded_by_sign_in' } },
    ]);
  });

  it('has nothing to supersede on a first sign-in', async () => {
    await supersedePreviousSession(null, WALLET_ADDRESS, 'trade-intent-7');

    expect(updateMock).not.toHaveBeenCalled();
    expect(recordEventMock).not.toHaveBeenCalled();
  });
});
