import { and, desc, eq, inArray } from 'drizzle-orm';

import { subtractUsd, type AssetTier, type LimitEvaluation, type LimitRule } from '@degencage/rules';
import { getDb } from '../db/client';
import { events, trades } from '../db/schema';

/**
 * The dashboard's "we saw that" feed (Phase 7): turns the `rule.decision_recorded` events
 * `server/chain/reconcile-wallet.ts` already writes on every live trade (Phase 4+) into a
 * chronological list of violations, framed as accountability rather than punishment.
 *
 * No new rule logic and no new event type — this only reads and reshapes what
 * `evaluateTrade()` (`@degencage/rules`) already decided. `rule.decision_recorded` is never
 * written for a baseline trade (`persistOneSwap` returns before recording any event for one
 * — reconcile-wallet.ts), but this module re-checks `trades.is_baseline` by signature
 * anyway rather than trusting that upstream absence: the private behavioral record
 * (decision 9) must never leak into the feed even if that invariant ever moves.
 */

const VIOLATIONS_FEED_LIMIT = 50;

interface DecisionRecordedPayload {
  signature: string;
  evaluations: LimitEvaluation[];
}

/** Fails closed on a malformed payload — skips the event rather than throwing or guessing. */
function readDecisionRecordedPayload(payload: Record<string, unknown>): DecisionRecordedPayload | null {
  if (typeof payload.signature !== 'string' || !Array.isArray(payload.evaluations)) {
    return null;
  }

  return { signature: payload.signature, evaluations: payload.evaluations as LimitEvaluation[] };
}

interface DecisionRecordedEventRow {
  id: string;
  occurredAt: Date;
  correlationId: string;
  payload: Record<string, unknown>;
}

/**
 * `occurredAt` is chain block time — only second-granularity (several trades can land in
 * the same block), so ties are expected, not rare. `desc(events.id)` breaks them
 * deterministically: without a full ORDER BY, Postgres does not guarantee a stable order
 * for equal `occurredAt` values, so two identical queries could otherwise return the same
 * rows in a different order.
 */
async function loadDecisionRecordedEvents(userId: string, limit: number): Promise<DecisionRecordedEventRow[]> {
  return getDb()
    .select({ id: events.id, occurredAt: events.occurredAt, correlationId: events.correlationId, payload: events.payload })
    .from(events)
    .where(and(eq(events.userId, userId), eq(events.eventType, 'rule.decision_recorded')))
    .orderBy(desc(events.occurredAt), desc(events.id))
    .limit(limit);
}

interface TradeLookup {
  isBaseline: boolean;
  acquiredTier: AssetTier | null;
}

/**
 * Keyed by signature: the decision event's payload carries only the signature it was
 * recorded against, so both the baseline check and the tier label ("MICRO_CAP acquisition
 * limit") for `asset_tier_acquisition_usd` come from that same `trades` row.
 */
async function loadTradeLookup(walletId: string, signatures: string[]): Promise<Map<string, TradeLookup>> {
  if (signatures.length === 0) {
    return new Map();
  }

  const rows = await getDb()
    .select({ signature: trades.signature, isBaseline: trades.isBaseline, acquiredTier: trades.acquiredTier })
    .from(trades)
    .where(and(eq(trades.walletId, walletId), inArray(trades.signature, signatures)));

  return new Map(rows.map((row) => [row.signature, { isBaseline: row.isBaseline, acquiredTier: row.acquiredTier }]));
}

const LIMIT_TYPE_LABELS: Record<LimitRule['type'], string> = {
  daily_notional_usd: 'daily notional',
  asset_tier_acquisition_usd: 'asset-tier acquisition',
  rolling_loss_usd: 'rolling loss',
};

/**
 * Accountability framing, not punishment — "we saw that", never "blocked" or "you broke a
 * rule". A tier-specific label (e.g. "MICRO_CAP acquisition") is used when the trade's own
 * `acquiredTier` is known, matching the plan's own example phrasing.
 */
function buildAccountabilityMessage(limitType: LimitRule['type'], totalUsd: string, maxUsd: string, tradeTier: AssetTier | null): string {
  const exceededByUsd = subtractUsd(totalUsd, maxUsd);
  const label = limitType === 'asset_tier_acquisition_usd' && tradeTier ? `${tradeTier} acquisition` : LIMIT_TYPE_LABELS[limitType];

  return `We saw that you exceeded your ${label} limit by $${exceededByUsd}.`;
}

export interface ViolationFeedItem {
  correlationId: string;
  occurredAt: Date;
  limitType: LimitRule['type'];
  maxUsd: string;
  totalUsd: string;
  message: string;
}

/** Narrows `verdict === 'violation'` evaluations to ones whose `totalUsd` is known — the filter and the type live together so `extractViolations` never has to fall back to a placeholder value. */
function isKnownViolation(evaluation: LimitEvaluation): evaluation is LimitEvaluation & { totalUsd: string } {
  return evaluation.verdict === 'violation' && evaluation.totalUsd !== null;
}

/** Carries the source event's id purely for the tie-break in `loadViolationsFeed` below — stripped before the public `ViolationFeedItem` shape is returned. */
type InternalViolation = ViolationFeedItem & { eventId: string };

function extractViolations(row: DecisionRecordedEventRow, tradeTier: AssetTier | null): InternalViolation[] {
  const decoded = readDecisionRecordedPayload(row.payload);

  if (!decoded) {
    return [];
  }

  return decoded.evaluations.filter(isKnownViolation).map((evaluation) => ({
    eventId: row.id,
    correlationId: row.correlationId,
    occurredAt: row.occurredAt,
    limitType: evaluation.type,
    maxUsd: evaluation.maxUsd,
    totalUsd: evaluation.totalUsd,
    message: buildAccountabilityMessage(evaluation.type, evaluation.totalUsd, evaluation.maxUsd, tradeTier),
  }));
}

/** Deterministic tie-break for equal `occurredAt` values — mirrors the query's own `desc(events.id)` tiebreak. */
function compareChronological(a: InternalViolation, b: InternalViolation): number {
  const occurredAtDiff = a.occurredAt.getTime() - b.occurredAt.getTime();

  if (occurredAtDiff !== 0) {
    return occurredAtDiff;
  }

  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

/**
 * The wallet's violations, oldest first (chronological order). Baseline-sourced trades are
 * excluded even if their decision event would otherwise have evaluated to a violation — the
 * `trades.is_baseline` re-check above, not just the fact that `rule.decision_recorded` is
 * never written for one today.
 */
export async function loadViolationsFeed(
  { walletId, userId }: { walletId: string; userId: string },
  limit: number = VIOLATIONS_FEED_LIMIT,
): Promise<ViolationFeedItem[]> {
  const eventRows = await loadDecisionRecordedEvents(userId, limit);
  const signatures = eventRows
    .map((row) => readDecisionRecordedPayload(row.payload)?.signature)
    .filter((signature): signature is string => signature !== undefined);

  const tradeLookup = await loadTradeLookup(walletId, signatures);

  const violations = eventRows.flatMap((row) => {
    const signature = readDecisionRecordedPayload(row.payload)?.signature;
    const trade = signature ? tradeLookup.get(signature) : undefined;

    // No matching (non-baseline) trade row for this wallet — either it belongs to another
    // wallet's decision or it is baseline: either way, fail closed and leave it out.
    if (!trade || trade.isBaseline) {
      return [];
    }

    return extractViolations(row, trade.acquiredTier);
  });

  return violations.sort(compareChronological).map(({ eventId: _eventId, ...item }) => item);
}
