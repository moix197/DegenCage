import { beforeEach, describe, expect, it, vi } from 'vitest';

import { lookupTokenMcaps } from './jupiter-tokens';

const { isFeatureEnabledMock, captureErrorMock } = vi.hoisted(() => ({
  isFeatureEnabledMock: vi.fn(),
  captureErrorMock: vi.fn(),
}));

vi.mock('../flags/feature-flags', () => ({ isFeatureEnabled: isFeatureEnabledMock }));
vi.mock('../../observability/error-tracking', () => ({ captureError: captureErrorMock }));

function jupiterResponse(items: { id: string; mcap: number | null }[]): Response {
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
});
