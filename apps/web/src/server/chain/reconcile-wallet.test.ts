import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ReconcileRejected, reconcileWallet } from './reconcile-wallet';

const {
  resolveSessionMock,
  getTransactionsForAddressMock,
  deriveSwapFromTransactionMock,
  priceTradeMock,
  loadWindowedTradesMock,
  recordEventMock,
  captureErrorMock,
  selectMock,
  updateMock,
  transactionMock,
} = vi.hoisted(() => ({
  resolveSessionMock: vi.fn(),
  getTransactionsForAddressMock: vi.fn(),
  deriveSwapFromTransactionMock: vi.fn(),
  priceTradeMock: vi.fn(),
  loadWindowedTradesMock: vi.fn(),
  recordEventMock: vi.fn(),
  captureErrorMock: vi.fn(),
  selectMock: vi.fn(),
  updateMock: vi.fn(),
  transactionMock: vi.fn(),
}));

vi.mock('../auth/session', () => ({ resolveSession: resolveSessionMock }));
vi.mock('./helius-client', () => ({ getTransactionsForAddress: getTransactionsForAddressMock }));
vi.mock('./derive-swaps', () => ({ deriveSwapFromTransaction: deriveSwapFromTransactionMock }));
vi.mock('../pricing/price-trade', () => ({ priceTrade: priceTradeMock }));
vi.mock('../rules/rolling-allowance', () => ({ loadWindowedTrades: loadWindowedTradesMock }));
vi.mock('../../observability/events', () => ({ recordEvent: recordEventMock }));
vi.mock('../../observability/error-tracking', () => ({ captureError: captureErrorMock }));
vi.mock('../db/client', () => ({
  getDb: () => ({ select: selectMock, update: updateMock, transaction: transactionMock }),
}));

const pgDialect = new PgDialect();

const WALLET_ID = 'wallet-1';
const WALLET_ADDRESS = 'WaLLeT1111111111111111111111111111111111111';
const USER_ID = 'user-1';

function session() {
  return { walletId: WALLET_ID, walletAddress: WALLET_ADDRESS, userId: USER_ID, expiresAt: new Date(), idHash: 'h' };
}

/** A minimal fake Helius transaction — its shape is opaque here, `deriveSwapFromTransaction` is mocked. */
function heliusTx(signature: string, slot: number) {
  return { slot, transactionIndex: 0, blockTime: 1_000, transaction: { signatures: [signature], message: { accountKeys: [] } }, meta: {} } as never;
}

function derivedSwap(signature: string, slot: number, overrides: Record<string, unknown> = {}) {
  return {
    signature,
    slot,
    transactionIndex: 0,
    occurredAt: new Date('2026-08-26T12:00:00Z'),
    excludedReason: null,
    soldMint: 'USDC',
    boughtMint: 'BONK',
    soldAmountBaseUnits: '1000000',
    boughtAmountBaseUnits: '500000',
    soldDecimals: 6,
    boughtDecimals: 5,
    ...overrides,
  };
}

/**
 * A shared, mutable fake `wallets` row plus a signature-deduplicating `trades` table —
 * enough to exercise reconcile-wallet.ts's real logic (cursor-advance SQL, ON CONFLICT
 * dedup, row-lock acquisition per batch) without a real database.
 */
/** Well past any test trade's `usdValue`, so evaluation resolves `allow` and `rule.decision_recorded` actually fires. */
function activeConstitutionRow() {
  return {
    status: 'active',
    document: { schemaVersion: 1, limits: [{ id: 'limit-1', type: 'daily_notional_usd', maxUsd: '1000000', windowHours: 24 }] },
  };
}

