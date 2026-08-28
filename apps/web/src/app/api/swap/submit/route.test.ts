import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SubmitRejectedError } from '@/server/swap/submit-service';

import { POST } from './route';

/**
 * Route-level wiring only, invoked directly the way `api/swap/quote/route.test.ts` does: the
 * gate, the validation, and the mapping from `submit-service`'s outcomes onto status codes.
 * Every verification decision is `submit-service.test.ts`'s subject.
 */

const { isFeatureEnabledMock, resolveSessionMock, submitSignedSwapMock, captureErrorMock } = vi.hoisted(() => ({
  isFeatureEnabledMock: vi.fn(),
  resolveSessionMock: vi.fn(),
  submitSignedSwapMock: vi.fn(),
  captureErrorMock: vi.fn(),
}));

vi.mock('@/server/flags/feature-flags', () => ({ isFeatureEnabled: isFeatureEnabledMock, TRADE_TERMINAL_FLAG: 'trade.terminal' }));
vi.mock('@/server/auth/session', () => ({ resolveSession: resolveSessionMock }));
vi.mock('@/observability/error-tracking', () => ({ captureError: captureErrorMock }));
vi.mock('@/server/swap/submit-service', () => {
  class SubmitRejectedErrorStub extends Error {
    constructor(readonly reason: string) {
      super(reason);
    }
  }

  return { submitSignedSwap: submitSignedSwapMock, SubmitRejectedError: SubmitRejectedErrorStub };
});

const INTENT_ID = '11111111-2222-3333-4444-555555555555';
const SIGNED_TX = 'AQABAgMEBQYHCAkK';

const SESSION = { walletId: 'wallet-1', walletAddress: 'BPFLoaderUpgradeab1e11111111111111111111111', userId: 'user-1' };

const DRY_RUN_RESULT = { intentId: INTENT_ID, status: 'submitted', signature: '5j7s6NiJS3JAkvgkoc18WVAsiSaci2p', dryRun: true, replayed: false };

const VALID_BODY = { intentId: INTENT_ID, signedTransaction: SIGNED_TX };

function submitRequest(body: unknown): Request {
  return new Request('http://localhost/api/swap/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  isFeatureEnabledMock.mockResolvedValue(true);
  resolveSessionMock.mockResolvedValue(SESSION);
  submitSignedSwapMock.mockResolvedValue(DRY_RUN_RESULT);
});

describe('POST /api/swap/submit', () => {
  it('503s and never submits when trade.terminal is off', async () => {
    isFeatureEnabledMock.mockResolvedValue(false);

    const response = await POST(submitRequest(VALID_BODY));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: 'trade_terminal_disabled' });
    expect(submitSignedSwapMock).not.toHaveBeenCalled();
  });

  it('401s without a session, never trusting a body-supplied wallet', async () => {
    resolveSessionMock.mockResolvedValue(null);

    const response = await POST(submitRequest({ ...VALID_BODY, walletId: 'someone-else' }));

    expect(response.status).toBe(401);
    expect(submitSignedSwapMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-uuid intent id', { ...VALID_BODY, intentId: 'not-a-uuid' }],
    ['a missing intent id', { signedTransaction: SIGNED_TX }],
    ['a non-string signed transaction', { ...VALID_BODY, signedTransaction: 42 }],
    ['an empty signed transaction', { ...VALID_BODY, signedTransaction: '' }],
    ['a non-base64 signed transaction', { ...VALID_BODY, signedTransaction: 'not base64!!' }],
    ['a signed transaction far larger than a Solana packet', { ...VALID_BODY, signedTransaction: 'A'.repeat(5_000) }],
  ])('400s on %s', async (_label, body) => {
    const response = await POST(submitRequest(body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_request' });
    expect(submitSignedSwapMock).not.toHaveBeenCalled();
  });

  it('400s on a body that is not JSON at all', async () => {
    const response = await POST(
      new Request('http://localhost/api/swap/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' }),
    );

    expect(response.status).toBe(400);
  });

  it('403s — not merely a client-side block — when the intent belongs to another wallet', async () => {
    submitSignedSwapMock.mockRejectedValue(new SubmitRejectedError('wallet_mismatch' as never));

    const response = await POST(submitRequest(VALID_BODY));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: 'wallet_mismatch' });
  });

  it.each(['intent_expired', 'message_hash_mismatch', 'fee_payer_mismatch', 'rules_now_block', 'intent_not_signable'])(
    '409s on %s',
    async (reason) => {
      submitSignedSwapMock.mockRejectedValue(new SubmitRejectedError(reason as never));

      const response = await POST(submitRequest(VALID_BODY));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: reason });
      expect(captureErrorMock).not.toHaveBeenCalled();
    },
  );

  it('returns the dry-run result and a correlation id on the happy path', async () => {
    const response = await POST(submitRequest(VALID_BODY));
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ intentId: INTENT_ID, status: 'submitted', dryRun: true, replayed: false });
    expect(typeof body.correlationId).toBe('string');
  });

  it('passes the session wallet, never anything from the body', async () => {
    await POST(submitRequest({ ...VALID_BODY, walletId: 'attacker-wallet', walletAddress: 'attacker-address', userId: 'attacker-user' }));

    expect(submitSignedSwapMock).toHaveBeenCalledWith(
      expect.objectContaining({ walletId: SESSION.walletId, walletAddress: SESSION.walletAddress, userId: SESSION.userId }),
    );
  });

  it('fails closed with a 503 when verification itself is unavailable', async () => {
    submitSignedSwapMock.mockRejectedValue(new Error('database unreachable'));

    const response = await POST(submitRequest(VALID_BODY));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: 'submit_unavailable' });
    expect(captureErrorMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ failedClosed: true }));
  });
});
