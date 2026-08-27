import type { Constitution, LimitId, LimitRule } from './constitution';

/**
 * The rule engine's decision function — pure, I/O-free, same invariant as the rest of this
 * package (`src/index.ts`). Phase 4 implements only `daily_notional_usd`; every other
 * `LimitRule.type` a stored constitution may already contain (the union was defined whole
 * up front — `.ai/decisions/constitution-schema.md`) evaluates to `unevaluable` rather than
 * being silently skipped or silently allowed. Phases 5/6 add their cases to this same file.
 */

/** The minimal shape `evaluateTrade` needs from a persisted or proposed trade. */
export interface EvaluableTrade {
  occurredAt: Date;
  /** Never `0` for an unpriceable trade — `null` fails the limit closed (CLAUDE.md). */
  usdValue: string | null;
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

function evaluateLimit(limit: LimitRule, windowedHistory: EvaluableTrade[], trade: EvaluableTrade): LimitEvaluation {
  switch (limit.type) {
    case 'daily_notional_usd':
      return evaluateDailyNotional(limit, windowedHistory, trade);

    // Phases 5/6 add cases here. Until then, fail closed rather than silently allow.
    case 'asset_tier_acquisition_usd':
    case 'rolling_loss_usd':
      return unevaluable(limit, 'limit_type_not_yet_implemented');

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
