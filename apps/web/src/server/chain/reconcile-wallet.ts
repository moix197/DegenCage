import { evaluateTrade, migrateConstitution, type AssetTier, type Constitution } from '@degencage/rules';
import { and, asc, eq, gt, isNull, lte, sql } from 'drizzle-orm';

import { captureError } from '../../observability/error-tracking';
import { recordEvent, type DatabaseExecutor } from '../../observability/events';
import { logger } from '../../observability/logger';
import { resolveSession } from '../auth/session';
import { getDb } from '../db/client';
import {
  constitutions,
  positionLots,
  trades,
  wallets,
  type NewPositionLotRow,
  type NewTradeRow,
  type PositionLotRow,
  type TokenClassificationQuality,
  type TradeRow,
} from '../db/schema';
import { isFeatureEnabled } from '../flags/feature-flags';
import { classifyTokens, type TokenClassification } from './classify-token';
import { deriveSwapFromTransaction, type DerivedSwap } from './derive-swaps';
import { getTransactionsForAddress, type HeliusTransaction } from './helius-client';
import { matchDisposal, openLot, type DisposalMatchResult, type PositionLot } from './lot-matching';
import { isSolOrLstMint } from './lst-allowlist';
import { isStablecoin } from './stablecoin-mints';
import { priceTrade } from '../pricing/price-trade';
import { loadWindowedTrades } from '../rules/rolling-allowance';

/**
 * Orchestrates one wallet's reconciliation: pull (Helius) → derive (swap heuristic) →
 * price (SOL/stablecoin leg) → evaluate (`daily_notional_usd` only) → persist, one page at
 * a time, each page in its own row-locked transaction.
 *
 * First connect pulls the 90-day baseline (decision 9) and tags every row `is_baseline:
 * true`; those rows are never passed to `evaluateTrade()` and never emit
 * `trade.excluded`/`rule.decision_recorded` — a private behavioral record, not live
 * enforcement. Subsequent runs are incremental from the cursor.
 *
 * "Is this the baseline pull" is decided by `wallets.baseline_completed_at`, not by
 * `reconciliation_state` or the cursor — see `loadWalletReconciliationInfo` for why.
 *
 * Wallet identity always comes from `resolveSession()` — no function below this line takes
 * a wallet id as a parameter from anything a caller supplies.
 */

/** Gates the route that triggers reconciliation (`app/api/wallet/reconcile/route.ts`) — checked there, same as every other route-level kill switch in this codebase. */
export const CHAIN_HELIUS_RECONCILE_FLAG = 'chain.helius_reconcile';

/**
 * Independent of `CHAIN_HELIUS_RECONCILE_FLAG` and the tier/notional pipeline (Phase 5) —
 * gates only `lot-matching.ts`'s wiring below. Off, no `position_lots` are read or written
 * and every trade keeps `is_round_trip_close: false`/`realized_loss_usd: null`, so the
 * highest-arithmetic-risk piece in this plan can be paused on its own if the matching logic
 * needs fixing, without touching daily-notional or tier enforcement.
 */
export const LOSS_LIMIT_ENABLED_FLAG = 'rules.loss_limit_enabled';

const BASELINE_WINDOW_DAYS = 90;
/** Own DB transaction (and row lock) per this many derived swaps, so a long reconciliation never holds one lock for its whole duration and a mid-run failure only rolls back its own page. */
const PERSIST_BATCH_SIZE = 100;
const DEFAULT_WINDOW_HOURS = 24;

export class ReconcileRejected extends Error {
  constructor(readonly reason: 'unauthenticated') {
    super(`reconcile rejected: ${reason}`);
    this.name = 'ReconcileRejected';
  }
}

