import { sumTradeUsd } from '@degencage/rules';
import { and, eq, gte, inArray, lt, lte, ne, sql } from 'drizzle-orm';

import { recordEvent, type DatabaseExecutor } from '../../observability/events';
import { logger } from '../../observability/logger';
import { getDb, type Database } from '../db/client';
import { QUOTE_SLOT_STATUSES, RESERVING_TRADE_INTENT_STATUSES, tradeIntents, trades, wallets } from '../db/schema';
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
 *
 * `QUOTE_SLOT_STATUSES` and `RESERVING_TRADE_INTENT_STATUSES` (`server/db/schema.ts`) are two
 * deliberately different sets — see that file's doc comment. Confusing them was the Phase 4
 * review's blocking finding: a `submitted` trade must keep reserving allowance long after it
 * has stopped occupying the wallet's quote slot.
 */

/** Guarded, unconditional `UPDATE ... SET status = 'expired'` for every row of `walletId` currently occupying the quote slot — no `expires_at` guard. Returns the ids expired. */
async function expireAllLive(walletId: string, executor: DatabaseExecutor): Promise<string[]> {
  const expired = await executor
    .update(tradeIntents)
    .set({ status: 'expired' })
    .where(and(eq(tradeIntents.walletId, walletId), inArray(tradeIntents.status, [...QUOTE_SLOT_STATUSES])))
    .returning({ id: tradeIntents.id });

  return expired.map((row) => row.id);
}

/**
 * Time-based reaping only: guarded `UPDATE ... WHERE ... AND expires_at <= now() RETURNING id`,
 * restricted to `QUOTE_SLOT_STATUSES` — a `signed`/`submitted` intent is never reaped here, no
 * matter how stale its blockhash-derived `expires_at` looks, since only Phase 5's reconciliation
 * gets to resolve one of those. Called inline from two places (no scheduled-job infrastructure
 * exists in this repo, matching `challenge-reaper.ts`'s convention): the top of
 * `quote-service.ts`'s `createQuote`, and from `loadLiveIntentUsd` below, so a live-intent sum
 * is never taken against a row whose wall-clock expiry has silently passed but whose `status`
 * hasn't caught up yet.
 *
 * @returns The ids reaped.
 */
export async function reapExpiredIntents(
  walletId: string,
  correlationId: string,
  userId: string | null,
  executor: DatabaseExecutor = getDb(),
): Promise<string[]> {
  const reaped = await executor
    .update(tradeIntents)
    .set({ status: 'expired' })
    .where(
      and(
        eq(tradeIntents.walletId, walletId),
        inArray(tradeIntents.status, [...QUOTE_SLOT_STATUSES]),
        lte(tradeIntents.expiresAt, sql`now()`),
      ),
    )
    .returning({ id: tradeIntents.id });

  if (reaped.length > 0) {
    logger.info('expired trade intents reaped', { walletId, reaped: reaped.length });

    for (const row of reaped) {
      // Same event `expireLiveIntentsForSwitchedWallet` (`server/auth/session.ts`) records for
      // an account-switch expiry — the plan's Kill switch section lists `trade.intent_expired`
      // unconditionally, not just for the new-quote path in `persistIntent`.
      await recordEvent(
        {
          eventType: 'trade.intent_expired',
          occurredAt: new Date(),
          correlationId,
          userId,
          payload: { intentId: row.id, walletId, reason: 'quote_ttl_expired' },
        },
        executor,
      );
    }
  }

  return reaped.map((row) => row.id);
}

/**
 * Unconditionally expires the wallet's quote-slot occupant (`QUOTE_SLOT_STATUSES`) — the
 * account-switch path (`server/auth/session.ts`'s `revokeSessionByIdHash`). Unlike
 * `reapExpiredIntents`, this carries no `expires_at` guard: the wallet is no longer the one
 * connected, so an unsigned quote must not survive the switch even if the blockhash it was
 * quoted against has not technically expired yet.
 *
 * Deliberately does not touch `signed`/`submitted`: a broadcast trade for the old wallet keeps
 * reserving allowance across the switch until Phase 5 reconciliation resolves it — killing that
 * reservation on switch would let the same broadcast trade be double-spent against next.
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
 * `RESERVING_TRADE_INTENT_STATUSES` (`schema.ts`), not `QUOTE_SLOT_STATUSES`: a `signed`/
 * `submitted` intent no longer occupies the wallet's quote slot but must still reserve until
 * reconciliation resolves it — the other half of the Phase 4 review's blocking finding.
 *
 * `isAcquisition`/`acquiredTier` are carried through onto every entry — a swap always acquires
 * exactly one tier (`quote-service.ts`'s `evaluateQuote`), so a live intent is unconditionally
 * an acquisition. Dropping these here (as a prior version did) left `asset_tier_acquisition_usd`
 * reserving nothing at all against a live intent.
 *
 * @param excludeIntentId - Omit this intent id from its own reservation. Submit-time
 *   re-evaluation (`submit-service.ts`) passes the intent being submitted here: by the time it
 *   reaches `signed` it is, by construction, the wallet's only live row (the partial unique
 *   index guarantees at most one), so without this it would always find itself and self-block —
 *   the exact hazard the code review after Phase 3 flagged. Quote-time creation
 *   (`quote-service.ts`) passes the wallet's current `findLiveQuoteSlotIntentId` result: the row
 *   this very quote is about to expire and replace, which must not be judged as reserving
 *   against itself either (the Phase 4 review's other blocking finding).
 */
