import { beforeEach, describe, expect, it, vi } from 'vitest';

import { computeRollingAllowance, loadWindowedTrades, sumWindowedUsd, type WindowedTrade } from './rolling-allowance';

const { selectMock } = vi.hoisted(() => ({ selectMock: vi.fn() }));

vi.mock('../db/client', () => ({ getDb: () => ({ select: selectMock }) }));

const NOW = new Date('2026-08-26T12:00:00Z');

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1_000);
}

/** Mimics drizzle's `select({...}).from().where()` chain, capturing the WHERE predicate. */
function selectReturns(rows: WindowedTrade[]) {
  const whereSpy = vi.fn();

  selectMock.mockReturnValue({
    from: () => ({
      where: (whereArg: unknown) => {
        whereSpy(whereArg);
        return Promise.resolve(rows);
      },
    }),
  });

  return { whereSpy };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sumWindowedUsd', () => {
  it('sums priced trades exactly, without floating point', () => {
    expect(sumWindowedUsd([{ occurredAt: NOW, usdValue: '0.1' }, { occurredAt: NOW, usdValue: '0.2' }])).toBe('0.3');
  });

  it('is $0 for an empty window', () => {
    expect(sumWindowedUsd([])).toBe('0');
  });

  it('is null — never $0 — the moment any trade in the window is unpriced', () => {
    expect(sumWindowedUsd([{ occurredAt: NOW, usdValue: '10' }, { occurredAt: NOW, usdValue: null }])).toBeNull();
  });

  /** The Tests-table requirement: the sum recomputes correctly as trades age out of the window. */
  it('recomputes as the window itself is recomputed with an older trade excluded', () => {
    const allTrades: WindowedTrade[] = [
      { occurredAt: hoursAgo(23), usdValue: '50' },
      { occurredAt: hoursAgo(25), usdValue: '999' }, // outside a 24h window from NOW
    ];

    const within24h = allTrades.filter((trade) => trade.occurredAt.getTime() >= NOW.getTime() - 24 * 60 * 60 * 1_000);

    expect(sumWindowedUsd(within24h)).toBe('50');

    // Just over an hour later, the 23h-old trade has also aged out (past, not merely at, the boundary).
    const laterWithin24h = allTrades.filter(
      (trade) => trade.occurredAt.getTime() >= NOW.getTime() + (60 * 60 * 1_000 + 1) - 24 * 60 * 60 * 1_000,
    );

    expect(sumWindowedUsd(laterWithin24h)).toBe('0');
  });
});

describe('loadWindowedTrades', () => {
  it('scopes the query to the wallet, live trades only, and the window bounds', async () => {
    const { whereSpy } = selectReturns([{ occurredAt: NOW, usdValue: '10' }]);

    const result = await loadWindowedTrades({ walletId: 'wallet-1', windowHours: 24, asOf: NOW });

    expect(result).toEqual([{ occurredAt: NOW, usdValue: '10' }]);
    expect(whereSpy).toHaveBeenCalledOnce();
  });
});

describe('computeRollingAllowance', () => {
  it('reports within-limit when the total is under maxUsd', async () => {
    selectReturns([{ occurredAt: NOW, usdValue: '100' }]);

    const result = await computeRollingAllowance({ walletId: 'wallet-1', windowHours: 24, asOf: NOW, maxUsd: '500' });

    expect(result).toEqual({
      trades: [{ occurredAt: NOW, usdValue: '100' }],
      totalUsd: '100',
      maxUsd: '500',
      withinLimit: true,
    });
  });

  it('reports over-limit, not within-limit, once the total exceeds maxUsd', async () => {
    selectReturns([{ occurredAt: NOW, usdValue: '600' }]);

    const result = await computeRollingAllowance({ walletId: 'wallet-1', windowHours: 24, asOf: NOW, maxUsd: '500' });

    expect(result.withinLimit).toBe(false);
  });

  it('never reports within-limit for an unknown (unpriced) total', async () => {
    selectReturns([{ occurredAt: NOW, usdValue: null }]);

    const result = await computeRollingAllowance({ walletId: 'wallet-1', windowHours: 24, asOf: NOW, maxUsd: '500' });

    expect(result).toMatchObject({ totalUsd: null, withinLimit: false });
  });
});
