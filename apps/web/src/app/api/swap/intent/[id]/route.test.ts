import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConstitutionActionRateLimited } from '@/server/constitution/rate-limit';

import { GET } from './route';

/**
 * Route-level wiring only, invoked directly the way `api/swap/submit/route.test.ts` does: the
 * gate, the id validation, the wallet-scoping that makes a foreign intent indistinguishable
 * from a missing one, and (BLOCKING 1) the stale-submitted/signed resolution attempt this route
 * now drives itself.
 *
 * `@/server/constitution/rate-limit` is partially mocked (`importOriginal`, matching
 * `intent-lifecycle.test.ts`'s convention elsewhere in this codebase) so `ConstitutionActionRateLimited`
 * stays the real class — the route's `instanceof` check must see the exact same reference this
 * file constructs below.
 */

const {
  isFeatureEnabledMock,
  resolveSessionMock,
  loadIntentStatusForWalletMock,
  captureErrorMock,
  reconcileWalletMock,
  isStrandedSubmittedIntentMock,
  assertRateLimitMock,
  recordEventMock,
} = vi.hoisted(() => ({
  isFeatureEnabledMock: vi.fn(),
  resolveSessionMock: vi.fn(),
  loadIntentStatusForWalletMock: vi.fn(),
  captureErrorMock: vi.fn(),
  reconcileWalletMock: vi.fn(),
  isStrandedSubmittedIntentMock: vi.fn(),
  assertRateLimitMock: vi.fn(),
  recordEventMock: vi.fn(),
}));

vi.mock('@/server/flags/feature-flags', () => ({ isFeatureEnabled: isFeatureEnabledMock, TRADE_TERMINAL_FLAG: 'trade.terminal' }));
vi.mock('@/server/auth/session', () => ({ resolveSession: resolveSessionMock }));
vi.mock('@/observability/error-tracking', () => ({ captureError: captureErrorMock }));
vi.mock('@/observability/events', () => ({ recordEvent: recordEventMock }));
vi.mock('@/server/swap/intent-lifecycle', () => ({ loadIntentStatusForWallet: loadIntentStatusForWalletMock }));
vi.mock('@/server/chain/reconcile-wallet', () => ({
  reconcileWallet: reconcileWalletMock,
  isStrandedSubmittedIntent: isStrandedSubmittedIntentMock,
  CHAIN_HELIUS_RECONCILE_FLAG: 'chain.helius_reconcile',
}));
vi.mock('@/server/constitution/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/constitution/rate-limit')>();
  return { ...actual, assertWithinConstitutionActionRateLimit: assertRateLimitMock };
});

const INTENT_ID = '11111111-2222-3333-4444-555555555555';
const SESSION = { walletId: 'wallet-1', walletAddress: 'BPFLoaderUpgradeab1e11111111111111111111111', userId: 'user-1' };
const FAR_FUTURE = new Date(Date.now() + 60_000);
const FLAGS_ON = (flag: string) => Promise.resolve(flag === 'trade.terminal' || flag === 'chain.helius_reconcile');

function statusRequest(): Request {
  return new Request(`http://localhost/api/swap/intent/${INTENT_ID}`);
}

function paramsFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe('GET /api/swap/intent/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isFeatureEnabledMock.mockImplementation(FLAGS_ON);
    resolveSessionMock.mockResolvedValue(SESSION);
    loadIntentStatusForWalletMock.mockResolvedValue({ status: 'submitted', signature: 'sig-1', expiresAt: FAR_FUTURE });
    isStrandedSubmittedIntentMock.mockReturnValue(false);
    assertRateLimitMock.mockResolvedValue(undefined);
    reconcileWalletMock.mockResolvedValue({ walletId: 'wallet-1', isBaseline: false, tradesPersisted: 0, excludedPersisted: 0, reconciledThroughSlot: null });
  });

  it('returns the intent status for the session wallet', async () => {
    const response = await GET(statusRequest(), paramsFor(INTENT_ID));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'submitted', signature: 'sig-1' });
  });

  it('scopes the lookup to the session wallet, never a caller-supplied one', async () => {
    await GET(statusRequest(), paramsFor(INTENT_ID));

    expect(loadIntentStatusForWalletMock).toHaveBeenCalledWith(INTENT_ID, SESSION.walletId);
  });

  it('503s when the terminal flag is off, without reading anything', async () => {
    isFeatureEnabledMock.mockResolvedValue(false);

    const response = await GET(statusRequest(), paramsFor(INTENT_ID));

    expect(response.status).toBe(503);
    expect(loadIntentStatusForWalletMock).not.toHaveBeenCalled();
  });

  it('401s without a session, without reading anything', async () => {
    resolveSessionMock.mockResolvedValue(null);

    const response = await GET(statusRequest(), paramsFor(INTENT_ID));

    expect(response.status).toBe(401);
    expect(loadIntentStatusForWalletMock).not.toHaveBeenCalled();
  });

  it('400s a malformed intent id, without reading anything', async () => {
    const response = await GET(statusRequest(), paramsFor('not-a-uuid'));

    expect(response.status).toBe(400);
    expect(loadIntentStatusForWalletMock).not.toHaveBeenCalled();
  });

  it("404s an intent the session wallet does not own — indistinguishable from one that does not exist", async () => {
    loadIntentStatusForWalletMock.mockResolvedValue(null);

    const response = await GET(statusRequest(), paramsFor(INTENT_ID));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'intent_not_found' });
  });

  it('degrades to 503 when the read throws, since a stale status can approve nothing', async () => {
    loadIntentStatusForWalletMock.mockRejectedValue(new Error('db down'));

    const response = await GET(statusRequest(), paramsFor(INTENT_ID));

    expect(response.status).toBe(503);
    expect(captureErrorMock).toHaveBeenCalled();
  });

  // BLOCKING 1: the stranded-intent sweep is otherwise unreachable from `/trade` — this route
  // must drive it itself once a submitted/signed intent it reads back is past its own
  // blockhash grace period.
  describe('stale-intent resolution', () => {
    it('attempts resolution and re-reads status once a submitted intent is stranded', async () => {
      isStrandedSubmittedIntentMock.mockReturnValue(true);
      loadIntentStatusForWalletMock
        .mockResolvedValueOnce({ status: 'submitted', signature: 'sig-1', expiresAt: new Date(Date.now() - 5 * 60_000) })
        .mockResolvedValueOnce({ status: 'confirmed', signature: 'sig-1', expiresAt: new Date(Date.now() - 5 * 60_000) });

      const response = await GET(statusRequest(), paramsFor(INTENT_ID));

      expect(reconcileWalletMock).toHaveBeenCalledWith(expect.any(String));
      expect(loadIntentStatusForWalletMock).toHaveBeenCalledTimes(2);
      await expect(response.json()).resolves.toMatchObject({ status: 'confirmed', signature: 'sig-1' });
    });

    it('also resolves a stranded signed intent, not only submitted', async () => {
      isStrandedSubmittedIntentMock.mockReturnValue(true);
      loadIntentStatusForWalletMock
        .mockResolvedValueOnce({ status: 'signed', signature: null, expiresAt: new Date(Date.now() - 5 * 60_000) })
        .mockResolvedValueOnce({ status: 'failed', signature: null, expiresAt: new Date(Date.now() - 5 * 60_000) });

      const response = await GET(statusRequest(), paramsFor(INTENT_ID));

      expect(reconcileWalletMock).toHaveBeenCalled();
      await expect(response.json()).resolves.toMatchObject({ status: 'failed' });
    });

    it('does not attempt resolution for a submitted intent still within its blockhash grace period', async () => {
      isStrandedSubmittedIntentMock.mockReturnValue(false);

      await GET(statusRequest(), paramsFor(INTENT_ID));

      expect(reconcileWalletMock).not.toHaveBeenCalled();
      expect(loadIntentStatusForWalletMock).toHaveBeenCalledTimes(1);
    });

    it('does not attempt resolution for an intent already in a terminal status', async () => {
      loadIntentStatusForWalletMock.mockResolvedValue({ status: 'confirmed', signature: 'sig-1', expiresAt: new Date(Date.now() - 5 * 60_000) });
      isStrandedSubmittedIntentMock.mockReturnValue(true); // contrived — proves the status gate runs first

      await GET(statusRequest(), paramsFor(INTENT_ID));

      expect(reconcileWalletMock).not.toHaveBeenCalled();
    });

    it('skips the resolution attempt when the reconcile kill switch is off, still returning the stale status', async () => {
      isFeatureEnabledMock.mockImplementation((flag: string) => Promise.resolve(flag === 'trade.terminal'));
      isStrandedSubmittedIntentMock.mockReturnValue(true);
      loadIntentStatusForWalletMock.mockResolvedValue({ status: 'submitted', signature: 'sig-1', expiresAt: new Date(Date.now() - 5 * 60_000) });

      const response = await GET(statusRequest(), paramsFor(INTENT_ID));

      expect(reconcileWalletMock).not.toHaveBeenCalled();
      await expect(response.json()).resolves.toMatchObject({ status: 'submitted' });
    });

    it('skips the resolution attempt once this wallet has hit the poll-resolve rate limit', async () => {
      isStrandedSubmittedIntentMock.mockReturnValue(true);
      loadIntentStatusForWalletMock.mockResolvedValue({ status: 'submitted', signature: 'sig-1', expiresAt: new Date(Date.now() - 5 * 60_000) });
      assertRateLimitMock.mockRejectedValueOnce(new ConstitutionActionRateLimited());

      const response = await GET(statusRequest(), paramsFor(INTENT_ID));

      expect(reconcileWalletMock).not.toHaveBeenCalled();
      expect(recordEventMock).not.toHaveBeenCalled();
      await expect(response.json()).resolves.toMatchObject({ status: 'submitted' });
    });

    it('degrades to the pre-attempt status when reconcileWallet itself throws, without breaking the poll', async () => {
      isStrandedSubmittedIntentMock.mockReturnValue(true);
      loadIntentStatusForWalletMock.mockResolvedValue({ status: 'submitted', signature: 'sig-1', expiresAt: new Date(Date.now() - 5 * 60_000) });
      reconcileWalletMock.mockRejectedValueOnce(new Error('helius unavailable'));

      const response = await GET(statusRequest(), paramsFor(INTENT_ID));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ status: 'submitted' });
      expect(captureErrorMock).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ operation: 'swap.intent_status.resolve' }));
    });

    it('propagates this request\'s own correlationId into the resolution attempt, never minting a second one', async () => {
      isStrandedSubmittedIntentMock.mockReturnValue(true);
      loadIntentStatusForWalletMock.mockResolvedValue({ status: 'submitted', signature: 'sig-1', expiresAt: new Date(Date.now() - 5 * 60_000) });

      const response = await GET(statusRequest(), paramsFor(INTENT_ID));
      const { correlationId } = (await response.json()) as { correlationId: string };

      expect(reconcileWalletMock).toHaveBeenCalledWith(correlationId);
      expect(assertRateLimitMock).toHaveBeenCalledWith(SESSION.userId, expect.any(String), correlationId, expect.any(Date));
      expect(recordEventMock).toHaveBeenCalledWith(expect.objectContaining({ correlationId, userId: SESSION.userId }));
    });
  });
});
