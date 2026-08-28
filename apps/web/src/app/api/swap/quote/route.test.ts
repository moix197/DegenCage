import { beforeEach, describe, expect, it, vi } from 'vitest';

import { QuotePreconditionError } from '@/server/swap/quote-service';

import { POST } from './route';

/**
 * Route-level wiring only, invoked directly the way `api/admin/login/route.test.ts` does:
 * the gates, the validation, and the mapping from `quote-service`'s outcomes onto status
 * codes. The decisions themselves are `quote-service.test.ts`'s subject, so `createQuote` is
 * mocked here rather than exercised.
 */

const { isFeatureEnabledMock, resolveSessionMock, createQuoteMock, captureErrorMock } = vi.hoisted(() => ({
  isFeatureEnabledMock: vi.fn(),
  resolveSessionMock: vi.fn(),
  createQuoteMock: vi.fn(),
  captureErrorMock: vi.fn(),
}));

vi.mock('@/server/flags/feature-flags', () => ({ isFeatureEnabled: isFeatureEnabledMock, TRADE_TERMINAL_FLAG: 'trade.terminal' }));
vi.mock('@/server/auth/session', () => ({ resolveSession: resolveSessionMock }));
vi.mock('@/server/swap/jupiter-client', () => ({ JUPITER_SWAP_BUILD_FLAG: 'jupiter.swap_build' }));
vi.mock('@/observability/error-tracking', () => ({ captureError: captureErrorMock }));
vi.mock('@/server/swap/quote-service', async () => {
  class QuotePreconditionErrorStub extends Error {
    constructor(readonly reason: string) {
      super(reason);
    }
  }

  return { createQuote: createQuoteMock, QuotePreconditionError: QuotePreconditionErrorStub };
});

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 'So11111111111111111111111111111111111111112';

const SESSION = {
  walletId: 'wallet-1',
  walletAddress: 'BPFLoaderUpgradeab1e11111111111111111111111',
  userId: 'user-1',
};

const QUOTE_RESULT = {
  intentId: 'intent-1',
  verdict: 'allow',
  evaluations: [],
  expiresAt: '2026-08-27T00:00:00.000Z',
  quote: { inputMint: SOL, outputMint: USDC },
  transaction: { messageBase64: 'bWVzc2FnZQ==', txMessageHash: 'a'.repeat(64) },
};

function quoteRequest(body: unknown): Request {
  return new Request('http://localhost/api/swap/quote', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = { inputMint: SOL, outputMint: USDC, amount: '100000000' };

beforeEach(() => {
  vi.clearAllMocks();
  isFeatureEnabledMock.mockResolvedValue(true);
  resolveSessionMock.mockResolvedValue(SESSION);
  createQuoteMock.mockResolvedValue(QUOTE_RESULT);
});

describe('POST /api/swap/quote', () => {
  it.each(['trade.terminal', 'jupiter.swap_build'])('503s and never quotes when %s is off', async (offFlag) => {
    isFeatureEnabledMock.mockImplementation(async (key: string) => key !== offFlag);

    const response = await POST(quoteRequest(VALID_BODY));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: 'trade_terminal_disabled' });
    expect(createQuoteMock).not.toHaveBeenCalled();
  });

  it('401s without a session, never trusting a body-supplied wallet', async () => {
    resolveSessionMock.mockResolvedValue(null);

    const response = await POST(quoteRequest({ ...VALID_BODY, walletId: 'someone-else' }));

    expect(response.status).toBe(401);
    expect(createQuoteMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-base58 input mint', { ...VALID_BODY, inputMint: 'not-a-mint' }],
    ['a non-base58 output mint', { ...VALID_BODY, outputMint: '0OIl' }],
    ['the same mint on both sides', { ...VALID_BODY, outputMint: SOL }],
    ['a zero amount', { ...VALID_BODY, amount: '0' }],
    ['a fractional amount', { ...VALID_BODY, amount: '1.5' }],
    ['a numeric amount', { ...VALID_BODY, amount: 100 }],
    ['a negative slippage', { ...VALID_BODY, slippageBps: -1 }],
    ['an absurd slippage', { ...VALID_BODY, slippageBps: 10_000 }],
  ])('400s on %s', async (_label, body) => {
    const response = await POST(quoteRequest(body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_request' });
    expect(createQuoteMock).not.toHaveBeenCalled();
  });

  it('400s on a body that is not JSON at all', async () => {
    const response = await POST(
      new Request('http://localhost/api/swap/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' }),
    );

    expect(response.status).toBe(400);
  });

  it.each(['constitution_not_active', 'not_reconciled'])('409s with %s, the same shape the dashboard uses', async (reason) => {
    createQuoteMock.mockRejectedValue(new QuotePreconditionError(reason as never));

    const response = await POST(quoteRequest(VALID_BODY));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: reason });
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  it('returns the quote, the verdict and a correlation id on the happy path', async () => {
    const response = await POST(quoteRequest(VALID_BODY));
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ intentId: 'intent-1', verdict: 'allow', expiresAt: QUOTE_RESULT.expiresAt });
    expect(typeof body.correlationId).toBe('string');
  });

  it('passes the session wallet, never anything from the body', async () => {
    await POST(quoteRequest({ ...VALID_BODY, walletId: 'attacker-wallet', userId: 'attacker-user' }));

    expect(createQuoteMock).toHaveBeenCalledWith(
      expect.objectContaining({ walletId: SESSION.walletId, walletAddress: SESSION.walletAddress, userId: SESSION.userId }),
    );
  });

  it('defaults slippage rather than leaving it undefined', async () => {
    await POST(quoteRequest(VALID_BODY));

    expect(createQuoteMock).toHaveBeenCalledWith(expect.objectContaining({ slippageBps: 50 }));
  });

  it('fails closed with a 503 when a dependency throws — never a degraded "allowed"', async () => {
    createQuoteMock.mockRejectedValue(new Error('helius simulate failed'));

    const response = await POST(quoteRequest(VALID_BODY));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: 'quote_unavailable' });
    expect(captureErrorMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ failedClosed: true }));
  });
});
