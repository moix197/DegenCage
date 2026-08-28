import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from './route';

/**
 * Route-level wiring only, invoked directly the way `api/swap/submit/route.test.ts` does: the
 * gate, the id validation, and the wallet-scoping that makes a foreign intent indistinguishable
 * from a missing one.
 */

const { isFeatureEnabledMock, resolveSessionMock, loadIntentStatusForWalletMock, captureErrorMock } = vi.hoisted(() => ({
  isFeatureEnabledMock: vi.fn(),
  resolveSessionMock: vi.fn(),
  loadIntentStatusForWalletMock: vi.fn(),
  captureErrorMock: vi.fn(),
}));

vi.mock('@/server/flags/feature-flags', () => ({ isFeatureEnabled: isFeatureEnabledMock, TRADE_TERMINAL_FLAG: 'trade.terminal' }));
vi.mock('@/server/auth/session', () => ({ resolveSession: resolveSessionMock }));
vi.mock('@/observability/error-tracking', () => ({ captureError: captureErrorMock }));
vi.mock('@/server/swap/intent-lifecycle', () => ({ loadIntentStatusForWallet: loadIntentStatusForWalletMock }));

const INTENT_ID = '11111111-2222-3333-4444-555555555555';
const SESSION = { walletId: 'wallet-1', walletAddress: 'BPFLoaderUpgradeab1e11111111111111111111111', userId: 'user-1' };

function statusRequest(): Request {
  return new Request(`http://localhost/api/swap/intent/${INTENT_ID}`);
}

function paramsFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe('GET /api/swap/intent/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isFeatureEnabledMock.mockResolvedValue(true);
    resolveSessionMock.mockResolvedValue(SESSION);
    loadIntentStatusForWalletMock.mockResolvedValue({ status: 'submitted', signature: 'sig-1' });
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
});