export interface ReconcileResult {
  walletId: string;
  isBaseline: boolean;
  tradesPersisted: number;
  excludedPersisted: number;
  reconciledThroughSlot: number | null;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

interface WalletReconciliationInfo {
  reconciledThroughSlot: number | null;
  baselineCompletedAt: Date | null;
  /** See the schema comment on `wallets.lots_built_through_slot` — `backfillLotMatching`'s starting point. */
  lotsBuiltThroughSlot: number | null;
}

/**
 * `reconciliation_state` alone cannot answer "has the 90-day baseline ever finished":
 * `in_progress`/`failed` are both reachable mid-baseline, and a failed first run must still
 * be retried *as* a baseline pull — otherwise a Helius outage on first connect (the common
 * failure path) silently reclassifies the backfill as live on retry, feeding pre-commitment
 * history straight into `evaluateTrade()`. `baseline_completed_at` is written exactly once,
 * only on a successful baseline completion, and is the sole source of truth for `isBaseline`.
 */
async function loadWalletReconciliationInfo(walletId: string): Promise<WalletReconciliationInfo> {
  const rows = await getDb()
    .select({
      reconciledThroughSlot: wallets.reconciledThroughSlot,
      baselineCompletedAt: wallets.baselineCompletedAt,
      lotsBuiltThroughSlot: wallets.lotsBuiltThroughSlot,
    })
    .from(wallets)
    .where(eq(wallets.id, walletId))
    .limit(1);

  const row = rows[0];

  if (!row) {
    throw new Error(`wallet ${walletId} not found`);
  }

  return row;
}

interface ActiveConstitutionInfo {
  constitution: Constitution;
  /** `constitutions.activated_at` for the active row — always non-null when `status === 'active'` (`commitment.ts` sets both together). */
  activatedAt: Date;
}

/**
 * `activatedAt` rides alongside `constitution` here rather than a second query: lot-matching
 * needs it to tag `position_lots.opened_after_activation` (decision 1), and both come from
 * the same row.
 */
async function loadActiveConstitutionInfo(userId: string): Promise<ActiveConstitutionInfo | null> {
  const rows = await getDb().select().from(constitutions).where(eq(constitutions.userId, userId)).limit(1);
  const row = rows[0];

  if (!row || row.status !== 'active' || !row.activatedAt) {
    return null;
  }

  return { constitution: migrateConstitution(row.document), activatedAt: row.activatedAt };
}

function maxWindowHours(constitution: Constitution): number {
  return constitution.limits.reduce((max, limit) => Math.max(max, limit.windowHours), DEFAULT_WINDOW_HOURS);
}

async function setReconciliationState(walletId: string, state: 'in_progress' | 'current' | 'failed'): Promise<void> {
  await getDb().update(wallets).set({ reconciliationState: state }).where(eq(wallets.id, walletId));
}

/** Marks the baseline as done, once, on a successful baseline run only — never on a live run and never on failure. */
async function markBaselineCompleted(walletId: string, completedAt: Date): Promise<void> {
  await getDb().update(wallets).set({ baselineCompletedAt: completedAt }).where(eq(wallets.id, walletId));
}

async function failReconciliation(walletId: string, userId: string, correlationId: string, error: unknown): Promise<void> {
  captureError(error, { correlationId, operation: 'reconcileWallet', walletId, failedClosed: true });

  try {
    await setReconciliationState(walletId, 'failed');
    await recordEvent({
      eventType: 'wallet.reconciliation_failed',
      occurredAt: new Date(),
      correlationId,
      userId,
      payload: { walletId, error: error instanceof Error ? error.message : String(error) },
    });
  } catch (secondaryError) {
    // Never let bookkeeping-on-the-way-out mask the original failure or throw past it.
    captureError(secondaryError, { correlationId, operation: 'failReconciliation', walletId });
  }
}

function toNewTradeRow(
  walletId: string,
  swap: DerivedSwap,
  priced: {
    usdValue: string | null;
    priceSource: string | null;
    acquiredTier: AssetTier | null;
    isAcquisition: boolean;
    classification: TokenClassificationQuality | null;
  },
  isBaseline: boolean,
  lotMatch: LotMatchResult | null,
): NewTradeRow {
  return {
    walletId,
    signature: swap.signature,
    slot: swap.slot,
    transactionIndex: swap.transactionIndex,
    occurredAt: swap.occurredAt,
    soldMint: swap.soldMint,
    boughtMint: swap.boughtMint,
    soldAmountBaseUnits: swap.soldAmountBaseUnits,
    boughtAmountBaseUnits: swap.boughtAmountBaseUnits,
    usdValue: priced.usdValue,
    priceSource: priced.priceSource,
    isBaseline,
    excludedReason: swap.excludedReason,
    acquiredTier: priced.acquiredTier,
    isAcquisition: priced.isAcquisition,
    classification: priced.classification,
    isRoundTripClose: lotMatch?.disposal.isRoundTripClose ?? false,
    realizedLossUsd: lotMatch?.disposal.realizedLossUsd ?? null,
  };
}

/** Maps a `position_lots` row to `lot-matching.ts`'s pure `PositionLot` — base units back to `BigInt`, never a float. */
function toPositionLot(row: PositionLotRow): PositionLot {
  return {
    id: row.id,
    mint: row.mint,
    openedAt: row.openedAt,
    openedAfterActivation: row.openedAfterActivation,
    slot: row.slot,
    transactionIndex: row.transactionIndex,
    remainingBaseUnits: BigInt(row.remainingBaseUnits),
    costBasisUsd: row.costBasisUsd,
  };
}

/**
 * This wallet's still-open lots for one mint, in true chronological order (`slot`, then
 * `transaction_index` — see the schema comment on `position_lots` for why `opened_at` alone
 * cannot break a same-second tie). Exhausted lots (`remaining_base_units: 0`) are filtered
 * out in application code rather than a SQL predicate, matching `remaining_base_units`'s
 * `text` convention — lot counts per mint are small in Phase 0's scope.
 */
async function loadOpenLots(tx: DatabaseExecutor, walletId: string, mint: string): Promise<PositionLot[]> {
  const rows = await tx
    .select()
    .from(positionLots)
    .where(and(eq(positionLots.walletId, walletId), eq(positionLots.mint, mint)))
    .orderBy(asc(positionLots.slot), asc(positionLots.transactionIndex));

  return rows.map(toPositionLot).filter((lot) => lot.remainingBaseUnits > 0n);
}

/**
 * SOL, an LST, or a stablecoin — the quote currency, not a "position" whose loss/gain this
 * module tracks. Reuses the same curated lists `derive-swaps.ts`/`classify-token.ts` already
 * maintain rather than a third copy. Exported and unit-tested directly
 * (`reconcile-wallet.test.ts`) — this is the exact predicate that keeps a TOKEN→SOL or
 * TOKEN→USDC swap from opening a SOL/USDC "position" and inflating the realized-loss figure
 * with the quote leg's own price movement.
 */
export function isQuoteMint(mint: string): boolean {
  return isSolOrLstMint(mint) || isStablecoin(mint);
}

function emptyDisposal(): DisposalMatchResult {
  return { consumptions: [], updatedLots: [], isRoundTripClose: false, unmatchedBaseUnits: 0n, realizedLossUsd: null };
}

interface LotMatchInput {
  soldMint: string;
  boughtMint: string;
  soldAmountBaseUnits: string;
  boughtAmountBaseUnits: string;
  occurredAt: Date;
  usdValue: string | null;
  slot: number;
  transactionIndex: number;
}

interface LotMatchResult {
  /** Whether *this* trade — both its disposal and its acquisition leg share one `occurredAt` — falls after the wallet's active constitution's `activated_at`. Decision 1 requires both halves of a round trip after activation; this is that check for the trade currently being persisted. */
  tradeAfterActivation: boolean;
  disposal: DisposalMatchResult;
  /** `null` when `boughtMint` is a quote mint (`isQuoteMint`) — the quote leg of a swap is never itself a tracked position. */
  newLot: Omit<PositionLot, 'id'> | null;
}

/**
 * Computes (but does not yet persist) one trade's FIFO lot effects: draws down `soldMint`'s
 * existing lots and opens a new `boughtMint` lot — skipping either half when that leg is the
 * quote currency (`isQuoteMint`), so a TOKEN→SOL or TOKEN→USDC swap only ever tracks TOKEN,
 * never inflates the loss figure with SOL/USDC "round trips". Read-only against
 * `position_lots`.
 *
 * Reused by both the live pipeline (`persistOneSwap`, from a freshly-derived swap, applied
 * only after confirming via the trade insert's idempotency gate that this trade is genuinely
 * new) and `backfillLotMatchingBatch` (from an already-persisted `trades` row, when
 * `rules.loss_limit_enabled` was off at the time and is only now being turned on).
 */
async function computeLotMatch(tx: DatabaseExecutor, walletId: string, input: LotMatchInput, activatedAt: Date | null): Promise<LotMatchResult> {
  const tradeAfterActivation = activatedAt !== null && input.occurredAt.getTime() > activatedAt.getTime();

  const disposal = isQuoteMint(input.soldMint)
    ? emptyDisposal()
    : matchDisposal(await loadOpenLots(tx, walletId, input.soldMint), BigInt(input.soldAmountBaseUnits), input.usdValue, tradeAfterActivation);

  const newLot = isQuoteMint(input.boughtMint)
    ? null
    : openLot({
        mint: input.boughtMint,
        baseUnits: BigInt(input.boughtAmountBaseUnits),
        costBasisUsd: input.usdValue,
        openedAt: input.occurredAt,
        openedAfterActivation: tradeAfterActivation,
        slot: input.slot,
        transactionIndex: input.transactionIndex,
      });

  return { tradeAfterActivation, disposal, newLot };
}

/** Persists a computed `LotMatchResult`: updates every consumed lot's remaining balance/cost basis, then opens the new lot (when there is one — see `LotMatchResult.newLot`). Only ever called once the owning trade row is confirmed newly inserted or being backfilled. */
async function applyLotMatch(tx: DatabaseExecutor, walletId: string, match: LotMatchResult): Promise<void> {
  for (const consumption of match.disposal.consumptions) {
    const updated = match.disposal.updatedLots.find((candidate) => candidate.id === consumption.lot.id);

    if (!updated) continue;

    await tx
      .update(positionLots)
      .set({ remainingBaseUnits: updated.remainingBaseUnits.toString(), costBasisUsd: updated.costBasisUsd })
      .where(eq(positionLots.id, updated.id));
  }

  if (match.newLot === null) {
    return;
  }

  const newLotRow: NewPositionLotRow = {
    walletId,
    mint: match.newLot.mint,
    openedAt: match.newLot.openedAt,
    openedAfterActivation: match.newLot.openedAfterActivation,
    slot: match.newLot.slot,
    transactionIndex: match.newLot.transactionIndex,
    remainingBaseUnits: match.newLot.remainingBaseUnits.toString(),
    costBasisUsd: match.newLot.costBasisUsd,
  };

  await tx.insert(positionLots).values(newLotRow);
}

/** Shared payload shape for `trade.lot_matched` — used by both the live pipeline and the backfill path so the audit trail looks identical regardless of which one produced it. */
function lotMatchedEventPayload(signature: string, soldMint: string | null, boughtMint: string | null, lotMatch: LotMatchResult) {
  return {
    signature,
    soldMint,
    boughtMint,
    isRoundTripClose: lotMatch.disposal.isRoundTripClose,
    realizedLossUsd: lotMatch.disposal.realizedLossUsd,
    unmatchedBaseUnits: lotMatch.disposal.unmatchedBaseUnits.toString(),
    consumedLotIds: lotMatch.disposal.consumptions.map((consumption) => consumption.lot.id),
    openedAfterActivation: lotMatch.tradeAfterActivation,
  };
}

interface PricedSwap {
  swap: DerivedSwap;
  usdValue: string | null;
  priceSource: string | null;
  /** The market-cap tier of `swap.boughtMint`, or `null` for an excluded candidate. */
  acquiredTier: AssetTier | null;
  /** `true` for every real (non-excluded) swap — see `trades.isAcquisition`'s schema comment. */
  isAcquisition: boolean;
  /** Whether `acquiredTier` is a real mcap read or the fail-closed default; `null` for an excluded candidate. */
  classification: TokenClassificationQuality | null;
}

/**
 * Classifies every distinct `boughtMint` across `batch`'s real (non-excluded) swaps in one
 * pass — one comma-batched Jupiter request per reconcile batch (`classify-token.ts`), not
 * one per trade. Runs for baseline trades too: the status page shows a (clearly labeled,
 * non-contemporaneous) tier badge on backfilled history as well as live trades.
 */
async function classifyBatch(batch: DerivedSwap[]): Promise<Map<string, TokenClassification>> {
  const boughtMints = batch
    .filter((swap) => swap.excludedReason === null && swap.boughtMint !== null)
    .map((swap) => swap.boughtMint!);

  return classifyTokens(boughtMints);
}

/**
 * Prices and classifies every real (non-excluded) swap in `batch` — the slow, external-HTTP
 * part (`priceTrade` calls Binance/Birdeye, `classifyBatch` calls Jupiter, each with its own
 * timeout) — deliberately *outside* any database transaction, so a row lock is never held
 * across a network round trip. `persistBatch` consumes the result and does only DB work
 * under the lock.
 */
async function priceBatch(batch: DerivedSwap[]): Promise<PricedSwap[]> {
  const classifications = await classifyBatch(batch);
  const priced: PricedSwap[] = [];

  for (const swap of batch) {
    if (swap.excludedReason !== null) {
      priced.push({ swap, usdValue: null, priceSource: null, acquiredTier: null, isAcquisition: false, classification: null });
      continue;
    }

    const result = await priceTrade({
      soldMint: swap.soldMint!,
      boughtMint: swap.boughtMint!,
      soldAmountBaseUnits: swap.soldAmountBaseUnits!,
      boughtAmountBaseUnits: swap.boughtAmountBaseUnits!,
      soldDecimals: swap.soldDecimals!,
      boughtDecimals: swap.boughtDecimals!,
      occurredAt: swap.occurredAt,
    });

    // `classifyTokens` returns an entry for every mint it was asked to classify — the
    // fallback here is defensive only, never expected to trigger.
    const classification = classifications.get(swap.boughtMint!) ?? { tier: 'MICRO_CAP' as const, classification: 'unknown' as const };

    priced.push({
      swap,
      usdValue: result.usdValue,
      priceSource: result.priceSource,
      acquiredTier: classification.tier,
      isAcquisition: true,
      classification: classification.classification,
    });
  }

  return priced;
}

/**
 * Persists one already-priced swap and, for a live (non-baseline) real trade, evaluates and
 * records its decision — inside `tx`, so it commits atomically with everything else in
 * this page. Pricing itself already happened in `priceBatch`, before `tx` was opened.
 *
 * The windowed history is read *before* this trade is inserted, so it can never include
 * itself (see `loadWindowedTrades`'s exclusive upper bound). `ON CONFLICT (wallet_id,
 * signature) DO NOTHING` returning no row means this exact trade was already persisted by
 * an earlier or concurrent run — skip both the exclusion event and re-evaluation so a
 * re-run never double-records anything.
 */
async function persistOneSwap(
  tx: DatabaseExecutor,
  walletId: string,
  constitution: Constitution | null,
  activatedAt: Date | null,
  userId: string,
  correlationId: string,
  priced: PricedSwap,
  isBaseline: boolean,
  lossLimitEnabled: boolean,
): Promise<{ tradePersisted: boolean; excludedPersisted: boolean }> {
  const { swap } = priced;
  const isRealTrade = swap.excludedReason === null;

  const windowedHistory =
    !isBaseline && constitution && isRealTrade
      ? await loadWindowedTrades({ walletId, windowHours: maxWindowHours(constitution), asOf: swap.occurredAt }, tx)
      : [];

  // Runs for baseline trades too, same reasoning as classification below: a live disposal
  // years later can only tell a baseline-era acquisition apart from a post-activation one if
  // the baseline acquisition was itself recorded as a lot (see the `position_lots` schema
  // comment). Read-only at this point — nothing is written to `position_lots` until the
  // trade insert below confirms this is not an already-persisted re-run.
  const lotMatch =
    isRealTrade && lossLimitEnabled
      ? await computeLotMatch(
          tx,
          walletId,
          {
            soldMint: swap.soldMint!,
            boughtMint: swap.boughtMint!,
            soldAmountBaseUnits: swap.soldAmountBaseUnits!,
            boughtAmountBaseUnits: swap.boughtAmountBaseUnits!,
            occurredAt: swap.occurredAt,
            usdValue: priced.usdValue,
            slot: swap.slot,
            transactionIndex: swap.transactionIndex,
          },
          activatedAt,
        )
      : null;

  const inserted = await tx
    .insert(trades)
    .values(toNewTradeRow(walletId, swap, priced, isBaseline, lotMatch))
    .onConflictDoNothing({ target: [trades.walletId, trades.signature] })
    .returning({ id: trades.id });

  if (inserted.length === 0) {
    return { tradePersisted: false, excludedPersisted: false };
  }

  if (lotMatch) {
    await applyLotMatch(tx, walletId, lotMatch);
  }

  // Baseline rows are a private behavioral record: no exclusion/decision event of any kind.
  if (isBaseline) {
    return { tradePersisted: true, excludedPersisted: swap.excludedReason !== null };
  }

  if (swap.excludedReason !== null) {
    await recordEvent(
      {
        eventType: 'trade.excluded',
        occurredAt: swap.occurredAt,
        correlationId,
        userId,
        payload: { signature: swap.signature, reason: swap.excludedReason },
      },
      tx,
    );

    return { tradePersisted: false, excludedPersisted: true };
  }

  // Structured audit trail for the classification decision itself (decision 7/17): the tier
  // alone can't be told apart from the fail-closed default without `classification` riding
  // alongside it, on every real live trade, regardless of whether a constitution exists yet.
  await recordEvent(
    {
      eventType: 'trade.classified',
      occurredAt: swap.occurredAt,
      correlationId,
      userId,
      payload: { signature: swap.signature, boughtMint: swap.boughtMint, acquiredTier: priced.acquiredTier, classification: priced.classification },
    },
    tx,
  );

  // Same reasoning as `trade.classified` above: the audit trail (decision 17) needs the
  // derived lot-matching decision on the record, on every real live trade, independent of
  // whether a constitution/`rolling_loss_usd` limit exists yet to evaluate it against.
  if (lotMatch) {
    await recordEvent(
      {
        eventType: 'trade.lot_matched',
        occurredAt: swap.occurredAt,
        correlationId,
        userId,
        payload: lotMatchedEventPayload(swap.signature, swap.soldMint, swap.boughtMint, lotMatch),
      },
      tx,
    );
  }

  if (constitution) {
    const decision = evaluateTrade(constitution, windowedHistory, {
      occurredAt: swap.occurredAt,
      usdValue: priced.usdValue,
      isAcquisition: priced.isAcquisition,
      acquiredTier: priced.acquiredTier,
      isRoundTripClose: lotMatch?.disposal.isRoundTripClose ?? false,
      realizedLossUsd: lotMatch?.disposal.realizedLossUsd ?? null,
      lossLimitEnabled,
    });

    await recordEvent(
      {
        eventType: 'rule.decision_recorded',
        occurredAt: swap.occurredAt,
        correlationId,
        userId,
        payload: { signature: swap.signature, evaluations: decision.evaluations },
      },
      tx,
    );
  }

  return { tradePersisted: true, excludedPersisted: false };
}

interface BatchResult {
  tradesPersisted: number;
  excludedPersisted: number;
  highestSlot: number;
}

/**
 * One row-locked transaction per already-priced batch — the row lock (`SELECT ... FOR
 * UPDATE`) is what serializes concurrent reconciliation runs' writes against this wallet.
 * Everything inside is DB-only (no `priceTrade` HTTP calls — those already happened in
 * `priceBatch`), so the lock is held only as long as the actual writes take.
 */
async function persistBatch(
  walletId: string,
  constitution: Constitution | null,
  activatedAt: Date | null,
  userId: string,
  correlationId: string,
  pricedBatch: PricedSwap[],
  isBaseline: boolean,
  lossLimitEnabled: boolean,
  /**
   * Non-null only for the final batch of a baseline run: folds `baseline_completed_at`
   * into this batch's own cursor-advance UPDATE so the two commit or fail together. A
   * separate statement issued after the transaction commits would leave a window where the
   * cursor has moved but the baseline is still unmarked — a crash there makes the retry
   * misclassify genuinely live trades as baseline (the bug this parameter closes).
   */
  baselineCompletedAt: Date | null,
): Promise<BatchResult> {
  return getDb().transaction(async (tx) => {
    await tx.select().from(wallets).where(eq(wallets.id, walletId)).for('update').limit(1);

    let tradesPersisted = 0;
    let excludedPersisted = 0;

    for (const priced of pricedBatch) {
      const result = await persistOneSwap(tx, walletId, constitution, activatedAt, userId, correlationId, priced, isBaseline, lossLimitEnabled);
      tradesPersisted += result.tradePersisted ? 1 : 0;
      excludedPersisted += result.excludedPersisted ? 1 : 0;
    }

    const highestSlot = Math.max(...pricedBatch.map(({ swap }) => swap.slot));

    // GREATEST, not a blind SET: a concurrent run's batch may have already advanced the
    // cursor past this batch's own highest slot, and the cursor must never move backward.
    // `baselineCompletedAt` (when present) rides in this same statement — same transaction,
    // same UPDATE, so it is all-or-nothing with the cursor advance. `lotsBuiltThroughSlot`
    // rides along too, but *only* when `lossLimitEnabled` — advancing it while the flag is
    // off would falsely claim these trades were lot-matched, hiding the exact gap
    // `backfillLotMatching` exists to close later (see the schema comment on
    // `wallets.lots_built_through_slot`).
    await tx
      .update(wallets)
      .set({
        reconciledThroughSlot: sql`GREATEST(COALESCE(${wallets.reconciledThroughSlot}, 0), ${highestSlot})`,
        ...(baselineCompletedAt ? { baselineCompletedAt } : {}),
        ...(lossLimitEnabled ? { lotsBuiltThroughSlot: sql`GREATEST(COALESCE(${wallets.lotsBuiltThroughSlot}, 0), ${highestSlot})` } : {}),
      })
      .where(eq(wallets.id, walletId));

    return { tradesPersisted, excludedPersisted, highestSlot };
  });
}

/**
 * Already-persisted, real (non-excluded) trades for `walletId` strictly after `afterSlot`
 * (exclusive — `null` means "the beginning") through `throughSlot` (inclusive), in true
 * chronological order — the gap `backfillLotMatching` needs to catch up. Reads from `trades`
 * itself, never Helius: these rows were already reconciled, only never lot-matched.
 */
async function loadUnmatchedTrades(walletId: string, afterSlot: number | null, throughSlot: number): Promise<TradeRow[]> {
  const conditions = [eq(trades.walletId, walletId), isNull(trades.excludedReason), lte(trades.slot, throughSlot)];

  if (afterSlot !== null) {
    conditions.push(gt(trades.slot, afterSlot));
  }

  return getDb()
    .select()
    .from(trades)
    .where(and(...conditions))
    .orderBy(asc(trades.slot), asc(trades.transactionIndex));
}

/**
 * Lot-matches one batch of already-persisted trades and advances `lots_built_through_slot`
 * to the highest slot in the batch — its own row-locked transaction, same shape as
 * `persistBatch`, so a long backfill never holds one lock for its whole duration.
 */
async function backfillLotMatchingBatch(walletId: string, userId: string, correlationId: string, activatedAt: Date | null, batch: TradeRow[]): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.select().from(wallets).where(eq(wallets.id, walletId)).for('update').limit(1);

