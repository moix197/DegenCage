import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '../../observability/logger';
import { broadcastSignedTransaction, BroadcastError, CHAIN_BROADCAST_FLAG } from './broadcast-transaction';

/**
 * The kill switch that decides whether money can move, tested from the outside: one call site,
 * two behaviours, and nothing about the *caller* changing between them. Phase 6 flips a flag
 * row — if these two paths ever diverge in shape, that flip stops being a config change and
 * becomes a code change nobody has exercised.
 */

const { isFeatureEnabledMock, simulateTransactionMock, captureErrorMock } = vi.hoisted(() => ({
  isFeatureEnabledMock: vi.fn(),
  simulateTransactionMock: vi.fn(),
  captureErrorMock: vi.fn(),
}));

vi.mock('../flags/feature-flags', () => ({ isFeatureEnabled: isFeatureEnabledMock }));
vi.mock('./helius-simulate', () => ({ simulateTransaction: simulateTransactionMock }));
vi.mock('./helius-client', () => ({ CHAIN_HELIUS_FLAG: 'chain.helius' }));
vi.mock('../../observability/error-tracking', () => ({ captureError: captureErrorMock }));
vi.mock('../../observability/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

const SIGNED_TX = 'AQABAgMEBQY=';
const SIGNATURE = '5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia7';

/** Every flag on except the one a case turns off — the same shape `isFeatureEnabled` has in production. */
function flagsOffFor(...disabled: string[]): void {
  isFeatureEnabledMock.mockImplementation(async (key: string) => !disabled.includes(key));
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.HELIUS_API_KEY = 'test-key';
  flagsOffFor();
  simulateTransactionMock.mockResolvedValue({ err: null, unitsConsumed: 120_000, logs: ['Program log: ok'] });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function rpcResponds(body: unknown, ok = true, status = 200): void {
  fetchMock.mockResolvedValue({ ok, status, json: async () => body } as unknown as Response);
}

describe('broadcastSignedTransaction with chain.broadcast off', () => {
  beforeEach(() => {
    flagsOffFor(CHAIN_BROADCAST_FLAG);
  });

  it('simulates the signed bytes and never sends them', async () => {
    const result = await broadcastSignedTransaction(SIGNED_TX);

    expect(result).toEqual({ dryRun: true, networkSignature: null, logs: ['Program log: ok'] });
    expect(simulateTransactionMock).toHaveBeenCalledWith(SIGNED_TX, { replaceRecentBlockhash: false }, undefined);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the transaction’s own blockhash rather than replacing it — the point is to verify what was signed', async () => {
    await broadcastSignedTransaction(SIGNED_TX);

    expect(simulateTransactionMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ replaceRecentBlockhash: false }), undefined);
  });

  it('treats a simulation error as a failure, never a warning', async () => {
    simulateTransactionMock.mockResolvedValue({ err: { InstructionError: [3, 'Custom'] }, unitsConsumed: null, logs: null });

    await expect(broadcastSignedTransaction(SIGNED_TX)).rejects.toBeInstanceOf(BroadcastError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates a simulation that could not run at all', async () => {
    simulateTransactionMock.mockRejectedValue(new Error('chain.helius is disabled'));

    await expect(broadcastSignedTransaction(SIGNED_TX)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('threads the caller’s correlation id into the simulate call and the disabled-broadcast log line — finding 3', async () => {
    await broadcastSignedTransaction(SIGNED_TX, 'correlation-1');

    expect(simulateTransactionMock).toHaveBeenCalledWith(SIGNED_TX, { replaceRecentBlockhash: false }, 'correlation-1');
    expect(logger.info).toHaveBeenCalledWith(
      'broadcast disabled — simulating signed transaction instead',
      expect.objectContaining({ correlationId: 'correlation-1' }),
    );
  });
});

describe('broadcastSignedTransaction with chain.broadcast on', () => {
  it('sends the bytes and reports the signature the network acknowledged', async () => {
    rpcResponds({ jsonrpc: '2.0', id: 1, result: SIGNATURE });

    const result = await broadcastSignedTransaction(SIGNED_TX);

    expect(result).toEqual({ dryRun: false, networkSignature: SIGNATURE, logs: null });
    expect(simulateTransactionMock).not.toHaveBeenCalled();

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as { method: string; params: [string, Record<string, unknown>] };
    expect(body.method).toBe('sendTransaction');
    expect(body.params[0]).toBe(SIGNED_TX);
    // No RPC-side rebroadcasting: an unbounded retry against an external API is exactly what
    // CLAUDE.md forbids, and a resend we did not ask for is one the audit trail cannot explain.
    expect(body.params[1]).toMatchObject({ encoding: 'base64', skipPreflight: false, maxRetries: 0 });
  });

  it('refuses to send when the Helius integration itself is killed', async () => {
    flagsOffFor('chain.helius');

    await expect(broadcastSignedTransaction(SIGNED_TX)).rejects.toBeInstanceOf(BroadcastError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on a non-200 rather than reporting a send that did not happen', async () => {
    rpcResponds({}, false, 503);

    await expect(broadcastSignedTransaction(SIGNED_TX)).rejects.toBeInstanceOf(BroadcastError);
    expect(captureErrorMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ failedClosed: true }));
  });

  it('threads the caller’s correlation id onto the sent-transaction log line and a captured send failure — finding 3', async () => {
    rpcResponds({ jsonrpc: '2.0', id: 1, result: SIGNATURE });

    await broadcastSignedTransaction(SIGNED_TX, 'correlation-2');

    expect(logger.info).toHaveBeenCalledWith('signed transaction broadcast', expect.objectContaining({ correlationId: 'correlation-2' }));

    rpcResponds({}, false, 503);

    await expect(broadcastSignedTransaction(SIGNED_TX, 'correlation-3')).rejects.toBeInstanceOf(BroadcastError);
    expect(captureErrorMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ correlationId: 'correlation-3' }));
  });

  it('throws on an RPC-level error body', async () => {
    rpcResponds({ jsonrpc: '2.0', id: 1, error: { code: -32003, message: 'Transaction signature verification failure' } });

    await expect(broadcastSignedTransaction(SIGNED_TX)).rejects.toThrow(/signature verification/);
  });

  it('throws when the RPC returns no signature', async () => {
    rpcResponds({ jsonrpc: '2.0', id: 1 });

    await expect(broadcastSignedTransaction(SIGNED_TX)).rejects.toBeInstanceOf(BroadcastError);
  });

  it('throws rather than sending unauthenticated when the API key is missing', async () => {
    delete process.env.HELIUS_API_KEY;

    await expect(broadcastSignedTransaction(SIGNED_TX)).rejects.toBeInstanceOf(BroadcastError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
