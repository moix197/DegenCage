import type { AssetTier, Constitution, LimitId, LimitRule } from './constitution';

/**
 * The rule engine's decision function — pure, I/O-free, same invariant as the rest of this
 * package (`src/index.ts`). Phase 4 implements only `daily_notional_usd`; every other
 * `LimitRule.type` a stored constitution may already contain (the union was defined whole
 * up front — `.ai/decisions/constitution-schema.md`) evaluates to `unevaluable` rather than
 * being silently skipped or silently allowed. Phase 5 adds `asset_tier_acquisition_usd`;
 * Phase 6 adds `rolling_loss_usd` to this same file.
 */

/** The minimal shape `evaluateTrade` needs from a persisted or proposed trade. */
export interface EvaluableTrade {
  occurredAt: Date;
  /** Never `0` for an unpriceable trade — `null` fails the limit closed (CLAUDE.md). */
  usdValue: string | null;
  /**
   * Whether this trade is the BUY side of a swap. Disposals never consume a tier's
   * acquisition allowance regardless of amount (decision 6) — optional/undefined is treated
   * as `false`, so callers that only ever evaluate `daily_notional_usd` (Phase 4's tests)
   * need not supply it.
   */
  isAcquisition?: boolean;
  /** The market-cap tier this trade acquired, stamped at classification time. Only meaningful when `isAcquisition` is true. */
  acquiredTier?: AssetTier | null;
  /**
   * Whether this trade's disposal leg closed against ≥1 existing FIFO lot
   * (`server/chain/lot-matching.ts`) — a "close", independent of loss-limit eligibility.
   * Optional/undefined is treated as `false`, so Phase 4/5 callers that never evaluate
   * `rolling_loss_usd` need not supply it.
   */
  isRoundTripClose?: boolean;
  /**
   * Realized P&L in USD, negative is a loss — only meaningful when `isRoundTripClose` is
   * true. `null` whenever the close is not loss-limit-eligible (decision 1's partial
   * coverage: a pre-activation lot, a pre-activation close, an unmatched disposal, or an
   * unpriced leg) — a deliberate scope boundary, not missing data, so unlike an unpriced
   * `daily_notional_usd` trade this does not fail the whole limit closed (see
   * `evaluateRollingLoss` below).
   */
  realizedLossUsd?: string | null;
}

export type LimitVerdict = 'allow' | 'violation' | 'unevaluable';

export interface LimitEvaluation {
  limitId: LimitId;
  type: LimitRule['type'];
  verdict: LimitVerdict;
  maxUsd: string;
  windowHours: number;
  /** Sum of `windowedHistory`'s `usdValue`, excluding the trade being evaluated. `null` when unevaluable. */
  priorUsd: string | null;
  /** `priorUsd` plus the trade's own `usdValue`, compared against `maxUsd`. `null` when unevaluable. */
  totalUsd: string | null;
  reason: string;
}

export interface Decision {
  evaluations: LimitEvaluation[];
}

/**
 * Splits a decimal digit string into sign/integer/fraction parts. Callers in this module
 * only ever pass non-negative USD amounts (a trade's `usdValue` and a limit's `maxUsd` are
 * both proven positive/non-negative before they reach here), so this does not need to
 * support subtraction — only addition and comparison.
 */
function splitDecimal(value: string): { intPart: string; fracPart: string } {
  const [intPart, fracPart = ''] = value.split('.');
  return { intPart: intPart || '0', fracPart };
}

/** Exact decimal-string addition via `BigInt` on a shared scale — never a float. */
export function addUsd(a: string, b: string): string {
  const da = splitDecimal(a);
  const db = splitDecimal(b);
  const scale = Math.max(da.fracPart.length, db.fracPart.length);
  const bigA = BigInt(da.intPart + da.fracPart.padEnd(scale, '0'));
  const bigB = BigInt(db.intPart + db.fracPart.padEnd(scale, '0'));
  const sum = (bigA + bigB).toString().padStart(scale + 1, '0');
  const intResult = sum.slice(0, sum.length - scale) || '0';
  const fracResult = scale > 0 ? sum.slice(sum.length - scale) : '';
  return scale > 0 ? `${intResult}.${fracResult}` : intResult;
}

/** Exact decimal-string comparison via `BigInt` on a shared scale — never a float. */
export function compareUsd(a: string, b: string): -1 | 0 | 1 {
  const da = splitDecimal(a);
  const db = splitDecimal(b);
  const scale = Math.max(da.fracPart.length, db.fracPart.length);
  const bigA = BigInt(da.intPart + da.fracPart.padEnd(scale, '0'));
  const bigB = BigInt(db.intPart + db.fracPart.padEnd(scale, '0'));

  if (bigA < bigB) return -1;
  if (bigA > bigB) return 1;
  return 0;
}

