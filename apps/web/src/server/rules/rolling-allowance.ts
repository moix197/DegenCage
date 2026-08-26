import { compareUsd, sumTradeUsd } from '@degencage/rules';
import { and, eq, gte, isNull, lt } from 'drizzle-orm';

import type { DatabaseExecutor } from '../../observability/events';
import { getDb } from '../db/client';
import { trades } from '../db/schema';

/**
 * The generic "sum `usd_value` of a wallet's live trades in the last N hours, compare to a
 * limit" helper. Parameterized by `windowHours` and `mint`/predicate so Phases 5/6 can reuse
 * it for per-tier acquisition windows and the rolling-loss window rather than reimplementing
 * this windowed-sum logic — the `daily_notional_usd` case is the first, not the only, caller.
 *
 * Used two ways: `loadWindowedTrades` builds the `windowedHistory` argument
 * `packages/rules`' `evaluateTrade` needs (`server/chain/reconcile-wallet.ts`), and
 * `computeRollingAllowance` answers "how much of this limit is used right now" for direct
 * display (`app/constitution-status/page.tsx`) without evaluating any specific new trade.
 */

export interface WindowedTrade {
  occurredAt: Date;
  usdValue: string | null;
}

export interface RollingWindowParams {
  walletId: string;
  windowHours: number;
  /** The window is `(asOf - windowHours, asOf]` — a rolling window, never a calendar day (decision 4). */
  asOf: Date;
}

/**
 * Live (non-baseline), excluded-reason-free trades for `walletId` inside the window.
 * Baseline trades are never included — decision 9's private behavioral record must never
 * feed a live allowance figure.
 *
 * `asOf` is an exclusive upper bound: the trade currently being evaluated is never counted
 * as its own prior history, which also matters when several trades share the exact same
 * `occurredAt` (multiple trades landing in the same block only have second-granularity
 * `blockTime`) — `server/chain/reconcile-wallet.ts` relies on this by querying before it
 * persists the trade being evaluated, so this exclusive bound never has to disambiguate
 * same-timestamp trades by anything finer.
 *
 * @param executor - Pass an open transaction to read within it (so a trade persisted
 *   earlier in the same transaction is visible); defaults to the pooled client.
 */
export async function loadWindowedTrades(
  { walletId, windowHours, asOf }: RollingWindowParams,
  executor: DatabaseExecutor = getDb(),
): Promise<WindowedTrade[]> {
  const windowStart = new Date(asOf.getTime() - windowHours * 60 * 60 * 1_000);

  const rows = await executor
    .select({ occurredAt: trades.occurredAt, usdValue: trades.usdValue })
    .from(trades)
    .where(
      and(
        eq(trades.walletId, walletId),
        eq(trades.isBaseline, false),
        isNull(trades.excludedReason),
        gte(trades.occurredAt, windowStart),
        lt(trades.occurredAt, asOf),
      ),
    );

  return rows;
}

/**
 * Sums `usdValue`. `null` (never `0`) the moment any trade in the window is unpriced.
 *
 * A thin re-export of `@degencage/rules`' `sumTradeUsd` under this module's established
 * name — `evaluate.ts` needs the identical logic for a limit's prior-window total, so the
 * summation itself lives there once, not twice.
 */
export function sumWindowedUsd(windowedTrades: WindowedTrade[]): string | null {
  return sumTradeUsd(windowedTrades);
}

export interface RollingAllowance {
  trades: WindowedTrade[];
  totalUsd: string | null;
  maxUsd: string;
  /** `false` when `totalUsd` is `null` — an unknown total is never reported as "within limit". */
  withinLimit: boolean;
}

/** Combinator: the query plus the pure sum, compared against `maxUsd`. */
export async function computeRollingAllowance(
  params: RollingWindowParams & { maxUsd: string },
  executor: DatabaseExecutor = getDb(),
): Promise<RollingAllowance> {
  const windowedTrades = await loadWindowedTrades(params, executor);
  const totalUsd = sumWindowedUsd(windowedTrades);

  return {
    trades: windowedTrades,
    totalUsd,
    maxUsd: params.maxUsd,
    withinLimit: totalUsd !== null && compareUsd(totalUsd, params.maxUsd) <= 0,
  };
}
