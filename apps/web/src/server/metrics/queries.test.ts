import { describe, expect, it, vi } from 'vitest';

import type { Constitution } from '@degencage/rules';

import {
  computeBaselineCounterfactualViolationCount,
  getActivationConversionStats,
  getExternalViolationFrequencyComparison,
  getLimitsSetStats,
  getOnboardingCompletionStats,
  getRepeatedLooseningAttemptStats,
  getReturnVisitStats,
  getRulesKeptStats,
  getStricterRuleRequestStats,
} from './queries';

/**
 * One test per row in the plan's Phase 9 signal→event→query mapping table, plus the
 * `getRepeatedLooseningAttemptStats` addition (the "wants to loosen, repeatedly" mirror of
 * "requests for stricter rules", using three event types Phase 8 shipped after the plan was
 * written). Each query in `queries.ts` is a single `select().from().where()` (or, for
 * `loadBaselineTrades`, `...where().orderBy()`) — no `.limit()` — so a fixture row set stands
 * in for the database, same mocking shape as `server/constitution/rate-limit.ts`'s tests.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

const { selectMock } = vi.hoisted(() => ({ selectMock: vi.fn() }));

vi.mock('../db/client', () => ({ getDb: () => ({ select: selectMock }) }));
// `queries.ts` imports `listRecentFeedback` from this module purely for `buildMetricsSnapshot`
// (not exercised here) — stubbed so importing `queries.ts` never pulls in `../auth/session`
// (and therefore `next/headers`) unmocked.
vi.mock('../feedback/feedback', () => ({ listRecentFeedback: vi.fn(async () => []) }));

/** Mimics drizzle's `select().from().where()` chain resolving directly to rows — the shape every plain event/constitution query in `queries.ts` uses. */
function selectReturnsOnce(rows: unknown[]) {
  selectMock.mockReturnValueOnce({ from: () => ({ where: () => Promise.resolve(rows) }) });
}

/** Same, plus the trailing `.orderBy()` `loadBaselineTrades` chains on. */
function selectReturnsOrderedOnce(rows: unknown[]) {
  selectMock.mockReturnValueOnce({ from: () => ({ where: () => ({ orderBy: () => Promise.resolve(rows) }) }) });
}

function daysAfter(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1_000);
}

describe('getOnboardingCompletionStats', () => {
  it('divides distinct activated users by distinct session users', async () => {
    selectReturnsOnce([
      { userId: 'u1', eventType: 'auth.session_created', occurredAt: new Date(), payload: {} },
      { userId: 'u2', eventType: 'auth.session_created', occurredAt: new Date(), payload: {} },
      { userId: 'u3', eventType: 'auth.session_created', occurredAt: new Date(), payload: {} },
      { userId: 'u1', eventType: 'constitution.activated', occurredAt: new Date(), payload: {} },
      { userId: 'u2', eventType: 'constitution.activated', occurredAt: new Date(), payload: {} },
    ]);

    const result = await getOnboardingCompletionStats();

    expect(result).toEqual({ sessionUserCount: 3, activatedUserCount: 2, rate: 2 / 3 });
  });

  it('is zero, not NaN, with no sessions at all', async () => {
    selectReturnsOnce([]);

    const result = await getOnboardingCompletionStats();

    expect(result).toEqual({ sessionUserCount: 0, activatedUserCount: 0, rate: 0 });
  });
});

describe('getLimitsSetStats', () => {
  it('averages limit count and tallies limit types across active constitutions', async () => {
    const oneLimit: Constitution = {
      schemaVersion: 1,
      limits: [{ id: 'l1', type: 'daily_notional_usd', maxUsd: '500', windowHours: 24 }],
    };
    const twoLimits: Constitution = {
      schemaVersion: 1,
      limits: [
        { id: 'l2', type: 'daily_notional_usd', maxUsd: '500', windowHours: 24 },
        { id: 'l3', type: 'rolling_loss_usd', maxUsd: '200', windowHours: 168 },
      ],
    };

    selectReturnsOnce([{ document: oneLimit }, { document: twoLimits }]);

    const result = await getLimitsSetStats();

    expect(result).toEqual({
      activatedConstitutionCount: 2,
      avgLimitsPerConstitution: 1.5,
      limitTypeCounts: { daily_notional_usd: 2, rolling_loss_usd: 1 },
    });
  });
});