function unevaluable(limit: LimitRule, reason: string): LimitEvaluation {
  return {
    limitId: limit.id,
    type: limit.type,
    verdict: 'unevaluable',
    maxUsd: limit.maxUsd,
    windowHours: limit.windowHours,
    priorUsd: null,
    totalUsd: null,
    reason,
  };
}

/**
 * Sums `trades`' `usdValue`. Returns `null` (never `0`) the moment any trade in the window
 * is unpriced — a limit cannot be honestly compared against a total that is known to be an
 * undercount, and CLAUDE.md forbids ever showing a false "$0 spent today".
 *
 * Exported and imported as-is by `server/rules/rolling-allowance.ts`'s
 * `computeRollingAllowance` — the same "sum usd_value, null propagates" logic, needed both
 * here (a limit's prior-window total) and there (the status page's live total). One
 * implementation, not two.
 */
export function sumTradeUsd(trades: EvaluableTrade[]): string | null {
  let total = '0';

  for (const trade of trades) {
    if (trade.usdValue === null) {
      return null;
    }

    total = addUsd(total, trade.usdValue);
  }

  return total;
}

/**
 * `windowedHistory` may be wider than one limit's own `windowHours` (the caller supplies
 * one shared list for every limit on the constitution), so each limit re-filters to its own
 * window from `trade.occurredAt` rather than trusting the caller's cutoff exactly.
 */
function withinWindow(windowedHistory: EvaluableTrade[], windowHours: number, asOf: Date): EvaluableTrade[] {
  const windowStart = asOf.getTime() - windowHours * 60 * 60 * 1_000;

  return windowedHistory.filter((trade) => trade.occurredAt.getTime() >= windowStart);
}

function evaluateDailyNotional(
  limit: LimitRule & { type: 'daily_notional_usd' },
  windowedHistory: EvaluableTrade[],
  trade: EvaluableTrade,
): LimitEvaluation {
  if (trade.usdValue === null) {
    return unevaluable(limit, 'trade_unpriced');
  }

  const priorUsd = sumTradeUsd(withinWindow(windowedHistory, limit.windowHours, trade.occurredAt));

  if (priorUsd === null) {
    return unevaluable(limit, 'history_contains_unpriced_trade');
  }

  const totalUsd = addUsd(priorUsd, trade.usdValue);
  const verdict: LimitVerdict = compareUsd(totalUsd, limit.maxUsd) > 0 ? 'violation' : 'allow';

  return {
    limitId: limit.id,
    type: 'daily_notional_usd',
    verdict,
    maxUsd: limit.maxUsd,
    windowHours: limit.windowHours,
    priorUsd,
    totalUsd,
    reason: verdict === 'violation' ? 'exceeds_daily_notional_limit' : 'within_daily_notional_limit',
  };
}

/** True only for the BUY side into exactly `tier` — the sole thing this limit ever counts (decision 6). */
function isQualifyingAcquisition(trade: EvaluableTrade, tier: AssetTier): boolean {
  return trade.isAcquisition === true && trade.acquiredTier === tier;
}

function evaluateAssetTierAcquisition(
  limit: LimitRule & { type: 'asset_tier_acquisition_usd' },
  windowedHistory: EvaluableTrade[],
  trade: EvaluableTrade,
): LimitEvaluation {
  const qualifyingHistory = withinWindow(windowedHistory, limit.windowHours, trade.occurredAt).filter((historyTrade) =>
    isQualifyingAcquisition(historyTrade, limit.tier),
  );

  // A disposal, or an acquisition into a different tier, never consumes this allowance —
  // regardless of its own price, so an unpriced non-qualifying trade must not fail this
  // limit closed the way it would `daily_notional_usd`.
  if (!isQualifyingAcquisition(trade, limit.tier)) {
    const priorUsd = sumTradeUsd(qualifyingHistory);

    return {
      limitId: limit.id,
      type: 'asset_tier_acquisition_usd',
      verdict: 'allow',
      maxUsd: limit.maxUsd,
      windowHours: limit.windowHours,
      priorUsd,
      totalUsd: priorUsd,
      reason: 'not_an_acquisition_into_this_tier',
    };
  }

  if (trade.usdValue === null) {
    return unevaluable(limit, 'trade_unpriced');
  }

  const priorUsd = sumTradeUsd(qualifyingHistory);

  if (priorUsd === null) {
    return unevaluable(limit, 'history_contains_unpriced_trade');
  }

  const totalUsd = addUsd(priorUsd, trade.usdValue);
  const verdict: LimitVerdict = compareUsd(totalUsd, limit.maxUsd) > 0 ? 'violation' : 'allow';

  return {
    limitId: limit.id,
    type: 'asset_tier_acquisition_usd',
    verdict,
    maxUsd: limit.maxUsd,
    windowHours: limit.windowHours,
    priorUsd,
    totalUsd,
    reason: verdict === 'violation' ? 'exceeds_asset_tier_acquisition_limit' : 'within_asset_tier_acquisition_limit',
  };
}