function fakeDatabase(
  initial: { reconciledThroughSlot: number | null; reconciliationState: string } = { reconciledThroughSlot: null, reconciliationState: 'never' },
  { hasActiveConstitution = true }: { hasActiveConstitution?: boolean } = {},
) {
  const wallet = { ...initial };
  const persistedSignatures = new Set<string>();
  const lockCalls: string[] = [];
  const cursorAdvanceSetCalls: unknown[] = [];

  // `loadWalletReconciliationInfo` selects a *projection* (an object arg to `.select()`);
  // `loadActiveConstitution` selects the whole row (`.select()`, no arg) — that's the only
  // reliable way this mock can tell the two queries apart without inspecting `.from(...)`.
  selectMock.mockImplementation((projection?: unknown) => ({
    from: () => ({
      where: () => ({
        limit: async () =>
          projection
            ? [{ reconciledThroughSlot: wallet.reconciledThroughSlot, reconciliationState: wallet.reconciliationState }]
            : hasActiveConstitution
              ? [activeConstitutionRow()]
              : [],
      }),
    }),
  }));

  updateMock.mockImplementation(() => ({
    set: (values: { reconciliationState?: string }) => ({
      where: async () => {
        if (values.reconciliationState) {
          wallet.reconciliationState = values.reconciliationState;
        }
        return undefined;
      },
    }),
  }));

  function tx() {
    return {
      select: () => ({
        from: () => ({
          where: () => ({
            for: () => {
              lockCalls.push('locked');
              return { limit: async () => [{}] };
            },
          }),
        }),
      }),
      insert: () => ({
        values: (row: { signature: string; slot: number }) => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              if (persistedSignatures.has(row.signature)) {
                return [];
              }
              persistedSignatures.add(row.signature);
              return [{ id: row.signature }];
            },
          }),
        }),
      }),
      update: () => ({
        set: (values: unknown) => {
          cursorAdvanceSetCalls.push(values);
          return { where: async () => undefined };
        },
      }),
    };
  }

  transactionMock.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback(tx()));

  return { wallet, persistedSignatures, lockCalls, cursorAdvanceSetCalls };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveSessionMock.mockResolvedValue(session());
  priceTradeMock.mockResolvedValue({ usdValue: '10', priceSource: 'stablecoin' });
  loadWindowedTradesMock.mockResolvedValue([]);
  deriveSwapFromTransactionMock.mockImplementation((tx: { transaction: { signatures: string[] }; slot: number }) =>
    derivedSwap(tx.transaction.signatures[0]!, tx.slot),
  );
});