describe('getActivationConversionStats', () => {
  it('computes commitment-to-activation conversion and the early-attempt rate', async () => {
    selectReturnsOnce([
      { userId: 'u1', eventType: 'constitution.commitment_started', occurredAt: new Date(), payload: {} },
      { userId: 'u2', eventType: 'constitution.commitment_started', occurredAt: new Date(), payload: {} },
      { userId: 'u3', eventType: 'constitution.commitment_started', occurredAt: new Date(), payload: {} },
      { userId: 'u1', eventType: 'constitution.activated', occurredAt: new Date(), payload: {} },
      { userId: 'u2', eventType: 'constitution.activated', occurredAt: new Date(), payload: {} },
      { userId: 'u3', eventType: 'constitution.activation_rejected_early', occurredAt: new Date(), payload: {} },
    ]);

    const result = await getActivationConversionStats();

    expect(result).toEqual({
      commitmentStartedCount: 3,
      activatedCount: 2,
      conversionRate: 2 / 3,
      earlyActivationAttemptCount: 1,
      earlyActivationAttemptRate: 1 / 3,
    });
  });
});

describe('getReturnVisitStats', () => {
  it('computes avg distinct view-days and the week-2 return rate', async () => {
    const activatedAt = new Date('2026-01-01T00:00:00.000Z');
    const now = daysAfter(activatedAt, 20); // both users' day-8..14 window has elapsed

    selectReturnsOnce([
      { userId: 'A', eventType: 'dashboard.viewed', occurredAt: activatedAt, payload: {} },
      { userId: 'A', eventType: 'dashboard.viewed', occurredAt: daysAfter(activatedAt, 9), payload: {} },
      { userId: 'A', eventType: 'constitution.activated', occurredAt: activatedAt, payload: {} },
      { userId: 'B', eventType: 'dashboard.viewed', occurredAt: activatedAt, payload: {} },
      { userId: 'B', eventType: 'constitution.activated', occurredAt: activatedAt, payload: {} },
    ]);

    const result = await getReturnVisitStats(now);

    expect(result).toEqual({
      avgDistinctViewDaysPerUser: 1.5,
      week2EligibleUserCount: 2,
      week2ReturningUserCount: 1,
      week2ReturnRate: 0.5,
    });
  });
});

describe('getRulesKeptStats', () => {
  it('divides allowed evaluations by every evaluation recorded', async () => {
    selectReturnsOnce([
      {
        userId: 'u1',
        eventType: 'rule.decision_recorded',
        occurredAt: new Date(),
        payload: { evaluations: [{ verdict: 'allow' }, { verdict: 'violation' }] },
      },
      {
        userId: 'u2',
        eventType: 'rule.decision_recorded',
        occurredAt: new Date(),
        payload: { evaluations: [{ verdict: 'allow' }] },
      },
    ]);

    const result = await getRulesKeptStats();

    expect(result).toEqual({ totalEvaluations: 3, allowedCount: 2, rulesKeptRate: 2 / 3 });
  });
});

describe('getExternalViolationFrequencyComparison', () => {
  it('compares the live post-activation rate against the ad hoc baseline counterfactual', async () => {
    const activatedAt = new Date('2026-01-01T00:00:00.000Z');
    const now = new Date(activatedAt.getTime() + 3 * WEEK_MS);

    const liveRows = [
      { occurredAt: new Date('2026-01-05T00:00:00.000Z'), payload: { evaluations: [{ verdict: 'violation' }] } },
      { occurredAt: new Date('2026-01-10T00:00:00.000Z'), payload: { evaluations: [{ verdict: 'allow' }] } },
    ];

    const baselineTradeOne = { occurredAt: new Date('2025-10-01T00:00:00.000Z'), usdValue: '100', isAcquisition: true, acquiredTier: null, isRoundTripClose: false, realizedLossUsd: null };
    const baselineTradeTwo = { occurredAt: new Date('2025-10-01T01:00:00.000Z'), usdValue: '500', isAcquisition: true, acquiredTier: null, isRoundTripClose: false, realizedLossUsd: null };

    // Call order inside `getExternalViolationFrequencyComparison`'s `Promise.all`:
    // `loadLiveViolationEventsForUser` first, `loadBaselineTrades` second.
    selectReturnsOnce(liveRows);
    selectReturnsOrderedOnce([baselineTradeOne, baselineTradeTwo]);

    const constitution: Constitution = {
      schemaVersion: 1,
      limits: [{ id: 'limit-1', type: 'daily_notional_usd', maxUsd: '400', windowHours: 24 }],
    };

    const result = await getExternalViolationFrequencyComparison(
      { userId: 'user-1', walletId: 'wallet-1', constitution, activatedAt },
      now,
    );

    const expectedLiveWeeksElapsed = (now.getTime() - activatedAt.getTime()) / WEEK_MS;
    const expectedBaselineWeeksSpan = (baselineTradeTwo.occurredAt.getTime() - baselineTradeOne.occurredAt.getTime()) / WEEK_MS;

    expect(result.liveViolationCount).toBe(1); // only the first decision event carries a violation
    expect(result.liveWeeksElapsed).toBeCloseTo(expectedLiveWeeksElapsed, 10);
    expect(result.liveViolationsPerWeek).toBeCloseTo(1 / expectedLiveWeeksElapsed, 10);
    // second baseline trade: $100 prior + $500 = $600 > $400 maxUsd -> one counterfactual violation
    expect(result.baselineViolationCount).toBe(1);
    expect(result.baselineWeeksSpan).toBeCloseTo(expectedBaselineWeeksSpan, 10);
    expect(result.baselineViolationsPerWeek).toBeCloseTo(1 / expectedBaselineWeeksSpan, 10);
  });
});

