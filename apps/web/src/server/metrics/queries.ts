import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import {
  evaluateTrade,
  migrateConstitution,
  type AssetTier,
  type Constitution,
  type EvaluableTrade,
  type LimitEvaluation,
} from '@degencage/rules';

import { type DatabaseExecutor } from '../../observability/events';
import { getDb } from '../db/client';
import { constitutions, events, trades } from '../db/schema';
import { listRecentFeedback, type FeedbackSubmission } from '../feedback/feedback';

/**
 * Phase 9 — the whole Phase 0 bet, computed live from the event log and stored trades. Every
 * function here is a plain query (or a query plus a pure JS reduction over its rows), never a
 * precomputed/incremented counter (CLAUDE.md → derive, don't increment). `buildMetricsSnapshot`
 * is the one function both `GET /api/admin/metrics` and `/admin/metrics` render from — same
 * "one function, two callers" shape as `server/dashboard/dashboard-state.ts`'s
 * `buildDashboardState`.
 *
 * The signal→event mapping is the plan's own table (`plans/phase-0-commitment-mechanism.md`,
 * Phase 9) — one exported `getXStats`/`getXComparison` per row, each backed by a pure
 * `computeX` the query result is handed to (unit-testable without a database). Plus
 * `getRepeatedLooseningAttemptStats`, for a signal the plan predates: Phase 8 shipped
 * `constitution.limit_increase_attempted`/`_voided`/`edit_rate_limited`, the "wants to
 * loosen, repeatedly" mirror of the plan's own `limit_decreased`-based "wants stricter rules"
 * row.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

const EVENT_SESSION_CREATED = 'auth.session_created';
const EVENT_CONSTITUTION_ACTIVATED = 'constitution.activated';
const EVENT_COMMITMENT_STARTED = 'constitution.commitment_started';
const EVENT_ACTIVATION_REJECTED_EARLY = 'constitution.activation_rejected_early';
const EVENT_DASHBOARD_VIEWED = 'dashboard.viewed';
const EVENT_RULE_DECISION_RECORDED = 'rule.decision_recorded';
const EVENT_LIMIT_DECREASED = 'constitution.limit_decreased';
const EVENT_LIMIT_INCREASE_ATTEMPTED = 'constitution.limit_increase_attempted';
const EVENT_LIMIT_INCREASE_VOIDED = 'constitution.limit_increase_voided';
const EVENT_EDIT_RATE_LIMITED = 'constitution.edit_rate_limited';

interface EventRow {
  userId: string | null;
  eventType: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
}

/**
 * The one query shape every event-log metric below reads through — a full scan by event
 * type(s), no date range or row cap. Phase 0's event volume is small and this route exists
 * precisely to report exact numbers, not sampled ones; revisit with a date-range filter if
 * this ever becomes the bottleneck it isn't yet.
 */
async function loadEventsByType(eventTypes: string[], executor: DatabaseExecutor = getDb()): Promise<EventRow[]> {
  return executor
    .select({ userId: events.userId, eventType: events.eventType, occurredAt: events.occurredAt, payload: events.payload })
    .from(events)
    .where(inArray(events.eventType, eventTypes));
}

function distinctUserIds(rows: EventRow[]): Set<string> {
  const ids = new Set<string>();

  for (const row of rows) {
    if (row.userId) ids.add(row.userId);
  }

  return ids;
}

/** Guards every ratio below against a zero denominator — an empty cohort reads `0`, never `NaN`/`Infinity`. */
function safeRate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function extractEvaluations(payload: Record<string, unknown>): LimitEvaluation[] {
  return Array.isArray(payload.evaluations) ? (payload.evaluations as LimitEvaluation[]) : [];
}

// ---------------------------------------------------------------------------
// Onboarding completion: auth.session_created -> constitution.activated
// ---------------------------------------------------------------------------

export interface OnboardingCompletionStats {
  sessionUserCount: number;
  activatedUserCount: number;
  rate: number;
}

