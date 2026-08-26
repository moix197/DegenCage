import { evaluateTrade, migrateConstitution, type Constitution } from '@degencage/rules';
import { eq, sql } from 'drizzle-orm';

import { captureError } from '../../observability/error-tracking';
import { recordEvent, type DatabaseExecutor } from '../../observability/events';
import { logger } from '../../observability/logger';
import { resolveSession } from '../auth/session';
import { getDb } from '../db/client';
import { constitutions, trades, wallets, type NewTradeRow, type ReconciliationState } from '../db/schema';
import { deriveSwapFromTransaction, type DerivedSwap } from './derive-swaps';
import { getTransactionsForAddress, type HeliusTransaction } from './helius-client';
import { priceTrade } from '../pricing/price-trade';
import { loadWindowedTrades } from '../rules/rolling-allowance';

/**
 * Orchestrates one wallet's reconciliation: pull (Helius) → derive (swap heuristic) →
 * price (SOL/stablecoin leg) → evaluate (`daily_notional_usd` only) → persist, one page at
 * a time, each page in its own row-locked transaction.
 *
 * First connect (`reconciled_through_slot IS NULL`) pulls the 90-day baseline
 * (decision 9) and tags every row `is_baseline: true`; those rows are never passed to
 * `evaluateTrade()` and never emit `trade.excluded`/`rule.decision_recorded` — a private
 * behavioral record, not live enforcement. Subsequent runs are incremental from the cursor.
 *
 * Wallet identity always comes from `resolveSession()` — no function below this line takes
 * a wallet id as a parameter from anything a caller supplies.
 */

/** Gates the route that triggers reconciliation (`app/api/wallet/reconcile/route.ts`) — checked there, same as every other route-level kill switch in this codebase. */
export const CHAIN_HELIUS_RECONCILE_FLAG = 'chain.helius_reconcile';

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
  reconciliationState: ReconciliationState;
}

async function loadWalletReconciliationInfo(walletId: string): Promise<WalletReconciliationInfo> {
  const rows = await getDb()
    .select({ reconciledThroughSlot: wallets.reconciledThroughSlot, reconciliationState: wallets.reconciliationState })
    .from(wallets)
    .where(eq(wallets.id, walletId))
    .limit(1);

  const row = rows[0];

  if (!row) {
    throw new Error(`wallet ${walletId} not found`);
  }

  return row;
}

async function loadActiveConstitution(userId: string): Promise<Constitution | null> {
  const rows = await getDb().select().from(constitutions).where(eq(constitutions.userId, userId)).limit(1);
  const row = rows[0];

  return row && row.status === 'active' ? migrateConstitution(row.document) : null;
}

function maxWindowHours(constitution: Constitution): number {
  return constitution.limits.reduce((max, limit) => Math.max(max, limit.windowHours), DEFAULT_WINDOW_HOURS);
}

async function setReconciliationState(walletId: string, state: 'in_progress' | 'current' | 'failed'): Promise<void> {
  await getDb().update(wallets).set({ reconciliationState: state }).where(eq(wallets.id, walletId));
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

function toNewTradeRow(walletId: string, swap: DerivedSwap, priced: { usdValue: string | null; priceSource: string | null }, isBaseline: boolean): NewTradeRow {
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
  };
}

/**
 * Persists one derived swap and, for a live (non-baseline) real trade, evaluates and
 * records its decision — inside `tx`, so it commits atomically with everything else in
 * this page.
 *
 * The windowed history is read *before* this trade is inserted, so it can never include
 * itself (see `loadWindowedTrades`'s exclusive upper bound). `ON CONFLICT (signature) DO
 * NOTHING` returning no row means this exact trade was already persisted by an earlier or
 * concurrent run — skip both the exclusion event and re-evaluation so a re-run never
 * double-records anything.
 */
