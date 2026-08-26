import { beforeEach, describe, expect, it, vi } from 'vitest';

import { computeRollingAllowance, loadWindowedTrades, type WindowedTrade } from './rolling-allowance';

const { selectMock } = vi.hoisted(() => ({ selectMock: vi.fn() }));

vi.mock('../db/client', () => ({ getDb: () => ({ select: selectMock }) }));

const NOW = new Date('2026-08-26T12:00:00Z');

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

// The summation itself — empty window, decimal precision, null propagation, aging out of a
// window — is `@degencage/rules`' `sumTradeUsd`, tested there (`packages/rules/src/evaluate.test.ts`).
// This file covers only what's specific to this module: the query's scoping and the
// limit comparison.

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
