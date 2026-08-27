import { describe, expect, it } from 'vitest';

import { matchDisposal, openLot, subtractUsd, type PositionLot } from './lot-matching';

const OPENED_AT = new Date('2026-08-01T00:00:00Z');

function lot(overrides: Partial<PositionLot> = {}): PositionLot {
  return {
    id: 'lot-1',
    mint: 'BONK',
    openedAt: OPENED_AT,
    openedAfterActivation: true,
    remainingBaseUnits: 1_000n,
    costBasisUsd: '100.000000000000',
    ...overrides,
  };
}

describe('openLot', () => {
  it('opens a lot with the full acquired base units as its remaining balance and cost basis', () => {
    const opened = openLot({ mint: 'BONK', baseUnits: 500_000n, costBasisUsd: '42.5', openedAt: OPENED_AT, openedAfterActivation: true });

    expect(opened).toEqual({
      mint: 'BONK',
      openedAt: OPENED_AT,
      openedAfterActivation: true,
      remainingBaseUnits: 500_000n,
      costBasisUsd: '42.5',
    });
  });

  it('carries a null cost basis through from an unpriced opening trade — never coerced to 0', () => {
    expect(openLot({ mint: 'BONK', baseUnits: 1n, costBasisUsd: null, openedAt: OPENED_AT, openedAfterActivation: true }).costBasisUsd).toBeNull();
  });
});

describe('matchDisposal — simple full round trip', () => {
  it('a lot opened and fully closed after activation is eligible, with the correct realized loss', () => {
    const openedLot = lot({ remainingBaseUnits: 1_000n, costBasisUsd: '100.000000000000', openedAfterActivation: true });

    const result = matchDisposal([openedLot], 1_000n, '70', true);

    expect(result.isRoundTripClose).toBe(true);
    expect(result.unmatchedBaseUnits).toBe(0n);
    expect(result.realizedLossUsd).toBe('-30.000000000000'); // sold for $70 what cost $100 — a $30 loss
    expect(result.consumptions).toEqual([{ lot: openedLot, unitsConsumed: 1_000n, costBasisConsumed: '100.000000000000' }]);
    expect(result.updatedLots).toEqual([{ ...openedLot, remainingBaseUnits: 0n, costBasisUsd: '0.000000000000' }]);
  });

  it('a winning round trip (sold for more than cost) reports a positive realizedLossUsd', () => {
    const result = matchDisposal([lot({ remainingBaseUnits: 1_000n, costBasisUsd: '50' })], 1_000n, '90', true);

    expect(result.realizedLossUsd).toBe('40.000000000000');
  });
});

describe('matchDisposal — decision 1: opened-before-activation exclusion', () => {
  it('a round trip opened before activation and closed after is excluded entirely, even though it fully matched and both legs were priced', () => {
    const preActivationLot = lot({ openedAfterActivation: false, remainingBaseUnits: 1_000n, costBasisUsd: '100' });

    const result = matchDisposal([preActivationLot], 1_000n, '10', true);

    expect(result.isRoundTripClose).toBe(true); // it did close a real lot...
    expect(result.realizedLossUsd).toBeNull(); // ...but decision 1 excludes it from the loss sum entirely
  });

  it('a lot opened after activation but closed by a disposal that itself precedes activation is also excluded — decision 1 requires both halves after activation', () => {
    const postActivationLot = lot({ openedAfterActivation: true, remainingBaseUnits: 1_000n, costBasisUsd: '100' });

    const result = matchDisposal([postActivationLot], 1_000n, '10', false /* closedAfterActivation */);

    expect(result.isRoundTripClose).toBe(true);
    expect(result.realizedLossUsd).toBeNull();
  });
});

describe('matchDisposal — mixed pre/post-activation lots', () => {
  it('a close spanning one pre-activation and one post-activation lot is excluded entirely — not split or prorated', () => {
    const preLot = lot({ id: 'lot-pre', openedAt: new Date('2026-07-01T00:00:00Z'), openedAfterActivation: false, remainingBaseUnits: 500n, costBasisUsd: '40' });
    const postLot = lot({ id: 'lot-post', openedAt: new Date('2026-08-05T00:00:00Z'), openedAfterActivation: true, remainingBaseUnits: 500n, costBasisUsd: '60' });

    // Oldest first — FIFO draws the pre-activation lot down before the post-activation one.
    const result = matchDisposal([preLot, postLot], 1_000n, '90', true);

    expect(result.consumptions).toHaveLength(2);
    expect(result.consumptions[0]!.lot.id).toBe('lot-pre');
    expect(result.consumptions[1]!.lot.id).toBe('lot-post');
    expect(result.isRoundTripClose).toBe(true);
    expect(result.realizedLossUsd).toBeNull(); // mixed-lot conservative rule — the whole close is excluded
  });
});