/** `true` for a decimal string with a leading `-` and at least one non-zero digit — never confuses `"-0.00"` (which cannot occur here; see `lot-matching.ts`) with a real negative. */
function isNegativeUsd(value: string): boolean {
  return value.startsWith('-') && /[1-9]/.test(value);
}

/** Strips a leading `-`. Only ever called on a value already known negative (`isNegativeUsd`), so the sign is always present. */
function absUsd(value: string): string {
  return value.slice(1);
}

/** A round-trip close whose realized P&L is both known and a loss — the only rows `rolling_loss_usd` ever counts. */
function isRealizedLossClose(trade: EvaluableTrade): trade is EvaluableTrade & { realizedLossUsd: string } {
  return trade.isRoundTripClose === true && typeof trade.realizedLossUsd === 'string' && isNegativeUsd(trade.realizedLossUsd);
}

/**
 * Sums the *magnitude* of realized losses across round-trip closes in `trades` — gains, non-
 * closes, and `null` `realizedLossUsd` (decision 1's partial-coverage exclusions, or an
 * unpriced leg) never contribute. Unlike `sumTradeUsd`, this never returns `null`: those
 * exclusions are a deliberate scope boundary the UI discloses plainly (this phase's success
 * criteria), not missing information that must fail the limit closed.
 *
 * Exported so `app/constitution-status/page.tsx` reuses this exact sum for the loss-
 * allowance display rather than reimplementing the sign/magnitude filter — same reuse
 * pattern as `sumTradeUsd` and `rolling-allowance.ts`.
 */
export function sumRealizedLosses(trades: EvaluableTrade[]): string {
  return trades.filter(isRealizedLossClose).reduce((total, trade) => addUsd(total, absUsd(trade.realizedLossUsd)), '0');
}

function evaluateRollingLoss(
  limit: LimitRule & { type: 'rolling_loss_usd' },
  windowedHistory: EvaluableTrade[],
  trade: EvaluableTrade,
): LimitEvaluation {
  const windowed = withinWindow(windowedHistory, limit.windowHours, trade.occurredAt);
  const priorUsd = sumRealizedLosses(windowed);
  const totalUsd = isRealizedLossClose(trade) ? addUsd(priorUsd, absUsd(trade.realizedLossUsd)) : priorUsd;
  const verdict: LimitVerdict = compareUsd(totalUsd, limit.maxUsd) > 0 ? 'violation' : 'allow';

  return {
    limitId: limit.id,
    type: 'rolling_loss_usd',
    verdict,
    maxUsd: limit.maxUsd,
    windowHours: limit.windowHours,
    priorUsd,
    totalUsd,
    reason: verdict === 'violation' ? 'exceeds_rolling_loss_limit' : 'within_rolling_loss_limit',
  };
}

function evaluateLimit(limit: LimitRule, windowedHistory: EvaluableTrade[], trade: EvaluableTrade): LimitEvaluation {
  switch (limit.type) {
    case 'daily_notional_usd':
      return evaluateDailyNotional(limit, windowedHistory, trade);

    case 'asset_tier_acquisition_usd':
      return evaluateAssetTierAcquisition(limit, windowedHistory, trade);

    case 'rolling_loss_usd':
      return evaluateRollingLoss(limit, windowedHistory, trade);

    default: {
      const exhaustive: never = limit;
      return unevaluable(exhaustive as LimitRule, 'limit_type_not_yet_implemented');
    }
  }
}

/**
 * @param windowedHistory - The wallet's *prior* live (non-baseline) trades already inside
 *   the limit's window — never includes `trade` itself. Built by the caller
 *   (`server/rules/rolling-allowance.ts`); this function does no windowing or I/O of its
 *   own, per `packages/rules`' load-bearing invariant.
 */
export function evaluateTrade(constitution: Constitution, windowedHistory: EvaluableTrade[], trade: EvaluableTrade): Decision {
  return {
    evaluations: constitution.limits.map((limit) => evaluateLimit(limit, windowedHistory, trade)),
  };
}