export function computeOnboardingCompletionStats(rows: EventRow[]): OnboardingCompletionStats {
  const sessionUsers = distinctUserIds(rows.filter((row) => row.eventType === EVENT_SESSION_CREATED));
  const activatedUsers = distinctUserIds(rows.filter((row) => row.eventType === EVENT_CONSTITUTION_ACTIVATED));

  return {
    sessionUserCount: sessionUsers.size,
    activatedUserCount: activatedUsers.size,
    rate: safeRate(activatedUsers.size, sessionUsers.size),
  };
}

export async function getOnboardingCompletionStats(executor: DatabaseExecutor = getDb()): Promise<OnboardingCompletionStats> {
  const rows = await loadEventsByType([EVENT_SESSION_CREATED, EVENT_CONSTITUTION_ACTIVATED], executor);
  return computeOnboardingCompletionStats(rows);
}

// ---------------------------------------------------------------------------
// Limits set: constitution.activated payload's document.limits, read from the current row
// ---------------------------------------------------------------------------

export interface LimitsSetStats {
  activatedConstitutionCount: number;
  avgLimitsPerConstitution: number;
  limitTypeCounts: Record<string, number>;
}

async function loadActiveConstitutionDocuments(executor: DatabaseExecutor = getDb()): Promise<unknown[]> {
  const rows = await executor.select({ document: constitutions.document }).from(constitutions).where(eq(constitutions.status, 'active'));

  return rows.map((row) => row.document);
}

/** `migrateConstitution` throws on a corrupt row — an active constitution is trusted, our own stored data, same assumption every other reader of this column makes. */
export function computeLimitsSetStats(documents: unknown[]): LimitsSetStats {
  const limitTypeCounts: Record<string, number> = {};
  let totalLimits = 0;

  for (const raw of documents) {
    const constitution = migrateConstitution(raw);
    totalLimits += constitution.limits.length;

    for (const limit of constitution.limits) {
      limitTypeCounts[limit.type] = (limitTypeCounts[limit.type] ?? 0) + 1;
    }
  }

  return {
    activatedConstitutionCount: documents.length,
    avgLimitsPerConstitution: safeRate(totalLimits, documents.length),
    limitTypeCounts,
  };
}

export async function getLimitsSetStats(executor: DatabaseExecutor = getDb()): Promise<LimitsSetStats> {
  const documents = await loadActiveConstitutionDocuments(executor);
  return computeLimitsSetStats(documents);
}

// ---------------------------------------------------------------------------
// Activation (commitment follow-through): commitment_started -> activated, plus early attempts
// ---------------------------------------------------------------------------

export interface ActivationConversionStats {
  commitmentStartedCount: number;
  activatedCount: number;
  conversionRate: number;
  earlyActivationAttemptCount: number;
  earlyActivationAttemptRate: number;
}

export function computeActivationConversionStats(rows: EventRow[]): ActivationConversionStats {
  const commitmentStartedCount = rows.filter((row) => row.eventType === EVENT_COMMITMENT_STARTED).length;
  const activatedCount = rows.filter((row) => row.eventType === EVENT_CONSTITUTION_ACTIVATED).length;
  const earlyActivationAttemptCount = rows.filter((row) => row.eventType === EVENT_ACTIVATION_REJECTED_EARLY).length;

  return {
    commitmentStartedCount,
    activatedCount,
    conversionRate: safeRate(activatedCount, commitmentStartedCount),
    earlyActivationAttemptCount,
    earlyActivationAttemptRate: safeRate(earlyActivationAttemptCount, commitmentStartedCount),
  };
}

export async function getActivationConversionStats(executor: DatabaseExecutor = getDb()): Promise<ActivationConversionStats> {
  const rows = await loadEventsByType(
    [EVENT_COMMITMENT_STARTED, EVENT_CONSTITUTION_ACTIVATED, EVENT_ACTIVATION_REJECTED_EARLY],
    executor,
  );

  return computeActivationConversionStats(rows);
}

// ---------------------------------------------------------------------------
// Return visits / week-2 floor: dashboard.viewed, anchored on constitution.activated
// ---------------------------------------------------------------------------