describe('matchDisposal — partial disposal', () => {
  it('selling less than the open lot leaves a correctly-sized remaining lot, cost basis reduced proportionally', () => {
    const openedLot = lot({ remainingBaseUnits: 1_000n, costBasisUsd: '100.000000000000' });

    // Sell 400 of the 1,000 units — 40% — for $28 (proportional to a $40 cost basis slice, a $12 loss).
    const result = matchDisposal([openedLot], 400n, '28', true);

    expect(result.consumptions).toEqual([{ lot: openedLot, unitsConsumed: 400n, costBasisConsumed: '40.000000000000' }]);
    expect(result.updatedLots).toEqual([{ ...openedLot, remainingBaseUnits: 600n, costBasisUsd: '60.000000000000' }]);
    expect(result.realizedLossUsd).toBe('-12.000000000000');
    expect(result.isRoundTripClose).toBe(true);
  });

  it('a second partial disposal continues drawing down the same lot correctly', () => {
    const afterFirstSale = lot({ remainingBaseUnits: 600n, costBasisUsd: '60.000000000000' });

    const result = matchDisposal([afterFirstSale], 600n, '55', true);

    expect(result.updatedLots).toEqual([{ ...afterFirstSale, remainingBaseUnits: 0n, costBasisUsd: '0.000000000000' }]);
    expect(result.realizedLossUsd).toBe('-5.000000000000');
  });
});

describe('matchDisposal — insufficient lot inventory (deficit)', () => {
  it('a disposal larger than every known lot is excluded entirely — the unmatched portion may predate this module\'s coverage', () => {
    const openedLot = lot({ remainingBaseUnits: 300n, costBasisUsd: '30' });

    const result = matchDisposal([openedLot], 1_000n, '80', true);

    expect(result.unmatchedBaseUnits).toBe(700n);
    expect(result.isRoundTripClose).toBe(true); // it did draw down the one lot that existed
    expect(result.realizedLossUsd).toBeNull(); // but the disposal wasn't fully covered — conservative exclusion
    expect(result.updatedLots).toEqual([{ ...openedLot, remainingBaseUnits: 0n, costBasisUsd: '0.000000000000' }]);
  });

  it('a disposal with zero matching lots at all is not a round-trip close', () => {
    const result = matchDisposal([], 1_000n, '80', true);

    expect(result.isRoundTripClose).toBe(false);
    expect(result.unmatchedBaseUnits).toBe(1_000n);
    expect(result.realizedLossUsd).toBeNull();
    expect(result.consumptions).toEqual([]);
  });
});

describe('matchDisposal — unpriced legs', () => {
  it('an unpriced disposal (proceedsUsd: null) excludes the close from the loss sum', () => {
    const result = matchDisposal([lot({ remainingBaseUnits: 1_000n, costBasisUsd: '100' })], 1_000n, null, true);

    expect(result.isRoundTripClose).toBe(true);
    expect(result.realizedLossUsd).toBeNull();
  });

  it('a lot whose own opening trade was unpriced (costBasisUsd: null) excludes any close that consumes it', () => {
    const result = matchDisposal([lot({ remainingBaseUnits: 1_000n, costBasisUsd: null })], 1_000n, '50', true);

    expect(result.isRoundTripClose).toBe(true);
    expect(result.realizedLossUsd).toBeNull();
    expect(result.consumptions[0]!.costBasisConsumed).toBeNull();
    expect(result.updatedLots[0]!.costBasisUsd).toBeNull();
  });
});

describe('exact decimal/BigInt math — no float on any fractional token amount', () => {
  it('token base-unit amounts are BigInt end to end, never Number', () => {
    const result = matchDisposal([lot({ remainingBaseUnits: 123_456_789_012_345_678n, costBasisUsd: '999.999999999999' })], 1n, '0.000000000001', true);

    expect(typeof result.updatedLots[0]!.remainingBaseUnits).toBe('bigint');
    expect(result.updatedLots[0]!.remainingBaseUnits).toBe(123_456_789_012_345_677n);
    // A value this large loses precision the instant it touches `Number` — proof this path never does.
    expect(Number.isSafeInteger(Number(result.updatedLots[0]!.remainingBaseUnits))).toBe(false);
  });

  it('subtractUsd is exact decimal-string subtraction, including negative results, never touching floating point', () => {
    expect(subtractUsd('0.3', '0.1')).toBe('0.200000000000'); // the canonical float trap the other direction: 0.3 - 0.1 !== 0.2 in IEEE 754
    expect(subtractUsd('10', '30')).toBe('-20.000000000000');
    expect(subtractUsd('0', '0')).toBe('0.000000000000');
  });
});
