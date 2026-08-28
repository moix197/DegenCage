import { sumTradeUsd } from '@degencage/rules';
import { and, eq, gte, inArray, lt, lte, ne, sql } from 'drizzle-orm';

import { type DatabaseExecutor } from '../../observability/events';
import { logger } from '../../observability/logger';
import { getDb, type Database } from '../db/client';
import { LIVE_TRADE_INTENT_STATUSES, tradeIntents, trades, wallets } from '../db/schema';
import { loadWindowedTrades, type WindowedTrade } from '../rules/rolling-allowance';

/**
 * The single-live-intent concurrency guarantee and the allowance it reserves — the two halves
 * the plan's "Single-live-intent concurrency guarantee" / "Active expiry reaping" sections
 * describe, plus the combinator (`loadEvaluableWindowedTrades`) that folds a live reservation
 * into the same `windowedHistory` shape `evaluateTrade` already consumes.
 *
 * `trade_intents` stays append-only, same as every other rule-state table (CLAUDE.md): every
 * expiry here is a guarded `UPDATE ... SET status = 'expired'`, never a `DELETE` — unlike
 * `challenge-reaper.ts`/`login-attempt-reaper.ts`, whose rows carry no product meaning.
 */

/** Guarded, unconditional `UPDATE ... SET status = 'expired'` for every currently-live row of `walletId` — no `expires_at` guard. Returns the ids expired. */
async function expireAllLive(walletId: string, executor: DatabaseExecutor): Promise<string[]> {
  const expired = await executor
    .update(tradeIntents)
    .set({ status: 'expired' })
    .where(and(eq(tradeIntents.walletId, walletId), inArray(tradeIntents.status, [...LIVE_TRADE_INTENT_STATUSES])))
    .returning({ id: tradeIntents.id });

  return expired.map((row) => row.id);
}

/**
 * Time-based reaping only: guarded `UPDATE ... WHERE ... AND expires_at <= now() RETURNING id`.
 * Called inline from two places (no scheduled-job infrastructure exists in this repo, matching
 * `challenge-reaper.ts`'s convention): the top of `quote-service.ts`'s `createQuote`, and from
 * `loadLiveIntentUsd` below, so a live-intent sum is never taken against a row whose wall-clock
 * expiry has silently passed but whose `status` hasn't caught up yet.
 *
 * @returns The ids reaped.
 */
export async function reapExpiredIntents(walletId: string, executor: DatabaseExecutor = getDb()): Promise<string[]> {
  const reaped = await executor
    .update(tradeIntents)
    .set({ status: 'expired' })
    .where(
      and(
        eq(tradeIntents.walletId, walletId),
        inArray(tradeIntents.status, [...LIVE_TRADE_INTENT_STATUSES]),
        lte(tradeIntents.expiresAt, sql`now()`),
      ),
    )
    .returning({ id: tradeIntents.id });

  if (reaped.length > 0) {
    logger.info('expired trade intents reaped', { walletId, reaped: reaped.length });
  }

  return reaped.map((row) => row.id);
}

/**
 * Unconditionally expires every live intent for `walletId` — the account-switch path
 * (`server/auth/session.ts`'s `revokeSessionByIdHash`). Unlike `reapExpiredIntents`, this
 * carries no `expires_at` guard: the wallet is no longer the one connected, so its reservation
 * must not survive the switch even if the blockhash it was quoted against has not technically
 * expired yet.
 *
 * @returns The ids expired, for the caller to record `trade.intent_expired` against.
 */
export async function expireAllLiveIntentsForWallet(walletId: string, executor: DatabaseExecutor = getDb()): Promise<string[]> {
  return expireAllLive(walletId, executor);
}

/**
 * Wallet-row lock → guarded unconditional expire of the prior live intent → the caller's
 * insert, all in one transaction — the belt-and-braces half of the concurrency guarantee (the
 * partial unique index on `trade_intents` is the other). Locking the wallet row first
 * (`SELECT ... FROM wallets WHERE id = $1 FOR UPDATE`, the same convention `reconcile-wallet.ts`
 * already uses) is what serializes two concurrent callers for the same wallet: only one can be
 * mid expire-then-insert at a time, so two concurrent quote requests can never both leave a
 * live row.
 *
 * @param insertFn - Runs inside the same transaction and locked section as the expire, and is
 *   handed the id of the intent that was just expired (`null` when none was live) so the
 *   caller can record `trade.intent_expired` atomically with its own insert.
 * @param executor - The top-level `Database` handle to open the transaction on — defaults to
 *   `getDb()`; a caller passes one explicitly only in tests.
 */
