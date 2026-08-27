import { describe, expect, it } from 'vitest';

import { CONSTITUTION_SCHEMA_VERSION, type Constitution } from './constitution';
import { addUsd, compareUsd, evaluateTrade, sumTradeUsd, type EvaluableTrade } from './evaluate';

const NOW = new Date('2026-08-26T12:00:00Z');

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1_000);
}

function dailyNotionalConstitution(maxUsd: string): Constitution {
  return {
    schemaVersion: CONSTITUTION_SCHEMA_VERSION,
    limits: [{ id: 'limit-1', type: 'daily_notional_usd', maxUsd, windowHours: 24 }],
  };
}

function trade(overrides: Partial<EvaluableTrade> = {}): EvaluableTrade {
  return { occurredAt: NOW, usdValue: '100', ...overrides };
}

describe('addUsd', () => {
  it('adds exact decimal strings without touching floating point', () => {
    expect(addUsd('0', '0')).toBe('0');
    expect(addUsd('100', '50.5')).toBe('150.5');
    expect(addUsd('0.1', '0.2')).toBe('0.3'); // the canonical float trap: 0.1 + 0.2 !== 0.3 in IEEE 754
    expect(addUsd('999999999999999999999.999999999999', '0.000000000001')).toBe('1000000000000000000000.000000000000');
  });
});

describe('compareUsd', () => {
  it('compares exact decimal strings', () => {
    expect(compareUsd('100', '100.00')).toBe(0);
    expect(compareUsd('99.99', '100')).toBe(-1);
    expect(compareUsd('100.01', '100')).toBe(1);
  });
});

describe('sumTradeUsd', () => {
  it('sums exact decimal strings without floating point', () => {
    expect(sumTradeUsd([{ occurredAt: NOW, usdValue: '0.1' }, { occurredAt: NOW, usdValue: '0.2' }])).toBe('0.3');
  });

  it('is $0 for an empty list', () => {
    expect(sumTradeUsd([])).toBe('0');
  });

  it('is null — never $0 — the moment any trade in the list is unpriced', () => {
    expect(sumTradeUsd([{ occurredAt: NOW, usdValue: '10' }, { occurredAt: NOW, usdValue: null }])).toBeNull();
  });
});

describe('evaluateTrade — daily_notional_usd', () => {
  it('allows a trade that stays within the daily limit', () => {
    const decision = evaluateTrade(dailyNotionalConstitution('500'), [trade({ usdValue: '100' })], trade({ usdValue: '200' }));

    expect(decision.evaluations).toEqual([
      {
        limitId: 'limit-1',
        type: 'daily_notional_usd',
        verdict: 'allow',
        maxUsd: '500',
        windowHours: 24,
        priorUsd: '100',
        totalUsd: '300',
        reason: 'within_daily_notional_limit',
      },
    ]);
  });

  it('flags a violation the instant the total exceeds the limit', () => {
    const decision = evaluateTrade(dailyNotionalConstitution('500'), [trade({ usdValue: '450' })], trade({ usdValue: '100' }));

    expect(decision.evaluations[0]).toMatchObject({ verdict: 'violation', totalUsd: '550', reason: 'exceeds_daily_notional_limit' });
  });

  it('allows a trade that lands exactly on the limit — the limit is inclusive, not exclusive', () => {
    const decision = evaluateTrade(dailyNotionalConstitution('500'), [trade({ usdValue: '400' })], trade({ usdValue: '100' }));

    expect(decision.evaluations[0]).toMatchObject({ verdict: 'allow', totalUsd: '500' });
  });

  it('excludes prior trades that have already aged out of the 24h window', () => {
    const decision = evaluateTrade(
      dailyNotionalConstitution('500'),
      [trade({ usdValue: '450', occurredAt: hoursAgo(25) }), trade({ usdValue: '10', occurredAt: hoursAgo(1) })],
      trade({ usdValue: '10' }),
    );

    // Only the 1h-old and the new trade count: 10 + 10 = 20, well within 500.
    expect(decision.evaluations[0]).toMatchObject({ verdict: 'allow', priorUsd: '10', totalUsd: '20' });
  });

  it('never evaluates an unpriced trade as allowed — fails closed instead', () => {
    const decision = evaluateTrade(dailyNotionalConstitution('500'), [], trade({ usdValue: null }));

    expect(decision.evaluations[0]).toMatchObject({ verdict: 'unevaluable', reason: 'trade_unpriced', priorUsd: null, totalUsd: null });
  });

  it('never treats an unpriced trade in the window as if it contributed $0 to the total', () => {
    const decision = evaluateTrade(
      dailyNotionalConstitution('500'),
      [trade({ usdValue: null })],
      trade({ usdValue: '10' }),
    );

    expect(decision.evaluations[0]).toMatchObject({
      verdict: 'unevaluable',
      reason: 'history_contains_unpriced_trade',
      priorUsd: null,
      totalUsd: null,
    });
  });

  it('returns unevaluable, not a silent allow, for a limit type not yet implemented', () => {
    const constitution: Constitution = {
      schemaVersion: CONSTITUTION_SCHEMA_VERSION,
      limits: [{ id: 'limit-loss', type: 'rolling_loss_usd', maxUsd: '200', windowHours: 168 }],
    };

    const decision = evaluateTrade(constitution, [], trade());

    expect(decision.evaluations).toEqual([
      expect.objectContaining({ limitId: 'limit-loss', verdict: 'unevaluable', reason: 'limit_type_not_yet_implemented' }),
    ]);
  });

});