export async function loadLiveIntentUsd(
  walletId: string,
  windowHours: number,
  asOf: Date,
  correlationId: string,
  userId: string | null,
  executor: DatabaseExecutor = getDb(),
  excludeIntentId?: string,
): Promise<LiveIntentReservation> {
  await reapExpiredIntents(walletId, correlationId, userId, executor);

  const windowStart = new Date(asOf.getTime() - windowHours * 60 * 60 * 1_000);

  const rows = await executor
    .select({
      id: tradeIntents.id,
      usdValue: tradeIntents.usdValue,
      createdAt: tradeIntents.createdAt,
      signature: tradeIntents.signature,
      acquiredTier: tradeIntents.acquiredTier,
    })
    .from(tradeIntents)
    .where(
      and(
        eq(tradeIntents.walletId, walletId),
        inArray(tradeIntents.status, [...RESERVING_TRADE_INTENT_STATUSES]),
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
    .map((row) => ({ occurredAt: row.createdAt, usdValue: row.usdValue, isAcquisition: true, acquiredTier: row.acquiredTier }));

  return { entries, totalUsd: sumTradeUsd(entries) };
}

/**
 * The id of the wallet's current quote-slot occupant (`QUOTE_SLOT_STATUSES`: `quoted`/
 * `approved`), if any — the row this very quote request is about to expire and replace via
 * `expireAndReserveLiveIntent` (decision 3: "requesting a new quote expires the wallet's prior
 * live intent"). `quote-service.ts` excludes this id from its pre-persist evaluation so a
 * debounced re-quote is never judged against the reservation it is itself about to destroy —
 * without this, the same request could block, then succeed on immediate retry once the stale
 * intent had actually expired, recording a spurious `blocked` intent along the way.
 *
 * Never returns a `signed`/`submitted` id: a new quote does not touch those (`QUOTE_SLOT_STATUSES`
 * excludes them), so they must keep reserving against this evaluation, not be excluded from it.
 */
export async function findLiveQuoteSlotIntentId(walletId: string, executor: DatabaseExecutor = getDb()): Promise<string | null> {
  const rows = await executor
    .select({ id: tradeIntents.id })
    .from(tradeIntents)
    .where(and(eq(tradeIntents.walletId, walletId), inArray(tradeIntents.status, [...QUOTE_SLOT_STATUSES])));

  return rows[0]?.id ?? null;
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
  correlationId: string,
  userId: string | null,
  executor: DatabaseExecutor = getDb(),
  excludeIntentId?: string,
): Promise<WindowedTrade[]> {
  const persisted = await loadWindowedTrades({ walletId, windowHours, asOf }, executor);
  const live = await loadLiveIntentUsd(walletId, windowHours, asOf, correlationId, userId, executor, excludeIntentId);

  return [...persisted, ...live.entries];
}

/**
 * The terminal's status poll (Phase 5): the one read behind `GET /api/swap/intent/[id]`.
 *
 * Scoped by `wallet_id` in the query itself rather than fetched-then-checked, so an intent
 * belonging to another wallet is indistinguishable from one that does not exist — the caller
 * cannot use a 404-vs-403 difference to probe for other users' intent ids. Decision 13's
 * wallet-binding, applied to the read path.
 *
 * `expiresAt` rides alongside `status`/`signature` (BLOCKING 1's fix) so the route can decide,
 * without a second query, whether a `submitted`/`signed` intent it just read is stranded past
 * its own blockhash grace period (`reconcile-wallet.ts`'s `isStrandedSubmittedIntent`) and
 * worth an inline resolution attempt before answering the poll.
 */
export async function loadIntentStatusForWallet(
  intentId: string,
  walletId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<{ status: string; signature: string | null; expiresAt: Date } | null> {
  const [row] = await executor
    .select({ status: tradeIntents.status, signature: tradeIntents.signature, expiresAt: tradeIntents.expiresAt })
    .from(tradeIntents)
    .where(and(eq(tradeIntents.id, intentId), eq(tradeIntents.walletId, walletId)))
    .limit(1);

  return row ?? null;
}