export async function expireAndReserveLiveIntent<T>(
  walletId: string,
  insertFn: (tx: DatabaseExecutor, expiredIntentId: string | null) => Promise<T>,
  executor: Database = getDb(),
): Promise<T> {
  return executor.transaction(async (tx) => {
    await tx.select().from(wallets).where(eq(wallets.id, walletId)).for('update').limit(1);

    const expiredIds = await expireAllLive(walletId, tx);

    if (expiredIds.length > 1) {
      // The partial unique index guarantees at most one live row per wallet — more than one
      // expired here means that invariant did not hold going in. Not fatal (every one of them
      // is legitimately being expired), but worth being loud about rather than silently taking
      // the first.
      logger.warn('more than one live trade intent found for a single wallet', { walletId, count: expiredIds.length });
    }

    return insertFn(tx, expiredIds[0] ?? null);
  });
}

export interface LiveIntentReservation {
  /** Live intents recast as `WindowedTrade`s, ready to concatenate onto `loadWindowedTrades`' own result before calling `evaluateTrade`. */
  entries: WindowedTrade[];
  /** `entries` summed via `sumTradeUsd` (`@degencage/rules`) — `null` the instant any entry is unpriced, same fail-closed rule as everywhere else this sum is taken. */
  totalUsd: string | null;
}

/**
 * The wallet's live-intent reservation inside `(asOf - windowHours, asOf]` — decision 3's
 * "live intents" half of the allowance union. Reaps first (so a silently wall-clock-expired
 * intent is never counted), then excludes any live intent whose `signature` already landed in
 * `trades` (a submitted intent that reconciliation has since pulled in — counting it here too
 * would double it against the allowance).
 *
 * @param excludeIntentId - Omit this intent id from its own reservation. Submit-time
 *   re-evaluation (`submit-service.ts`) passes the intent being submitted here: by the time it
 *   reaches `signed` it is, by construction, the wallet's only live row (the partial unique
 *   index guarantees at most one), so without this it would always find itself and self-block —
 *   the exact hazard the code review after Phase 3 flagged. Quote-time creation has no id yet
 *   and never passes it.
 */
export async function loadLiveIntentUsd(
  walletId: string,
  windowHours: number,
  asOf: Date,
  executor: DatabaseExecutor = getDb(),
  excludeIntentId?: string,
): Promise<LiveIntentReservation> {
  await reapExpiredIntents(walletId, executor);

  const windowStart = new Date(asOf.getTime() - windowHours * 60 * 60 * 1_000);

  const rows = await executor
    .select({
      id: tradeIntents.id,
      usdValue: tradeIntents.usdValue,
      createdAt: tradeIntents.createdAt,
      signature: tradeIntents.signature,
    })
    .from(tradeIntents)
    .where(
      and(
        eq(tradeIntents.walletId, walletId),
        inArray(tradeIntents.status, [...LIVE_TRADE_INTENT_STATUSES]),
        gte(tradeIntents.createdAt, windowStart),
        lt(tradeIntents.createdAt, asOf),
        excludeIntentId ? ne(tradeIntents.id, excludeIntentId) : undefined,
      ),
    );

  const signatures = rows.map((row) => row.signature).filter((signature): signature is string => signature !== null);

  const reconciledSignatures =
    signatures.length === 0
      ? new Set<string>()
      : new Set(
          (
            await executor
              .select({ signature: trades.signature })
              .from(trades)
              .where(and(eq(trades.walletId, walletId), inArray(trades.signature, signatures)))
          ).map((row) => row.signature),
        );

  const entries: WindowedTrade[] = rows
    .filter((row) => row.signature === null || !reconciledSignatures.has(row.signature))
    .map((row) => ({ occurredAt: row.createdAt, usdValue: row.usdValue }));

  return { entries, totalUsd: sumTradeUsd(entries) };
}

/**
 * Decision 3's allowance definition in one call: `loadWindowedTrades` (persisted trades) UNION
 * `loadLiveIntentUsd` (live intents) — so `quote-service.ts` and `submit-service.ts` build the
 * exact same `windowedHistory` for `evaluateTrade` rather than each re-deriving the union
 * (and risking the two drifting apart).
 *
 * Sequential, not `Promise.all`'d: `executor` may be an open transaction, which is one
 * connection — issuing two queries against it concurrently is not safe.
 */
export async function loadEvaluableWindowedTrades(
  walletId: string,
  windowHours: number,
  asOf: Date,
  executor: DatabaseExecutor = getDb(),
  excludeIntentId?: string,
): Promise<WindowedTrade[]> {
  const persisted = await loadWindowedTrades({ walletId, windowHours, asOf }, executor);
  const live = await loadLiveIntentUsd(walletId, windowHours, asOf, executor, excludeIntentId);

  return [...persisted, ...live.entries];
}
