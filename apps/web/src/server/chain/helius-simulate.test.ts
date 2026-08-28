import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getMultipleAccounts, HeliusRpcError, simulateTransaction } from './helius-simulate';

/**
 * The read-side Helius JSON-RPC wrapper `assemble-transaction.ts` and `broadcast-transaction.ts`
 * both build on: fail-closed on every path (flag off, missing key, timeout, non-200, RPC-level
 * error), and — finding 3's fix — carries the caller's correlation id onto whatever it captures,
 * so the id it was handed does not stop at this integration boundary.
 */

const { isFeatureEnabledMock, captureErrorMock } = vi.hoisted(() => ({
  isFeatureEnabledMock: vi.fn(),
  captureErrorMock: vi.fn(),
}));

vi.mock('../flags/feature-flags', () => ({ isFeatureEnabled: isFeatureEnabledMock }));
vi.mock('./helius-client', () => ({ CHAIN_HELIUS_FLAG: 'chain.helius' }));
vi.mock('../../observability/error-tracking', () => ({ captureError: captureErrorMock }));

const SIGNED_TX = 'AQABAgMEBQY=';
const ORIGINAL_KEY = process.env.HELIUS_API_KEY;

let fetchMock: ReturnType<typeof vi.fn>;

function rpcResponds(body: unknown, ok = true, status = 200): void {
  fetchMock.mockResolvedValue({ ok, status, json: async () => body } as unknown as Response);
}

beforeEach(() => {
  vi.clearAllMocks();
  isFeatureEnabledMock.mockResolvedValue(true);
  process.env.HELIUS_API_KEY = 'test-key';
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  process.env.HELIUS_API_KEY = ORIGINAL_KEY;
  vi.unstubAllGlobals();
});

describe('simulateTransaction', () => {
  it('throws when chain.helius is disabled, before ever calling fetch', async () => {
    isFeatureEnabledMock.mockResolvedValue(false);

    await expect(simulateTransaction(SIGNED_TX)).rejects.toBeInstanceOf(HeliusRpcError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws rather than calling unauthenticated when no API key is configured', async () => {
    delete process.env.HELIUS_API_KEY;

    await expect(simulateTransaction(SIGNED_TX)).rejects.toThrow(/HELIUS_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the simulation result, replacing the blockhash by default', async () => {
    rpcResponds({ result: { value: { err: null, unitsConsumed: 120_000, logs: ['ok'] } } });

    const result = await simulateTransaction(SIGNED_TX);

    expect(result).toEqual({ err: null, unitsConsumed: 120_000, logs: ['ok'] });
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as { params: [string, Record<string, unknown>] };
    expect(body.params[1]).toMatchObject({ replaceRecentBlockhash: true, sigVerify: false });
  });

  it('honors replaceRecentBlockhash: false — verifying what was actually signed', async () => {
    rpcResponds({ result: { value: { err: null, unitsConsumed: 1, logs: null } } });

    await simulateTransaction(SIGNED_TX, { replaceRecentBlockhash: false });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as { params: [string, Record<string, unknown>] };
    expect(body.params[1]).toMatchObject({ replaceRecentBlockhash: false });
  });

  it('throws on an RPC-level error rather than returning a partial result', async () => {
    rpcResponds({ error: { code: -1, message: 'boom' } });

    await expect(simulateTransaction(SIGNED_TX)).rejects.toThrow(/boom/);
  });

  it('throws on a non-200', async () => {
    rpcResponds({}, false, 503);

    await expect(simulateTransaction(SIGNED_TX)).rejects.toBeInstanceOf(HeliusRpcError);
  });

  it('carries the caller’s correlation id onto a captured failure — finding 3', async () => {
    rpcResponds({}, false, 503);

    await expect(simulateTransaction(SIGNED_TX, undefined, 'correlation-1')).rejects.toBeInstanceOf(HeliusRpcError);
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ correlationId: 'correlation-1', method: 'simulateTransaction' }),
    );
  });
});

describe('getMultipleAccounts', () => {
  it('returns accounts in request order, including null for a missing one', async () => {
    rpcResponds({ result: { value: [{ data: ['AA==', 'base64'], owner: 'Prog1111111111111111111111111111111111111' }, null] } });

    const result = await getMultipleAccounts(['addr-1', 'addr-2']);

    expect(result).toEqual([{ data: ['AA==', 'base64'], owner: 'Prog1111111111111111111111111111111111111' }, null]);
  });

  it('throws on a non-200 rather than treating a missing account as a hard truth', async () => {
    rpcResponds({}, false, 500);

    await expect(getMultipleAccounts(['addr-1'])).rejects.toBeInstanceOf(HeliusRpcError);
  });

  it('carries the caller’s correlation id onto a captured failure — finding 3', async () => {
    rpcResponds({}, false, 500);

    await expect(getMultipleAccounts(['addr-1'], 'correlation-2')).rejects.toBeInstanceOf(HeliusRpcError);
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ correlationId: 'correlation-2', method: 'getMultipleAccounts' }),
    );
  });
});