export interface ReturnVisitStats {
  avgDistinctViewDaysPerUser: number;
  week2EligibleUserCount: number;
  week2ReturningUserCount: number;
  week2ReturnRate: number;
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Every day-8..14 window boundary in this file is `activatedAt + N days`, in UTC calendar days derived from `dayKey` — display-only precision, not a Postgres `now()`-gated deadline like the commitment window. */
export function computeReturnVisitStats(rows: EventRow[], now: Date): ReturnVisitStats {
  const viewedDaysByUser = new Map<string, Set<string>>();
  const activatedAtByUser = new Map<string, Date>();

  for (const row of rows) {
    if (!row.userId) continue;

    if (row.eventType === EVENT_DASHBOARD_VIEWED) {
      const days = viewedDaysByUser.get(row.userId) ?? new Set<string>();
      days.add(dayKey(row.occurredAt));
      viewedDaysByUser.set(row.userId, days);
    } else if (row.eventType === EVENT_CONSTITUTION_ACTIVATED) {
      // A user activates at most once (`constitutions_user_id_idx` is unique) — one row per user.
      activatedAtByUser.set(row.userId, row.occurredAt);
    }
  }

  const distinctDayCounts = [...viewedDaysByUser.values()].map((days) => days.size);
  const avgDistinctViewDaysPerUser = safeRate(
    distinctDayCounts.reduce((sum, count) => sum + count, 0),
    distinctDayCounts.length,
  );

  let week2EligibleUserCount = 0;
  let week2ReturningUserCount = 0;

  for (const [userId, activatedAt] of activatedAtByUser) {
    const windowStart = new Date(activatedAt.getTime() + 8 * 24 * 60 * 60 * 1_000);
    const windowEnd = new Date(activatedAt.getTime() + 14 * 24 * 60 * 60 * 1_000);

    // Only a user whose day-8..14 window has actually elapsed can prove or disprove the
    // floor — a user activated last week is neither a return nor a churn yet.
    if (windowEnd.getTime() > now.getTime()) continue;

    week2EligibleUserCount += 1;

    const viewedDays = viewedDaysByUser.get(userId);
    const returned = viewedDays
      ? [...viewedDays].some((key) => {
          const day = new Date(`${key}T00:00:00.000Z`);
          return day.getTime() >= windowStart.getTime() && day.getTime() <= windowEnd.getTime();
        })
      : false;

    if (returned) week2ReturningUserCount += 1;
  }

  return {
    avgDistinctViewDaysPerUser,
    week2EligibleUserCount,
    week2ReturningUserCount,
    week2ReturnRate: safeRate(week2ReturningUserCount, week2EligibleUserCount),
  };
}

export async function getReturnVisitStats(now: Date = new Date(), executor: DatabaseExecutor = getDb()): Promise<ReturnVisitStats> {
  const rows = await loadEventsByType([EVENT_DASHBOARD_VIEWED, EVENT_CONSTITUTION_ACTIVATED], executor);
  return computeReturnVisitStats(rows, now);
}

// ---------------------------------------------------------------------------
// Rules kept %: rule.decision_recorded, live (non-baseline) trades only by construction —
// this event type is never written for a baseline trade (`reconcile-wallet.ts`).
// ---------------------------------------------------------------------------

export interface RulesKeptStats {
  totalEvaluations: number;
  allowedCount: number;
  rulesKeptRate: number;
}

export function computeRulesKeptStats(rows: EventRow[]): RulesKeptStats {
  let totalEvaluations = 0;
  let allowedCount = 0;

  for (const row of rows) {
    for (const evaluation of extractEvaluations(row.payload)) {
      totalEvaluations += 1;
      if (evaluation.verdict === 'allow') allowedCount += 1;
    }
  }

  return { totalEvaluations, allowedCount, rulesKeptRate: safeRate(allowedCount, totalEvaluations) };
}

export async function getRulesKeptStats(executor: DatabaseExecutor = getDb()): Promise<RulesKeptStats> {
  const rows = await loadEventsByType([EVENT_RULE_DECISION_RECORDED], executor);
  return computeRulesKeptStats(rows);
}

// ---------------------------------------------------------------------------
// External violation frequency: live post-activation rate vs. the ad hoc baseline counterfactual
// ---------------------------------------------------------------------------

interface BaselineTradeRow {
  occurredAt: Date;
  usdValue: string | null;
  isAcquisition: boolean;
  acquiredTier: AssetTier | null;
  isRoundTripClose: boolean;
  realizedLossUsd: string | null;
}

/**
 * Every real (non-excluded) baseline trade for one wallet. Deliberately not a reuse of
 * `server/rules/rolling-allowance.ts`'s `loadWindowedTrades` — that helper hardcodes
 * `isBaseline: false` for the opposite, load-bearing reason (decision 9's private record must
 * never feed a live allowance). This is the one place in the codebase allowed to read baseline
 * trades for evaluation, and only for this internal, never-user-facing metric.
 */
async function loadBaselineTrades(walletId: string, executor: DatabaseExecutor = getDb()): Promise<BaselineTradeRow[]> {
  return executor
    .select({
      occurredAt: trades.occurredAt,
      usdValue: trades.usdValue,
      isAcquisition: trades.isAcquisition,
      acquiredTier: trades.acquiredTier,
      isRoundTripClose: trades.isRoundTripClose,
      realizedLossUsd: trades.realizedLossUsd,
    })
    .from(trades)
    .where(and(eq(trades.walletId, walletId), eq(trades.isBaseline, true), isNull(trades.excludedReason)))
    .orderBy(asc(trades.occurredAt));
}

/**
 * Ad hoc, in-memory only: never stored as `rule.decision_recorded` (that event type is reserved
 * for real live trades — `reconcile-wallet.ts`), never surfaced to the user (decision 9). Sorts
 * defensively rather than trusting caller order, so this stays correct independent of how its
 * rows were fetched.
 *
 * `lossLimitEnabled: true` on every trade regardless of the flag's historical state when the
 * baseline was originally reconciled — this counterfactual asks "would this constitution's
 * limits have caught this activity", not "was the loss-limit pipeline on at backfill time".
 */
export function computeBaselineCounterfactualViolationCount(constitution: Constitution, baselineTrades: BaselineTradeRow[]): number {
  const sorted = [...baselineTrades].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const evaluable: EvaluableTrade[] = sorted.map((trade) => ({ ...trade, lossLimitEnabled: true }));

  let violationCount = 0;

  for (let index = 0; index < evaluable.length; index += 1) {
    const priorTrades = evaluable.slice(0, index);
    const decision = evaluateTrade(constitution, priorTrades, evaluable[index]!);

    if (decision.evaluations.some((evaluation) => evaluation.verdict === 'violation')) {
      violationCount += 1;
    }
  }

  return violationCount;
}

function weeksBetween(rows: { occurredAt: Date }[]): number {
  if (rows.length < 2) return 0;

  const sorted = [...rows].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const first = sorted[0]!.occurredAt.getTime();
  const last = sorted[sorted.length - 1]!.occurredAt.getTime();

  return (last - first) / WEEK_MS;
}

interface LiveViolationEventRow {
  occurredAt: Date;
  payload: Record<string, unknown>;
}

async function loadLiveViolationEventsForUser(userId: string, executor: DatabaseExecutor = getDb()): Promise<LiveViolationEventRow[]> {
  return executor
    .select({ occurredAt: events.occurredAt, payload: events.payload })
    .from(events)
    .where(and(eq(events.userId, userId), eq(events.eventType, EVENT_RULE_DECISION_RECORDED)));
}

function countViolationEvents(rows: LiveViolationEventRow[]): number {
  let count = 0;

  for (const row of rows) {
    if (extractEvaluations(row.payload).some((evaluation) => evaluation.verdict === 'violation')) {
      count += 1;
    }
  }

  return count;
}

export interface ExternalViolationFrequencyComparison {
  userId: string;
  liveViolationCount: number;
  liveWeeksElapsed: number;
  liveViolationsPerWeek: number;
  baselineViolationCount: number;
  baselineWeeksSpan: number;
  baselineViolationsPerWeek: number;
}

export interface ExternalViolationFrequencyParams {
  userId: string;
  walletId: string;
  constitution: Constitution;
  activatedAt: Date;
}

export async function getExternalViolationFrequencyComparison(
  { userId, walletId, constitution, activatedAt }: ExternalViolationFrequencyParams,
  now: Date = new Date(),
  executor: DatabaseExecutor = getDb(),
): Promise<ExternalViolationFrequencyComparison> {
  const [liveRows, baselineTrades] = await Promise.all([
    loadLiveViolationEventsForUser(userId, executor),
    loadBaselineTrades(walletId, executor),
  ]);

  const liveViolationCount = countViolationEvents(liveRows);
  const liveWeeksElapsed = Math.max(0, (now.getTime() - activatedAt.getTime()) / WEEK_MS);
  const baselineViolationCount = computeBaselineCounterfactualViolationCount(constitution, baselineTrades);
  const baselineWeeksSpan = weeksBetween(baselineTrades);

  return {
    userId,
    liveViolationCount,
    liveWeeksElapsed,
    liveViolationsPerWeek: safeRate(liveViolationCount, liveWeeksElapsed),
    baselineViolationCount,
    baselineWeeksSpan,
    baselineViolationsPerWeek: safeRate(baselineViolationCount, baselineWeeksSpan),
  };
}

interface ActiveConstitutionForComparison {
  userId: string;
  walletId: string;
  document: unknown;
  activatedAt: Date;
}

async function loadActiveConstitutionsForComparison(executor: DatabaseExecutor = getDb()): Promise<ActiveConstitutionForComparison[]> {
  const rows = await executor
    .select({ userId: constitutions.userId, walletId: constitutions.walletId, document: constitutions.document, activatedAt: constitutions.activatedAt })
    .from(constitutions)
    .where(eq(constitutions.status, 'active'));

  return rows.flatMap((row) =>
    row.activatedAt ? [{ userId: row.userId, walletId: row.walletId, document: row.document, activatedAt: row.activatedAt }] : [],
  );
}

/** The page/route-level aggregate: every active constitution's own comparison, run sequentially — an internal, low-traffic endpoint, not a hot path. */
export async function getExternalViolationFrequencyForAllUsers(
  now: Date = new Date(),
  executor: DatabaseExecutor = getDb(),
): Promise<ExternalViolationFrequencyComparison[]> {
  const activeConstitutions = await loadActiveConstitutionsForComparison(executor);
  const comparisons: ExternalViolationFrequencyComparison[] = [];

  for (const row of activeConstitutions) {
    const constitution = migrateConstitution(row.document);
    comparisons.push(
      await getExternalViolationFrequencyComparison({ userId: row.userId, walletId: row.walletId, constitution, activatedAt: row.activatedAt }, now, executor),
    );
  }

  return comparisons;
}

// ---------------------------------------------------------------------------
// Requests for stricter rules: constitution.limit_decreased — a proxy signal only
// ---------------------------------------------------------------------------

export interface StricterRuleRequestStats {
  totalDecreaseCount: number;
  decreaseCountByUser: Record<string, number>;
}

export function computeStricterRuleRequestStats(rows: EventRow[]): StricterRuleRequestStats {
  const decreaseCountByUser: Record<string, number> = {};

  for (const row of rows) {
    if (!row.userId) continue;
    decreaseCountByUser[row.userId] = (decreaseCountByUser[row.userId] ?? 0) + 1;
  }

  return { totalDecreaseCount: rows.length, decreaseCountByUser };
}

export async function getStricterRuleRequestStats(executor: DatabaseExecutor = getDb()): Promise<StricterRuleRequestStats> {
  const rows = await loadEventsByType([EVENT_LIMIT_DECREASED], executor);
  return computeStricterRuleRequestStats(rows);
}

// ---------------------------------------------------------------------------
// Addition beyond the plan's own table (not in the original mapping — Phase 8 shipped these
// three event types after this plan was written): repeated loosening desire despite the
// timelock/throttle friction. Mirrors "requests for stricter rules" above, in the opposite
// direction — `limit_increase_attempted` counts every attempt (not just the ones that landed
// a pending row), `edit_rate_limited` is only ever written once the throttle itself fired,
// and `limit_increase_voided` is the audit trail for a stale increase the system caught.
// ---------------------------------------------------------------------------

export interface RepeatedLooseningAttemptStats {
  totalAttemptCount: number;
  totalVoidedCount: number;
  totalRateLimitedCount: number;
  repeatedAttemptUserCount: number;
}

/** A user counts as "repeatedly" wanting to loosen once they've made ≥2 attempts, or ever tripped the throttle (which itself only fires past a repeat threshold — see `constitution/rate-limit.ts`). */
const REPEATED_ATTEMPT_THRESHOLD = 2;

export function computeRepeatedLooseningAttemptStats(rows: EventRow[]): RepeatedLooseningAttemptStats {
  const attemptCountByUser = new Map<string, number>();
  const rateLimitedUsers = new Set<string>();
  let totalAttemptCount = 0;
  let totalVoidedCount = 0;
  let totalRateLimitedCount = 0;

  for (const row of rows) {
    switch (row.eventType) {
      case EVENT_LIMIT_INCREASE_ATTEMPTED:
        totalAttemptCount += 1;
        if (row.userId) attemptCountByUser.set(row.userId, (attemptCountByUser.get(row.userId) ?? 0) + 1);
        break;
      case EVENT_LIMIT_INCREASE_VOIDED:
        totalVoidedCount += 1;
        break;
      case EVENT_EDIT_RATE_LIMITED:
        totalRateLimitedCount += 1;
        if (row.userId) rateLimitedUsers.add(row.userId);
        break;
      default:
        break;
    }
  }

  const repeatedAttemptUsers = new Set(rateLimitedUsers);

  for (const [userId, count] of attemptCountByUser) {
    if (count >= REPEATED_ATTEMPT_THRESHOLD) repeatedAttemptUsers.add(userId);
  }

  return { totalAttemptCount, totalVoidedCount, totalRateLimitedCount, repeatedAttemptUserCount: repeatedAttemptUsers.size };
}

export async function getRepeatedLooseningAttemptStats(executor: DatabaseExecutor = getDb()): Promise<RepeatedLooseningAttemptStats> {
  const rows = await loadEventsByType([EVENT_LIMIT_INCREASE_ATTEMPTED, EVENT_LIMIT_INCREASE_VOIDED, EVENT_EDIT_RATE_LIMITED], executor);
  return computeRepeatedLooseningAttemptStats(rows);
}

// ---------------------------------------------------------------------------
// The killer signal: not computable — captured qualitatively via `server/feedback/feedback.ts`
// and reviewed manually, per the plan's own explicit call-out. `recentFeedback` below is the
// raw, opaque text list this page renders for that manual review; it is never scored or summarized here.
// ---------------------------------------------------------------------------

export interface MetricsSnapshot {
  generatedAt: string;
  onboarding: OnboardingCompletionStats;
  limitsSet: LimitsSetStats;
  activation: ActivationConversionStats;
  returnVisits: ReturnVisitStats;
  rulesKept: RulesKeptStats;
  externalViolations: ExternalViolationFrequencyComparison[];
  stricterRuleRequests: StricterRuleRequestStats;
  repeatedLooseningAttempts: RepeatedLooseningAttemptStats;
  recentFeedback: FeedbackSubmission[];
}

/** The one function both `GET /api/admin/metrics` and `/admin/metrics` render from, so the two can never drift — same shape as `server/dashboard/dashboard-state.ts`'s `buildDashboardState`. */
export async function buildMetricsSnapshot(now: Date = new Date(), executor: DatabaseExecutor = getDb()): Promise<MetricsSnapshot> {
  const [onboarding, limitsSet, activation, returnVisits, rulesKept, externalViolations, stricterRuleRequests, repeatedLooseningAttempts, recentFeedback] =
    await Promise.all([
      getOnboardingCompletionStats(executor),
      getLimitsSetStats(executor),
      getActivationConversionStats(executor),
      getReturnVisitStats(now, executor),
      getRulesKeptStats(executor),
      getExternalViolationFrequencyForAllUsers(now, executor),
      getStricterRuleRequestStats(executor),
      getRepeatedLooseningAttemptStats(executor),
      listRecentFeedback(executor),
    ]);

  return {
    generatedAt: now.toISOString(),
    onboarding,
    limitsSet,
    activation,
    returnVisits,
    rulesKept,
    externalViolations,
    stricterRuleRequests,
    repeatedLooseningAttempts,
    recentFeedback,
  };
}