async function persistOneSwap(
  tx: DatabaseExecutor,
  walletId: string,
  constitution: Constitution | null,
  userId: string,
  correlationId: string,
  swap: DerivedSwap,
  isBaseline: boolean,
): Promise<{ tradePersisted: boolean; excludedPersisted: boolean }> {
  const priced =
    swap.excludedReason === null
      ? await priceTrade({
          soldMint: swap.soldMint!,
          boughtMint: swap.boughtMint!,
          soldAmountBaseUnits: swap.soldAmountBaseUnits!,
          boughtAmountBaseUnits: swap.boughtAmountBaseUnits!,
          soldDecimals: swap.soldDecimals!,
          boughtDecimals: swap.boughtDecimals!,
          occurredAt: swap.occurredAt,
        })
      : { usdValue: null, priceSource: null };

  const windowedHistory =
    !isBaseline && constitution && swap.excludedReason === null
      ? await loadWindowedTrades({ walletId, windowHours: maxWindowHours(constitution), asOf: swap.occurredAt }, tx)
      : [];

  const inserted = await tx
    .insert(trades)
    .values(toNewTradeRow(walletId, swap, priced, isBaseline))
    .onConflictDoNothing()
    .returning({ id: trades.id });

  if (inserted.length === 0) {
    return { tradePersisted: false, excludedPersisted: false };
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

  if (constitution) {
    const decision = evaluateTrade(constitution, windowedHistory, { occurredAt: swap.occurredAt, usdValue: priced.usdValue });

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

/** One row-locked transaction per batch — the row lock (`SELECT ... FOR UPDATE`) is what serializes concurrent reconciliation runs' writes against this wallet. */
async function persistBatch(
  walletId: string,
  constitution: Constitution | null,
  userId: string,
  correlationId: string,
  batch: DerivedSwap[],
  isBaseline: boolean,
): Promise<BatchResult> {
  return getDb().transaction(async (tx) => {
    await tx.select().from(wallets).where(eq(wallets.id, walletId)).for('update').limit(1);

    let tradesPersisted = 0;
    let excludedPersisted = 0;

    for (const swap of batch) {
      const result = await persistOneSwap(tx, walletId, constitution, userId, correlationId, swap, isBaseline);
      tradesPersisted += result.tradePersisted ? 1 : 0;
      excludedPersisted += result.excludedPersisted ? 1 : 0;
    }

    const highestSlot = Math.max(...batch.map((swap) => swap.slot));

    // GREATEST, not a blind SET: a concurrent run's batch may have already advanced the
    // cursor past this batch's own highest slot, and the cursor must never move backward.
    await tx
      .update(wallets)
      .set({ reconciledThroughSlot: sql`GREATEST(COALESCE(${wallets.reconciledThroughSlot}, 0), ${highestSlot})` })
      .where(eq(wallets.id, walletId));

    return { tradesPersisted, excludedPersisted, highestSlot };
  });
}

async function runReconciliation(
  walletId: string,
  walletAddress: string,
  userId: string,
  correlationId: string,
): Promise<ReconcileResult> {
  const info = await loadWalletReconciliationInfo(walletId);
  const cursor = info.reconciledThroughSlot;
  // First-ever run, decided by state, never by the cursor alone: a baseline run that finds
  // zero transactions leaves the cursor null too, and re-deriving "is this the first run"
  // from a still-null cursor on the *next* open would re-run the 90-day backfill forever.
  const isBaseline = info.reconciliationState === 'never';
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

  const constitution = isBaseline ? null : await loadActiveConstitution(userId);

  let tradesPersisted = 0;
  let excludedPersisted = 0;
  let reconciledThroughSlot = cursor;

  try {
    for (const batch of chunk(derivedInOrder, PERSIST_BATCH_SIZE)) {
      const result = await persistBatch(walletId, constitution, userId, correlationId, batch, isBaseline);
      tradesPersisted += result.tradesPersisted;
      excludedPersisted += result.excludedPersisted;
      reconciledThroughSlot = Math.max(reconciledThroughSlot ?? 0, result.highestSlot);
    }
  } catch (error) {
    await failReconciliation(walletId, userId, correlationId, error);
    throw error;
  }

  await setReconciliationState(walletId, 'current');

  await recordEvent({
    eventType: isBaseline ? 'wallet.backfill_completed' : 'wallet.reconciliation_completed',
    occurredAt: new Date(),
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
