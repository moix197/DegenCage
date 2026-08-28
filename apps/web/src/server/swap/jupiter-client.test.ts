import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildSwap, JupiterBuildError } from './jupiter-client';

/**
 * This client sits pre-trade, so the only behaviour worth asserting is that it never resolves
 * permissively: a disabled flag, a missing key, a timeout, and a non-200 must each throw, and
 * the documented `400 { error }` body must reach the caller rather than being flattened into
 * a status code.
 */

const { isFeatureEnabledMock, captureErrorMock } = vi.hoisted(() => ({
  isFeatureEnabledMock: vi.fn(),
  captureErrorMock: vi.fn(),
}));

vi.mock('../flags/feature-flags', () => ({ isFeatureEnabled: isFeatureEnabledMock }));
vi.mock('../../observability/error-tracking', () => ({ captureError: captureErrorMock }));

const PARAMS = {
  inputMint: 'So11111111111111111111111111111111111111112',
  outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  amount: '100000000',
  taker: 'TakerAddressAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  slippageBps: 50,
};

const ORIGINAL_KEY = process.env.JUPITER_API_KEY;

beforeEach(() => {
  vi.restoreAllMocks();
  isFeatureEnabledMock.mockResolvedValue(true);
  process.env.JUPITER_API_KEY = 'test-key';
});

afterEach(() => {
  process.env.JUPITER_API_KEY = ORIGINAL_KEY;
});

describe('buildSwap', () => {
  it('throws and makes zero network calls when jupiter.swap_build is off', async () => {
    isFeatureEnabledMock.mockResolvedValue(false);
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(buildSwap(PARAMS)).rejects.toBeInstanceOf(JupiterBuildError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when no API key is configured, rather than calling unauthenticated', async () => {
    delete process.env.JUPITER_API_KEY;
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(buildSwap(PARAMS)).rejects.toThrow(/JUPITER_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the api key, the taker and no platform fee params', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ inAmount: '1' }) } as unknown as Response);

    await buildSwap(PARAMS);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('https://api.jup.ag/swap/v2/build?');
    expect(url).toContain(`taker=${PARAMS.taker}`);
    expect(url).not.toContain('platformFeeBps');
    expect(url).not.toContain('feeAccount');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('test-key');
  });

  it('throws, never resolves, when the request times out', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          (init as { signal: AbortSignal }).signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }) as unknown as Promise<Response>,
    );

    const pending = buildSwap(PARAMS);
    const assertion = expect(pending).rejects.toBeInstanceOf(JupiterBuildError);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;

    expect(captureErrorMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ failedClosed: true }));
    vi.useRealTimers();
  });

  it('surfaces the documented 400 { error } body in the thrown error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: 'No routes found' }),
    } as unknown as Response);

    await expect(buildSwap(PARAMS)).rejects.toThrow(/No routes found/);
  });

  it('throws on a non-200 whose body is not the documented shape', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 429, text: async () => 'Too Many Requests' } as unknown as Response);

    await expect(buildSwap(PARAMS)).rejects.toThrow(/429/);
    expect(captureErrorMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ failedClosed: true }));
  });

  it('does not retry a failed request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 500, text: async () => '' } as unknown as Response);

    await expect(buildSwap(PARAMS)).rejects.toBeInstanceOf(JupiterBuildError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('carries the caller’s correlation id onto a captured failure — finding 3', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 500, text: async () => '' } as unknown as Response);

    await expect(buildSwap(PARAMS, 'correlation-1')).rejects.toBeInstanceOf(JupiterBuildError);
    expect(captureErrorMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ correlationId: 'correlation-1' }));
  });
});
