import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getSolUsdPrice, minuteBucketUtc, SOL_MINT } from './binance-klines';

const { isFeatureEnabledMock, captureErrorMock } = vi.hoisted(() => ({
  isFeatureEnabledMock: vi.fn(),
  captureErrorMock: vi.fn(),
}));

vi.mock('../flags/feature-flags', () => ({ isFeatureEnabled: isFeatureEnabledMock }));
vi.mock('../../observability/error-tracking', () => ({ captureError: captureErrorMock }));

const { selectMock, insertMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  insertMock: vi.fn(),
}));

vi.mock('../db/client', () => ({ getDb: () => ({ select: selectMock, insert: insertMock }) }));

/** Mimics drizzle's `select({...}).from().where().limit()` chain used by `loadCachedPrice`. */
function stubCachedRow(usdPrice: string | undefined) {
  selectMock.mockReturnValue({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(usdPrice === undefined ? [] : [{ usdPrice }]),
      }),
    }),
  });
}

/** Mimics drizzle's `insert().values().onConflictDoNothing()` chain used by `cachePrice`. */
function stubInsert() {
  const valuesSpy = vi.fn();

  insertMock.mockReturnValue({
    values: (valuesArg: unknown) => {
      valuesSpy(valuesArg);
      return { onConflictDoNothing: () => Promise.resolve() };
    },
  });

  return { valuesSpy };
}

function klineResponse(close: string): Response {
  return { ok: true, json: async () => [[0, '0', '0', '0', close]] } as unknown as Response;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  isFeatureEnabledMock.mockResolvedValue(true);
  stubCachedRow(undefined);
});

describe('getSolUsdPrice', () => {
  it('fetches, caches, and returns the price for a settled (past) minute bucket', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(klineResponse('200.50'));
    const { valuesSpy } = stubInsert();

    const occurredAt = new Date('2020-01-01T00:00:00Z');
    const result = await getSolUsdPrice(occurredAt);

    expect(result).toBe('200.50');
    expect(valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        mint: SOL_MINT,
        minuteBucketUtc: minuteBucketUtc(occurredAt),
        usdPrice: '200.50',
        source: 'binance',
      }),
    );
  });

  it('returns the live price for the current (in-progress) minute bucket but does not cache it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T12:34:30Z'));

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(klineResponse('201.75'));
    const { valuesSpy } = stubInsert();

    const result = await getSolUsdPrice(new Date());

    expect(result).toBe('201.75');
    expect(valuesSpy).not.toHaveBeenCalled();
  });

  it('reads a cached price without ever fetching from Binance', async () => {
    stubCachedRow('199.00');
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const result = await getSolUsdPrice(new Date('2020-01-01T00:00:00Z'));

    expect(result).toBe('199.00');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is null with zero network calls when pricing.binance is off', async () => {
    isFeatureEnabledMock.mockResolvedValue(false);
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const result = await getSolUsdPrice(new Date());

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is null, not a throw, on a non-200 response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 500 } as unknown as Response);

    const result = await getSolUsdPrice(new Date('2020-01-01T00:00:00Z'));

    expect(result).toBeNull();
    expect(captureErrorMock).toHaveBeenCalled();
  });

  it('is null, not a throw, when the request itself throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    const result = await getSolUsdPrice(new Date('2020-01-01T00:00:00Z'));

    expect(result).toBeNull();
    expect(captureErrorMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ failedClosed: true }));
  });
});