    let highestSlot = 0;

    for (const tradeRow of batch) {
      highestSlot = Math.max(highestSlot, tradeRow.slot);

      // `loadUnmatchedTrades` only ever selects real (non-excluded) trades, and a real trade
      // always has both legs populated (see the `trades` schema comment) — the `!`s below
      // are as safe as the equivalent ones in `persistOneSwap`.
      const lotMatch = await computeLotMatch(
        tx,
        walletId,
        {
          soldMint: tradeRow.soldMint!,
          boughtMint: tradeRow.boughtMint!,
          soldAmountBaseUnits: tradeRow.soldAmountBaseUnits!,
          boughtAmountBaseUnits: tradeRow.boughtAmountBaseUnits!,
          occurredAt: tradeRow.occurredAt,
          usdValue: tradeRow.usdValue,
          slot: tradeRow.slot,
          transactionIndex: tradeRow.transactionIndex,
        },
        activatedAt,
      );

      await applyLotMatch(tx, walletId, lotMatch);

      await tx
        .update(trades)
        .set({ isRoundTripClose: lotMatch.disposal.isRoundTripClose, realizedLossUsd: lotMatch.disposal.realizedLossUsd })
        .where(eq(trades.id, tradeRow.id));

      // Baseline rows are a private behavioral record: no event, same as everywhere else.
      if (!tradeRow.isBaseline) {
        await recordEvent(
          {
            eventType: 'trade.lot_matched',
            occurredAt: tradeRow.occurredAt,
            correlationId,
            userId,
            payload: lotMatchedEventPayload(tradeRow.signature, tradeRow.soldMint, tradeRow.boughtMint, lotMatch),
          },
          tx,
        );
      }
    }

