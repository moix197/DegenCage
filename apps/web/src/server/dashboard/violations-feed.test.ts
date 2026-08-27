import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LimitEvaluation } from '@degencage/rules';
import { loadViolationsFeed } from './violations-feed';

const { selectMock } = vi.hoisted(() => ({ selectMock: vi.fn() }));

vi.mock('../db/client', () => ({ getDb: () => ({ select: selectMock }) }));

interface DecisionEventRow {
  occurredAt: Date;
  correlationId: string;
  payload: Record<string, unknown>;
}

interface TradeRow {
  signature: string;
  isBaseline: boolean;
  acquiredTier: string | null;
}

/** Mimics `select({...}).from(events).where().orderBy().limit()`. */
function eventsQueryReturns(rows: DecisionEventRow[]) {
  return {
    from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve(rows) }) }) }),
  };
}

/** Mimics `select({...}).from(trades).where()`. */
function tradesQueryReturns(rows: TradeRow[]) {
  return { from: () => ({ where: () => Promise.resolve(rows) }) };
}

function violationEvaluation(overrides: Partial<LimitEvaluation> = {}): LimitEvaluation {
  return {
    limitId: 'limit-1',
    type: 'daily_notional_usd',
    verdict: 'violation',
    maxUsd: '100',
    windowHours: 24,
    priorUsd: '80',
    totalUsd: '120',
    reason: 'exceeds_daily_notional_limit',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadViolationsFeed', () => {
  it('returns violations in chronological order, oldest first', async () => {
    const older = new Date('2026-08-20T00:00:00Z');
    const newer = new Date('2026-08-25T00:00:00Z');

    // The query itself returns newest-first (desc) — the function's job is to re-sort.
    selectMock
      .mockReturnValueOnce(
        eventsQueryReturns([
          { occurredAt: newer, correlationId: 'cid-newer', payload: { signature: 'sig-newer', evaluations: [violationEvaluation()] } },
          { occurredAt: older, correlationId: 'cid-older', payload: { signature: 'sig-older', evaluations: [violationEvaluation()] } },
        ]),
      )
      .mockReturnValueOnce(
        tradesQueryReturns([
          { signature: 'sig-newer', isBaseline: false, acquiredTier: null },
          { signature: 'sig-older', isBaseline: false, acquiredTier: null },
        ]),
      );

    const result = await loadViolationsFeed({ walletId: 'wallet-1', userId: 'user-1' });

    expect(result.map((item) => item.correlationId)).toEqual(['cid-older', 'cid-newer']);
  });

  it('never includes a violation sourced from a baseline trade, even though the event says violation', async () => {
    const occurredAt = new Date('2026-08-25T00:00:00Z');

    selectMock
      .mockReturnValueOnce(
        eventsQueryReturns([
          { occurredAt, correlationId: 'cid-baseline', payload: { signature: 'sig-baseline', evaluations: [violationEvaluation()] } },
        ]),
      )
      .mockReturnValueOnce(tradesQueryReturns([{ signature: 'sig-baseline', isBaseline: true, acquiredTier: null }]));

    const result = await loadViolationsFeed({ walletId: 'wallet-1', userId: 'user-1' });

    expect(result).toEqual([]);
  });

  it('excludes a decision with no matching trade row for this wallet (fails closed rather than guessing baseline status)', async () => {
    const occurredAt = new Date('2026-08-25T00:00:00Z');

    selectMock
      .mockReturnValueOnce(
        eventsQueryReturns([
          { occurredAt, correlationId: 'cid-orphan', payload: { signature: 'sig-orphan', evaluations: [violationEvaluation()] } },
        ]),
      )
      .mockReturnValueOnce(tradesQueryReturns([]));

    const result = await loadViolationsFeed({ walletId: 'wallet-1', userId: 'user-1' });

    expect(result).toEqual([]);
  });

  it('drops non-violation evaluations (allow, unevaluable) from the same decision event', async () => {
    const occurredAt = new Date('2026-08-25T00:00:00Z');

    selectMock
      .mockReturnValueOnce(
        eventsQueryReturns([
          {
            occurredAt,
            correlationId: 'cid-mixed',
            payload: {
              signature: 'sig-mixed',
              evaluations: [
                violationEvaluation({ limitId: 'limit-violated' }),
                { ...violationEvaluation({ limitId: 'limit-allowed' }), verdict: 'allow', totalUsd: '10' },
              ],
            },
          },
        ]),
      )
      .mockReturnValueOnce(tradesQueryReturns([{ signature: 'sig-mixed', isBaseline: false, acquiredTier: null }]));

    const result = await loadViolationsFeed({ walletId: 'wallet-1', userId: 'user-1' });

    expect(result).toHaveLength(1);
  });

  it('frames the message as accountability with the exceeded-by amount, never as blocking language', async () => {
    const occurredAt = new Date('2026-08-25T00:00:00Z');

    selectMock
      .mockReturnValueOnce(
        eventsQueryReturns([
          {
            occurredAt,
            correlationId: 'cid-tier',
            payload: {
              signature: 'sig-tier',
              evaluations: [violationEvaluation({ type: 'asset_tier_acquisition_usd', maxUsd: '100', totalUsd: '120' })],
            },
          },
        ]),
      )
      .mockReturnValueOnce(tradesQueryReturns([{ signature: 'sig-tier', isBaseline: false, acquiredTier: 'MICRO_CAP' }]));

    const result = await loadViolationsFeed({ walletId: 'wallet-1', userId: 'user-1' });

    expect(result).toHaveLength(1);
    expect(result[0]!.message).toBe('We saw that you exceeded your MICRO_CAP acquisition limit by $20.');
    expect(result[0]!.message.toLowerCase()).not.toMatch(/block|reject|denied|forbidden|punish/);
  });
});