describe('computeBaselineCounterfactualViolationCount', () => {
  it('re-runs evaluateTrade ad hoc over baseline trades only, honoring each limit\'s own window', async () => {
    const constitution: Constitution = {
      schemaVersion: 1,
      limits: [{ id: 'limit-1', type: 'daily_notional_usd', maxUsd: '100', windowHours: 1 }],
    };

    const violationCount = computeBaselineCounterfactualViolationCount(constitution, [
      { occurredAt: new Date('2025-10-01T00:00:00.000Z'), usdValue: '80', isAcquisition: true, acquiredTier: null, isRoundTripClose: false, realizedLossUsd: null },
      // Two hours later — outside the 1h window, so this does not stack with the first trade.
      { occurredAt: new Date('2025-10-01T02:00:00.000Z'), usdValue: '80', isAcquisition: true, acquiredTier: null, isRoundTripClose: false, realizedLossUsd: null },
      // Ten minutes after that — inside the 1h window against the second trade: 80 + 80 = 160 > 100.
      { occurredAt: new Date('2025-10-01T02:10:00.000Z'), usdValue: '80', isAcquisition: true, acquiredTier: null, isRoundTripClose: false, realizedLossUsd: null },
    ]);

    expect(violationCount).toBe(1);
  });
});

describe('getStricterRuleRequestStats', () => {
  it('counts voluntary decreases, total and by user', async () => {
    selectReturnsOnce([
      { userId: 'u1', eventType: 'constitution.limit_decreased', occurredAt: new Date(), payload: {} },
      { userId: 'u1', eventType: 'constitution.limit_decreased', occurredAt: new Date(), payload: {} },
      { userId: 'u2', eventType: 'constitution.limit_decreased', occurredAt: new Date(), payload: {} },
    ]);

    const result = await getStricterRuleRequestStats();

    expect(result).toEqual({ totalDecreaseCount: 3, decreaseCountByUser: { u1: 2, u2: 1 } });
  });
});

describe('getRepeatedLooseningAttemptStats', () => {
  it('flags a user as repeated once they hit 2+ attempts, or the throttle at all', async () => {
    selectReturnsOnce([
      { userId: 'u1', eventType: 'constitution.limit_increase_attempted', occurredAt: new Date(), payload: {} },
      { userId: 'u1', eventType: 'constitution.limit_increase_attempted', occurredAt: new Date(), payload: {} },
      { userId: 'u2', eventType: 'constitution.limit_increase_attempted', occurredAt: new Date(), payload: {} },
      { userId: 'u2', eventType: 'constitution.limit_increase_voided', occurredAt: new Date(), payload: {} },
      { userId: 'u3', eventType: 'constitution.edit_rate_limited', occurredAt: new Date(), payload: {} },
    ]);

    const result = await getRepeatedLooseningAttemptStats();

    expect(result).toEqual({
      totalAttemptCount: 3,
      totalVoidedCount: 1,
      totalRateLimitedCount: 1,
      repeatedAttemptUserCount: 2, // u1 (2 attempts) and u3 (ever throttled) — not u2 (1 attempt, never throttled)
    });
  });
});