    await tx
      .update(wallets)
      .set({ lotsBuiltThroughSlot: sql`GREATEST(COALESCE(${wallets.lotsBuiltThroughSlot}, 0), ${highestSlot})` })
      .where(eq(wallets.id, walletId));
  });
}

/**
 * Pure gap-detection, exported and unit-tested directly (`reconcile-wallet.test.ts`) per
 * `.ai/decisions/migration-and-test-tooling.md`'s "DB-touching modules are split into a pure
 * decision function plus a thin query" — `backfillLotMatching` below is the thin, I/O-heavy
 * orchestration around this one true/false call.
 */
export function needsLotBackfill(lotsBuiltThroughSlot: number | null, reconciledThroughSlot: number): boolean {
  return lotsBuiltThroughSlot === null || lotsBuiltThroughSlot < reconciledThroughSlot;
}

/**
 * Closes the gap `wallets.lots_built_through_slot` falling behind `reconciled_through_slot`
 * leaves — `rules.loss_limit_enabled` being off while trades kept reconciling, then later
 * turned on. Reconstructs `position_lots` from the affected trades (in the same true
 * chronological order live matching uses) *before* any new trade in this run is matched
 * against them, so a later disposal is never wrongly ruled eligible against an incomplete
 * lot history. A no-op when there is no gap.
 */