describe('reconcileWallet', () => {
  it('rejects with no session, never touching Helius', async () => {
    resolveSessionMock.mockResolvedValue(null);

    await expect(reconcileWallet('cid-1')).rejects.toThrow(ReconcileRejected);
    expect(getTransactionsForAddressMock).not.toHaveBeenCalled();
  });

  it('resolves the wallet from the session alone — reconcileWallet takes no wallet parameter', async () => {
    fakeDatabase();
    getTransactionsForAddressMock.mockResolvedValue([]);

    await reconcileWallet('cid-2');

    expect(getTransactionsForAddressMock).toHaveBeenCalledWith(WALLET_ADDRESS, expect.anything());
  });

  it('tags trades is_baseline on first connect and never evaluates or excludes them as live', async () => {
    fakeDatabase({ reconciledThroughSlot: null, reconciliationState: 'never' });
    getTransactionsForAddressMock.mockResolvedValue([heliusTx('sig-a', 100)]);

    const result = await reconcileWallet('cid-3');

    expect(result.isBaseline).toBe(true);
    expect(recordEventMock).not.toHaveBeenCalledWith(expect.objectContaining({ eventType: 'trade.excluded' }), expect.anything());
    expect(recordEventMock).not.toHaveBeenCalledWith(expect.objectContaining({ eventType: 'rule.decision_recorded' }), expect.anything());
    expect(recordEventMock).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'wallet.backfill_started' }));
    expect(recordEventMock).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'wallet.backfill_completed' }));
  });

  it('does not re-run the baseline forever when the first run finds zero transactions', async () => {
    const { wallet } = fakeDatabase({ reconciledThroughSlot: null, reconciliationState: 'never' });
    getTransactionsForAddressMock.mockResolvedValue([]);

    const first = await reconcileWallet('cid-4a');
    expect(first.isBaseline).toBe(true);
    expect(wallet.reconciliationState).toBe('current');

    // The cursor is still null (nothing was ever found), but state is no longer 'never'.
    const second = await reconcileWallet('cid-4b');
    expect(second.isBaseline).toBe(false);
  });

  it('re-running over the same range does not double-insert — the unique signature constraint is honored', async () => {
    const { persistedSignatures } = fakeDatabase({ reconciledThroughSlot: 50, reconciliationState: 'current' });
    getTransactionsForAddressMock.mockResolvedValue([heliusTx('sig-dup', 100)]);

    const firstRun = await reconcileWallet('cid-5a');
    expect(firstRun.tradesPersisted).toBe(1);
    expect(persistedSignatures.size).toBe(1);

    const secondRun = await reconcileWallet('cid-5b');
    expect(secondRun.tradesPersisted).toBe(0); // ON CONFLICT DO NOTHING — already there
    expect(persistedSignatures.size).toBe(1); // still exactly one row
  });

  it('advances the cursor via GREATEST(...) so a concurrent run can never move it backward', async () => {
    const { cursorAdvanceSetCalls } = fakeDatabase({ reconciledThroughSlot: 50, reconciliationState: 'current' });
    getTransactionsForAddressMock.mockResolvedValue([heliusTx('sig-cursor', 100)]);

    await reconcileWallet('cid-cursor');

    expect(cursorAdvanceSetCalls).toHaveLength(1);
    const values = cursorAdvanceSetCalls[0] as { reconciledThroughSlot: unknown };
    const { sql: renderedSql } = pgDialect.sqlToQuery(values.reconciledThroughSlot as Parameters<PgDialect['sqlToQuery']>[0]);
    expect(renderedSql.toLowerCase()).toContain('greatest');
    expect(renderedSql.toLowerCase()).toContain('coalesce');
  });

  it("records trade.excluded, not rule.decision_recorded, for a live run's excluded trade", async () => {
    fakeDatabase({ reconciledThroughSlot: 50, reconciliationState: 'current' });
    getTransactionsForAddressMock.mockResolvedValue([heliusTx('sig-live', 100)]);
    deriveSwapFromTransactionMock.mockReturnValueOnce(
      derivedSwap('sig-live', 100, { excludedReason: 'pure_receive', soldMint: null, soldAmountBaseUnits: null, soldDecimals: null }),
    );

    await reconcileWallet('cid-6');

    expect(recordEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'trade.excluded', payload: expect.objectContaining({ reason: 'pure_receive' }) }),
      expect.anything(),
    );
    expect(recordEventMock).not.toHaveBeenCalledWith(expect.objectContaining({ eventType: 'rule.decision_recorded' }), expect.anything());
    expect(priceTradeMock).not.toHaveBeenCalled();
  });

  /**
   * 101 trades forces two persistence batches (`PERSIST_BATCH_SIZE` is 100). Only the
   * 101st (alone in batch two) fails, so batch one's 100 trades — each already committed
   * in its own transaction — must still be there afterward, and the wallet must read
   * `failed`, never a false `current`.
   */
  it('marks reconciliation_state failed, not current, on a mid-run failure, and preserves an earlier batch\'s progress', async () => {
    const { wallet, persistedSignatures } = fakeDatabase({ reconciledThroughSlot: 50, reconciliationState: 'current' });

    const signatures = Array.from({ length: 101 }, (_, index) => `sig-${index}`);
    getTransactionsForAddressMock.mockResolvedValue(signatures.map((sig, index) => heliusTx(sig, 100 + index)));

    recordEventMock.mockImplementation(async (input: { eventType: string; payload?: { signature?: string } }) => {
      if (input.eventType === 'rule.decision_recorded' && input.payload?.signature === 'sig-100') {
        throw new Error('boom');
      }
    });

    await expect(reconcileWallet('cid-7')).rejects.toThrow('boom');

    expect(wallet.reconciliationState).toBe('failed');
    // Batch one (sig-0..sig-99) fully committed before batch two ever started.
    expect(persistedSignatures.has('sig-0')).toBe(true);
    expect(persistedSignatures.has('sig-99')).toBe(true);
  });

  it('serializes two concurrent reconciliation runs via the row lock and produces no duplicate trades', async () => {
    const { persistedSignatures, lockCalls } = fakeDatabase({ reconciledThroughSlot: 50, reconciliationState: 'current' });
    getTransactionsForAddressMock.mockResolvedValue([heliusTx('sig-race', 100)]);

    const [a, b] = await Promise.all([reconcileWallet('cid-8a'), reconcileWallet('cid-8b')]);

    // Every batch acquired the lock (both runs' single-page transactions each did).
    expect(lockCalls.length).toBeGreaterThanOrEqual(2);
    // No duplicate: exactly one of the two runs actually persisted the trade.
    expect(a.tradesPersisted + b.tradesPersisted).toBe(1);
    expect(persistedSignatures.size).toBe(1);
  });
});