describe('evaluateTrade — asset_tier_acquisition_usd', () => {
  function tierConstitution(tier: 'MICRO_CAP' | 'LARGE_CAP', maxUsd: string): Constitution {
    return {
      schemaVersion: CONSTITUTION_SCHEMA_VERSION,
      limits: [{ id: 'limit-tier', type: 'asset_tier_acquisition_usd', tier, maxUsd, windowHours: 24 }],
    };
  }

  it('flags a violation when a buy pushes the tier total past its limit', () => {
    const decision = evaluateTrade(
      tierConstitution('MICRO_CAP', '100'),
      [trade({ usdValue: '80', isAcquisition: true, acquiredTier: 'MICRO_CAP' })],
      trade({ usdValue: '50', isAcquisition: true, acquiredTier: 'MICRO_CAP' }),
    );

    expect(decision.evaluations[0]).toMatchObject({
      verdict: 'violation',
      priorUsd: '80',
      totalUsd: '130',
      reason: 'exceeds_asset_tier_acquisition_limit',
    });
  });

  it('allows a buy that stays within the tier limit', () => {
    const decision = evaluateTrade(
      tierConstitution('MICRO_CAP', '100'),
      [],
      trade({ usdValue: '50', isAcquisition: true, acquiredTier: 'MICRO_CAP' }),
    );

    expect(decision.evaluations[0]).toMatchObject({ verdict: 'allow', totalUsd: '50', reason: 'within_asset_tier_acquisition_limit' });
  });

  it('never counts a sell out of the tier against the limit, no matter the amount', () => {
    const decision = evaluateTrade(
      tierConstitution('MICRO_CAP', '10'),
      [trade({ usdValue: '9', isAcquisition: true, acquiredTier: 'MICRO_CAP' })],
      trade({ usdValue: '999999', isAcquisition: false, acquiredTier: 'MICRO_CAP' }),
    );

    expect(decision.evaluations[0]).toMatchObject({ verdict: 'allow', reason: 'not_an_acquisition_into_this_tier' });
  });

  it('never counts a buy into a different tier against this tier\'s limit', () => {
    const decision = evaluateTrade(
      tierConstitution('MICRO_CAP', '10'),
      [],
      trade({ usdValue: '999999', isAcquisition: true, acquiredTier: 'LARGE_CAP' }),
    );

    expect(decision.evaluations[0]).toMatchObject({ verdict: 'allow', reason: 'not_an_acquisition_into_this_tier' });
  });

  it('a trade can violate the tier limit and still be within the daily-notional limit — independent evaluations', () => {
    const constitution: Constitution = {
      schemaVersion: CONSTITUTION_SCHEMA_VERSION,
      limits: [
        { id: 'limit-tier', type: 'asset_tier_acquisition_usd', tier: 'MICRO_CAP', maxUsd: '10', windowHours: 24 },
        { id: 'limit-daily', type: 'daily_notional_usd', maxUsd: '5000', windowHours: 24 },
      ],
    };

    const decision = evaluateTrade(constitution, [], trade({ usdValue: '50', isAcquisition: true, acquiredTier: 'MICRO_CAP' }));

    expect(decision.evaluations).toEqual([
      expect.objectContaining({ limitId: 'limit-tier', verdict: 'violation' }),
      expect.objectContaining({ limitId: 'limit-daily', verdict: 'allow' }),
    ]);
  });

  it('fails closed on an unpriced qualifying acquisition', () => {
    const decision = evaluateTrade(
      tierConstitution('MICRO_CAP', '100'),
      [],
      trade({ usdValue: null, isAcquisition: true, acquiredTier: 'MICRO_CAP' }),
    );

    expect(decision.evaluations[0]).toMatchObject({ verdict: 'unevaluable', reason: 'trade_unpriced' });
  });

  it('fails closed when the qualifying window history contains an unpriced trade', () => {
    const decision = evaluateTrade(
      tierConstitution('MICRO_CAP', '100'),
      [trade({ usdValue: null, isAcquisition: true, acquiredTier: 'MICRO_CAP' })],
      trade({ usdValue: '10', isAcquisition: true, acquiredTier: 'MICRO_CAP' }),
    );

    expect(decision.evaluations[0]).toMatchObject({ verdict: 'unevaluable', reason: 'history_contains_unpriced_trade' });
  });
});

describe('evaluateTrade — cross-limit independence', () => {
  it('evaluates every limit on the constitution independently', () => {
    const constitution: Constitution = {
      schemaVersion: CONSTITUTION_SCHEMA_VERSION,
      limits: [
        { id: 'limit-a', type: 'daily_notional_usd', maxUsd: '50', windowHours: 24 },
        { id: 'limit-b', type: 'daily_notional_usd', maxUsd: '5000', windowHours: 24 },
      ],
    };

    const decision = evaluateTrade(constitution, [], trade({ usdValue: '100' }));

    expect(decision.evaluations).toEqual([
      expect.objectContaining({ limitId: 'limit-a', verdict: 'violation' }),
      expect.objectContaining({ limitId: 'limit-b', verdict: 'allow' }),
    ]);
  });
});