async function backfillLotMatching(
  walletId: string,
  userId: string,
  correlationId: string,
  lotsBuiltThroughSlot: number | null,
  reconciledThroughSlot: number | null,
  activatedAt: Date | null,
): Promise<void> {
  if (reconciledThroughSlot === null) {
    return; // nothing has ever been reconciled for this wallet — nothing to backfill
  }

  if (!needsLotBackfill(lotsBuiltThroughSlot, reconciledThroughSlot)) {
    return; // already caught up
  }

  const unmatched = await loadUnmatchedTrades(walletId, lotsBuiltThroughSlot, reconciledThroughSlot);

  for (const batch of chunk(unmatched, PERSIST_BATCH_SIZE)) {
    await backfillLotMatchingBatch(walletId, userId, correlationId, activatedAt, batch);
  }

  // Clamp all the way to `reconciledThroughSlot` even if the gap's tail was entirely
  // excluded candidates (no real trade there to carry the watermark forward) — otherwise the
  // next run rescans an already-confirmed-empty range forever.
  await getDb()
    .update(wallets)
    .set({ lotsBuiltThroughSlot: sql`GREATEST(COALESCE(${wallets.lotsBuiltThroughSlot}, 0), ${reconciledThroughSlot})` })
    .where(eq(wallets.id, walletId));
}

