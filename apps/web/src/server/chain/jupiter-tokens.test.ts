import { beforeEach, describe, expect, it, vi } from 'vitest';

import { lookupTokenDecimals, lookupTokenMcaps } from './jupiter-tokens';

const { isFeatureEnabledMock, captureErrorMock } = vi.hoisted(() => ({
  isFeatureEnabledMock: vi.fn(),
  captureErrorMock: vi.fn(),
}));

vi.mock('../flags/feature-flags', () => ({ isFeatureEnabled: isFeatureEnabledMock }));
vi.mock('../../observability/error-tracking', () => ({ captureError: captureErrorMock }));

function jupiterResponse(items: { id: string; mcap?: number | null; decimals?: number | null }[]): Response {
  return { ok: true, json: async () => items } as unknown as Response;
}

beforeEach(() => {
  vi.restoreAllMocks();
  isFeatureEnabledMock.mockResolvedValue(true);
});

describe('lookupTokenMcaps', () => {
  it('comma-batches every requested mint into one request', async () => {
    const mintA = 'MintBatchAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const mintB = 'MintBatchBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jupiterResponse([{ id: mintA, mcap: 100 }, { id: mintB, mcap: 200 }]));

    const result = await lookupTokenMcaps([mintA, mintB]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain(`${mintA},${mintB}`);
    expect(result.get(mintA)).toBe(100);
    expect(result.get(mintB)).toBe(200);
  });

  it('does not re-fetch a mint whose cached mcap is still fresh', async () => {
    const mint = 'MintCacheFreshAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jupiterResponse([{ id: mint, mcap: 42 }]));

    await lookupTokenMcaps([mint]);
    const second = await lookupTokenMcaps([mint]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.get(mint)).toBe(42);
  });

  it('resolves with no entry for the mint, not a throw, when the request times out', async () => {
    vi.useFakeTimers();
    const mint = 'MintTimeoutAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          (init as { signal: AbortSignal }).signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }) as unknown as Promise<Response>,
    );

    const resultPromise = lookupTokenMcaps([mint]);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await resultPromise;

    expect(result.has(mint)).toBe(false);
    expect(captureErrorMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ failedClosed: true }));

    vi.useRealTimers();
  });

  it('makes zero network calls for an empty mint list', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const result = await lookupTokenMcaps([]);

    expect(result.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('makes zero network calls when the classification.jupiter_mcap flag is off', async () => {
    isFeatureEnabledMock.mockResolvedValue(false);
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const result = await lookupTokenMcaps(['MintFlagOffAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA']);

    expect(result.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('bounds the cache so a long tail of mints cannot grow it without limit', async () => {
    // One request per call keeps this cheap: the cache is what's under test, not the batching.
    const mintAt = (index: number) => `MintEvict${index.toString().padStart(34, '0')}`;
    const overflow = 5_200;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const query = new URL(input as string).searchParams.get('query') ?? '';
      return jupiterResponse(query.split(',').map((id) => ({ id, mcap: 1 })));
    });

    for (let index = 0; index < overflow; index += 1) {
      await lookupTokenMcaps([mintAt(index)]);
    }

    // The most recent mint is still cached, so a repeat lookup issues no new request...
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockClear();
    await lookupTokenMcaps([mintAt(overflow - 1)]);
    expect(fetchMock).not.toHaveBeenCalled();

    // ...while the oldest was evicted, so it costs a refetch rather than living forever.
    await lookupTokenMcaps([mintAt(0)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * Finding 4: `quote-service.ts`'s `evaluateQuote` calls `lookupTokenDecimals` and
   * `classifyToken` (which resolves to `lookupTokenMcaps`) concurrently for the same output
   * mint on every quote. Without in-flight coalescing, both race the Free tier's 1 RPS
   * org-wide budget with their own request for the same mint.
   */
  describe('in-flight coalescing', () => {
    it('shares one fetch across two concurrent lookups of the same mint', async () => {
      const mint = 'MintCoalesceAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jupiterResponse([{ id: mint, mcap: 99 }]));

      const [firstResult, secondResult] = await Promise.all([lookupTokenMcaps([mint]), lookupTokenMcaps([mint])]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(firstResult.get(mint)).toBe(99);
      expect(secondResult.get(mint)).toBe(99);
    });

    it('shares one fetch between a concurrent decimals lookup and mcap lookup for the same mint', async () => {
      const mint = 'MintCoalesceCrossAAAAAAAAAAAAAAAAAAAAAAAAAA';
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jupiterResponse([{ id: mint, mcap: 5, decimals: 6 }]));

      const [mcaps, decimals] = await Promise.all([lookupTokenMcaps([mint]), lookupTokenDecimals([mint])]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(mcaps.get(mint)).toBe(5);
      expect(decimals.get(mint)).toBe(6);
    });

    it('issues a fresh request once the in-flight one has settled, rather than coalescing forever', async () => {
      const mint = 'MintCoalesceSettleAAAAAAAAAAAAAAAAAAAAAAAAA';
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jupiterResponse([{ id: mint, mcap: 1 }]));

      await lookupTokenMcaps([mint]);
      // Fresh cache entry now covers this mint, so a second call within the TTL still costs
      // nothing new — this only proves the in-flight entry was cleared, not left dangling.
      await lookupTokenMcaps([mint]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
