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

/** UTC calendar day, used for cohorting and for the return-visit window below — display-only precision, not a Postgres `now()`-gated deadline like the commitment window. */
function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * `rolling_loss_usd` is excluded from every violation count in this file that compares live
 * against the baseline counterfactual: a baseline trade can never be loss-limit-eligible
 * (`lot-matching.ts` requires both legs of a close to be after activation, which by
 * definition no baseline trade is), so that limit type can only ever read `allow` on the
 * baseline side while live's can genuinely violate — counting it would understate baseline
 * and flatter the product. See `.ai/decisions/baseline-counterfactual-metric.md`. Not used
 * by `getRulesKeptStats`, which is live-only and has no such asymmetry to correct for.
 */
function isComparableViolation(evaluation: LimitEvaluation): boolean {
  return evaluation.verdict === 'violation' && evaluation.type !== 'rolling_loss_usd';
}

// ---------------------------------------------------------------------------
// Onboarding completion: auth.session_created -> constitution.activated, by day cohort
// ---------------------------------------------------------------------------

export interface OnboardingCohortStats {
  sessionUserCount: number;
  activatedUserCount: number;
  rate: number;
}

export interface OnboardingCompletionStats {
  sessionUserCount: number;
  activatedUserCount: number;
  rate: number;
  /** Keyed by the UTC day of each user's *first* `auth.session_created` — did that day's cohort eventually activate, regardless of which day. */
  byDayCohort: Record<string, OnboardingCohortStats>;
}