async function runReconciliation(
  walletId: string,
  walletAddress: string,
  userId: string,
  correlationId: string,
): Promise<ReconcileResult> {
  const info = await loadWalletReconciliationInfo(walletId);
  const cursor = info.reconciledThroughSlot;
  const isBaseline = info.baselineCompletedAt === null;
  const startedAt = new Date();

  await recordEvent({
    eventType: isBaseline ? 'wallet.backfill_started' : 'wallet.reconciliation_started',
    occurredAt: startedAt,
    correlationId,
    userId,
    payload: { walletId },
  });

  await setReconciliationState(walletId, 'in_progress');

  let heliusTransactions: HeliusTransaction[];

  try {
    // The query filter is keyed off the cursor, independent of `isBaseline`: a prior run
    // (baseline or not) that found zero transactions leaves `cursor` null too, and only a
    // time-based filter can resume correctly with no slot to anchor on.
    heliusTransactions = await getTransactionsForAddress(
      walletAddress,
      cursor === null
        ? { sinceUnixSeconds: Math.floor((startedAt.getTime() - BASELINE_WINDOW_DAYS * 24 * 60 * 60 * 1_000) / 1_000) }
        : { minSlot: cursor + 1 },
    );
  } catch (error) {
    await failReconciliation(walletId, userId, correlationId, error);
    throw error;
  }

  const derivedInOrder = heliusTransactions
    .map((tx) => deriveSwapFromTransaction(tx, walletAddress))
    .sort((a, b) => a.slot - b.slot || a.transactionIndex - b.transactionIndex);

  // `activatedAt` is safely `null` for a baseline run without a second, unconditional query:
  // baseline is the 90-day window *before* this wallet was ever connected (decision 9), and
  // with one wallet per user (decision 2) no constitution for this user could have been
  // activated before that wallet existed.
  const activeInfo = isBaseline ? null : await loadActiveConstitutionInfo(userId);
  const constitution = activeInfo?.constitution ?? null;
  const activatedAt = activeInfo?.activatedAt ?? null;
  const lossLimitEnabled = await isFeatureEnabled(LOSS_LIMIT_ENABLED_FLAG);
  const batches = chunk(derivedInOrder, PERSIST_BATCH_SIZE);
  // Computed once, before persistence starts, so the final batch's in-transaction write and
  // this run's completion event agree on exactly when "done" was.
  const completedAt = new Date();

  let tradesPersisted = 0;
  let excludedPersisted = 0;
  let reconciledThroughSlot = cursor;

  try {
    // Must complete before any of *this* run's own new trades are lot-matched below —
    // otherwise a disposal in this very run could draw down the wrong (newer) lot for a mint
    // whose true oldest lot is still sitting unmatched in the gap.
    if (lossLimitEnabled) {
      await backfillLotMatching(walletId, userId, correlationId, info.lotsBuiltThroughSlot, cursor, activatedAt);
    }

    for (let index = 0; index < batches.length; index += 1) {
      const isFinalBatch = index === batches.length - 1;
      const pricedBatch = await priceBatch(batches[index]!);
      const result = await persistBatch(
        walletId,
        constitution,
        activatedAt,
        userId,
        correlationId,
        pricedBatch,
        isBaseline,
        lossLimitEnabled,
        isBaseline && isFinalBatch ? completedAt : null,
      );
      tradesPersisted += result.tradesPersisted;
      excludedPersisted += result.excludedPersisted;
      reconciledThroughSlot = Math.max(reconciledThroughSlot ?? 0, result.highestSlot);
    }
  } catch (error) {
    await failReconciliation(walletId, userId, correlationId, error);
    throw error;
  }

  await setReconciliationState(walletId, 'current');

  // Zero-transaction case: no batch ever ran (an empty backfill, or an incremental run
  // with nothing new), so there was no transaction to fold this write into. A baseline run
  // finding genuinely zero trades still needs to be marked done, or the next open would
  // retry the whole 90-day pull as baseline again.
  if (isBaseline && batches.length === 0) {
    await markBaselineCompleted(walletId, completedAt);
  }

  await recordEvent({
    eventType: isBaseline ? 'wallet.backfill_completed' : 'wallet.reconciliation_completed',
    occurredAt: completedAt,
    correlationId,
    userId,
    payload: { walletId, tradesPersisted, excludedPersisted },
  });

  return { walletId, isBaseline, tradesPersisted, excludedPersisted, reconciledThroughSlot };
}

/** Reconciles the session's own wallet — never a client-supplied wallet id. */
export async function reconcileWallet(correlationId: string): Promise<ReconcileResult> {
  const session = await resolveSession();

  if (!session) {
    throw new ReconcileRejected('unauthenticated');
  }

  logger.info('reconciliation requested', { correlationId, walletId: session.walletId });

  return runReconciliation(session.walletId, session.walletAddress, session.userId, correlationId);
}
