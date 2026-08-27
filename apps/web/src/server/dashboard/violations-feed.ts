import { and, desc, eq, inArray } from 'drizzle-orm';

import type { AssetTier, LimitEvaluation, LimitRule } from '@degencage/rules';
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
  occurredAt: Date;
  correlationId: string;
  payload: Record<string, unknown>;
}

async function loadDecisionRecordedEvents(userId: string, limit: number): Promise<DecisionRecordedEventRow[]> {
  return getDb()
    .select({ occurredAt: events.occurredAt, correlationId: events.correlationId, payload: events.payload })
    .from(events)
    .where(and(eq(events.userId, userId), eq(events.eventType, 'rule.decision_recorded')))
    .orderBy(desc(events.occurredAt))
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

/** Splits a decimal digit string into sign-free integer/fraction parts, same shape `@degencage/rules`' own decimal helpers use. */
function splitDecimal(value: string): { intPart: string; fracPart: string } {
  const [intPart, fracPart = ''] = value.split('.');
  return { intPart: intPart || '0', fracPart };
}

/**
 * Display-only exact-decimal subtraction for the feed's "exceeded by $X" copy — `totalUsd`
 * and `maxUsd` are already-decided figures from the recorded event, not a re-evaluation of
 * whether this was a violation. Local rather than imported: `@degencage/rules` exports
 * `addUsd`/`compareUsd` but no subtraction, since the rule engine itself never needs one.
 */
function subtractUsd(a: string, b: string): string {
  const da = splitDecimal(a);
  const db = splitDecimal(b);
  const scale = Math.max(da.fracPart.length, db.fracPart.length);
  const bigA = BigInt(da.intPart + da.fracPart.padEnd(scale, '0'));
  const bigB = BigInt(db.intPart + db.fracPart.padEnd(scale, '0'));
  const diff = (bigA - bigB).toString().padStart(scale + 1, '0');
  const intResult = diff.slice(0, diff.length - scale) || '0';
  const fracResult = scale > 0 ? diff.slice(diff.length - scale) : '';

  return scale > 0 ? `${intResult}.${fracResult}` : intResult;
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
function buildAccountabilityMessage(evaluation: LimitEvaluation, tradeTier: AssetTier | null): string {
  const exceededByUsd = subtractUsd(evaluation.totalUsd ?? evaluation.maxUsd, evaluation.maxUsd);
  const label =
    evaluation.type === 'asset_tier_acquisition_usd' && tradeTier
      ? `${tradeTier} acquisition`
      : LIMIT_TYPE_LABELS[evaluation.type];

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

function extractViolations(row: DecisionRecordedEventRow, tradeTier: AssetTier | null): ViolationFeedItem[] {
  const decoded = readDecisionRecordedPayload(row.payload);

  if (!decoded) {
    return [];
  }

  return decoded.evaluations
    .filter((evaluation) => evaluation.verdict === 'violation' && evaluation.totalUsd !== null)
    .map((evaluation) => ({
      correlationId: row.correlationId,
      occurredAt: row.occurredAt,
      limitType: evaluation.type,
      maxUsd: evaluation.maxUsd,
      totalUsd: evaluation.totalUsd as string,
      message: buildAccountabilityMessage(evaluation, tradeTier),
    }));
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

  return violations.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
}