export function computeOnboardingCompletionStats(rows: EventRow[]): OnboardingCompletionStats {
  const activatedUsers = distinctUserIds(rows.filter((row) => row.eventType === EVENT_CONSTITUTION_ACTIVATED));
  const firstSessionAtByUser = new Map<string, Date>();

  for (const row of rows) {
    if (row.eventType !== EVENT_SESSION_CREATED || !row.userId) continue;

    const existing = firstSessionAtByUser.get(row.userId);
    if (!existing || row.occurredAt.getTime() < existing.getTime()) {
      firstSessionAtByUser.set(row.userId, row.occurredAt);
    }
  }

  const cohortUserIds = new Map<string, { sessionUserIds: Set<string>; activatedUserIds: Set<string> }>();

  for (const [userId, firstSessionAt] of firstSessionAtByUser) {
    const day = dayKey(firstSessionAt);
    const bucket = cohortUserIds.get(day) ?? { sessionUserIds: new Set(), activatedUserIds: new Set() };
    bucket.sessionUserIds.add(userId);
    if (activatedUsers.has(userId)) bucket.activatedUserIds.add(userId);
    cohortUserIds.set(day, bucket);
  }

  const byDayCohort: Record<string, OnboardingCohortStats> = {};
  for (const [day, bucket] of cohortUserIds) {
    byDayCohort[day] = {
      sessionUserCount: bucket.sessionUserIds.size,
      activatedUserCount: bucket.activatedUserIds.size,
      rate: safeRate(bucket.activatedUserIds.size, bucket.sessionUserIds.size),
    };
  }

  return {
    sessionUserCount: firstSessionAtByUser.size,
    activatedUserCount: activatedUsers.size,
    rate: safeRate(activatedUsers.size, firstSessionAtByUser.size),
    byDayCohort,
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

export interface RulesKeptUserStats {
  totalDecidedEvaluations: number;
  allowedCount: number;
  rulesKeptRate: number;
}

export interface RulesKeptStats {
  /** `allow` + `violation` only — `unevaluable` is excluded from the denominator (it's neither kept nor broken, just undecided; e.g. `rolling_loss_usd` with the loss-limit pipeline off). */
  totalDecidedEvaluations: number;
  allowedCount: number;
  unevaluableCount: number;
  rulesKeptRate: number;
  byUser: Record<string, RulesKeptUserStats>;
}

export function computeRulesKeptStats(rows: EventRow[]): RulesKeptStats {
  let totalDecidedEvaluations = 0;
  let allowedCount = 0;
  let unevaluableCount = 0;
  const byUserCounts = new Map<string, { totalDecidedEvaluations: number; allowedCount: number }>();

  for (const row of rows) {
    const userBucket = row.userId ? (byUserCounts.get(row.userId) ?? { totalDecidedEvaluations: 0, allowedCount: 0 }) : null;

    for (const evaluation of extractEvaluations(row.payload)) {
      if (evaluation.verdict === 'unevaluable') {
        unevaluableCount += 1;
        continue;
      }

      totalDecidedEvaluations += 1;
      const allowed = evaluation.verdict === 'allow';
      if (allowed) allowedCount += 1;

      if (userBucket) {
        userBucket.totalDecidedEvaluations += 1;
        if (allowed) userBucket.allowedCount += 1;
      }
    }

    if (row.userId && userBucket) byUserCounts.set(row.userId, userBucket);
  }

  const byUser: Record<string, RulesKeptUserStats> = {};
  for (const [userId, counts] of byUserCounts) {
    byUser[userId] = { ...counts, rulesKeptRate: safeRate(counts.allowedCount, counts.totalDecidedEvaluations) };
  }

  return {
    totalDecidedEvaluations,
    allowedCount,
    unevaluableCount,
    rulesKeptRate: safeRate(allowedCount, totalDecidedEvaluations),
    byUser,
  };
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

export interface BaselineCounterfactualStats {
  violationCount: number;
  /**
   * How many of this comparison's evaluations came back `unevaluable` (weak/missing
   * historical pricing) — surfaced alongside `violationCount` rather than folded into it, so
   * an unqualified violation count never silently understates a baseline that actually just
   * couldn't be judged for lack of data. Excludes `rolling_loss_usd`'s structural exclusion
   * (see `isComparableViolation`) — that is a known, already-labeled seam, not missing data.
   */
  unevaluableCount: number;
}

/**
 * Ad hoc, in-memory only: never stored as `rule.decision_recorded` (that event type is reserved
 * for real live trades — `reconcile-wallet.ts`), never surfaced to the user (decision 9). Sorts
 * defensively rather than trusting caller order, so this stays correct independent of how its
 * rows were fetched.
 *
 * `lossLimitEnabled: true` on every trade regardless of the flag's historical state when the
 * baseline was originally reconciled — this counterfactual asks "would this constitution's
 * limits have caught this activity", not "was the loss-limit pipeline on at backfill time". A
 * trade's `rolling_loss_usd` evaluation is then excluded from the violation check via
 * `isComparableViolation` — see that function's comment for why (a baseline trade's
 * `realizedLossUsd` is always `null`, so this limit type can only ever read `allow` here,
 * which would flatter the product if compared against live's real loss-limit verdicts).
 */
export function computeBaselineCounterfactualViolationCount(constitution: Constitution, baselineTrades: BaselineTradeRow[]): BaselineCounterfactualStats {
  const sorted = [...baselineTrades].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const evaluable: EvaluableTrade[] = sorted.map((trade) => ({ ...trade, lossLimitEnabled: true }));

  let violationCount = 0;
  let unevaluableCount = 0;

  for (let index = 0; index < evaluable.length; index += 1) {
    const priorTrades = evaluable.slice(0, index);
    const decision = evaluateTrade(constitution, priorTrades, evaluable[index]!);

    if (decision.evaluations.some(isComparableViolation)) {
      violationCount += 1;
    }

    unevaluableCount += decision.evaluations.filter((evaluation) => evaluation.verdict === 'unevaluable' && evaluation.type !== 'rolling_loss_usd').length;
  }

  return { violationCount, unevaluableCount };
}

/**
 * The 90-day pre-activation backfill (decision 9) — a fixed collection window, not something
 * measured from where a user's trades happened to fall. Previously this denominator was the
 * span between a user's *first and last* baseline trade, which understated the window for
 * anyone whose baseline activity was clustered (inflating their counterfactual rate) and
 * collapsed to `0` for a user with 0 or 1 baseline trades — neither is comparable to live's
 * denominator (calendar weeks since activation, unaffected by how trades cluster). Using the
 * same fixed 90 days for every user makes both sides genuinely comparable. A wallet connected
 * less than 90 days before activation still divides by this same fixed window — a reviewed,
 * accepted skew that only ever *dilutes* (never inflates) that wallet's own counterfactual
 * rate, left as-is; `baselineActualSpanDays` below exists so the number can still be read
 * correctly rather than trusted as "the same kind of 90 days" for every wallet.
 */
const BASELINE_WINDOW_DAYS = 90;
const BASELINE_WINDOW_WEEKS = BASELINE_WINDOW_DAYS / 7;

/** A floor under `liveWeeksElapsed` so a just-activated user's rate is never computed against a literal `0` — `safeRate`'s zero-denominator guard would otherwise silently report `0/week` even if a violation happened in the very first hour, which reads as "clean" rather than "not enough time has passed". One hour is short enough to never meaningfully distort an established user's rate. */
const MIN_WEEKS_ELAPSED = 1 / (24 * 7);

/**
 * Informational only — never fed into `baselineViolationsPerWeek`'s denominator (see
 * `BASELINE_WINDOW_WEEKS`'s comment for why that stays fixed). This is "how many days of
 * baseline activity do we actually have for this wallet", so a reader can tell a wallet with
 * a full 90 days of history apart from one connected only a week before activating — both get
 * the same fixed denominator, but they are not equally well-supported numbers. `0` for 0 or 1
 * baseline trades (no span to measure), the same "not enough data" convention this file's
 * other helpers use rather than a negative or `NaN`.
 */
function computeBaselineActualSpanDays(baselineTrades: { occurredAt: Date }[]): number {
  if (baselineTrades.length < 2) return 0;

  const sorted = [...baselineTrades].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const first = sorted[0]!.occurredAt.getTime();
  const last = sorted[sorted.length - 1]!.occurredAt.getTime();

  return (last - first) / (24 * 60 * 60 * 1_000);
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

/** Mirrors `computeBaselineCounterfactualViolationCount`'s `isComparableViolation` filter — see that comment for why `rolling_loss_usd` is excluded on both sides of this comparison. */
function countViolationEvents(rows: LiveViolationEventRow[]): number {
  let count = 0;

  for (const row of rows) {
    if (extractEvaluations(row.payload).some(isComparableViolation)) {
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
  /** Evaluations the baseline counterfactual couldn't judge (weak/missing pricing) — a nonzero count here means `baselineViolationCount` is a floor, not an exact figure. */
  baselineUnevaluableCount: number;
  /** Always `BASELINE_WINDOW_WEEKS` (90 days) — the fixed collection window, not measured from trade timestamps. See the constant's comment. */
  baselineWindowWeeks: number;
  /** How many days of baseline trades this wallet actually has, informational only — see `computeBaselineActualSpanDays`. */
  baselineActualSpanDays: number;
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
  const liveWeeksElapsed = Math.max(MIN_WEEKS_ELAPSED, (now.getTime() - activatedAt.getTime()) / WEEK_MS);
  const { violationCount: baselineViolationCount, unevaluableCount: baselineUnevaluableCount } = computeBaselineCounterfactualViolationCount(
    constitution,
    baselineTrades,
  );

  return {
    userId,
    liveViolationCount,
    liveWeeksElapsed,
    liveViolationsPerWeek: safeRate(liveViolationCount, liveWeeksElapsed),
    baselineViolationCount,
    baselineUnevaluableCount,
    baselineWindowWeeks: BASELINE_WINDOW_WEEKS,
    baselineActualSpanDays: computeBaselineActualSpanDays(baselineTrades),
    baselineViolationsPerWeek: safeRate(baselineViolationCount, BASELINE_WINDOW_WEEKS),
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
