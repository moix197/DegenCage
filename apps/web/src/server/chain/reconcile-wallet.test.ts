import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isAfterLotWatermark,
  isQuoteMint,
  isStrandedSubmittedIntent,
  needsLotBackfill,
  ReconcileRejected,
  reconcileWallet,
} from './reconcile-wallet';
import { WSOL_MINT } from './lst-allowlist';
import { STABLECOIN_MINTS } from './stablecoin-mints';
import { positionLots as positionLotsTable, trades as tradesTable, tradeIntents as tradeIntentsTable, RESERVING_TRADE_INTENT_STATUSES } from '../db/schema';

const {
  resolveSessionMock,
  getTransactionsForAddressMock,
  deriveSwapFromTransactionMock,
  priceTradeMock,
  loadWindowedTradesMock,
  recordEventMock,
  captureErrorMock,
  isFeatureEnabledMock,
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
  isFeatureEnabledMock: vi.fn(),
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
// Explicit now (previously `isFeatureEnabled` was unmocked and happened to resolve `false`
// via a shape mismatch against the `getDb()` mock below — see git history). Explicit lets the
// new flag-on integration tests override it per key.
vi.mock('../flags/feature-flags', () => ({ isFeatureEnabled: isFeatureEnabledMock }));
vi.mock('../db/client', () => ({
  getDb: () => ({ select: selectMock, update: updateMock, transaction: transactionMock }),
}));

const pgDialect = new PgDialect();

/** Renders a captured `.where(...)` condition to real SQL + bound params — same technique `intent-lifecycle.test.ts` uses, and the one the "quote-slot" decision doc requires a mock derive its filtering from, rather than reimplementing the predicate in parallel. */
function whereSql(node: unknown): { sql: string; params: unknown[] } {
  return pgDialect.sqlToQuery(node as Parameters<PgDialect['sqlToQuery']>[0]);
}

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

/** Well past any test trade's `usdValue`, so evaluation resolves `allow` and `rule.decision_recorded` actually fires. */
function activeConstitutionRow() {
  return {
    status: 'active',
    document: { schemaVersion: 1, limits: [{ id: 'limit-1', type: 'daily_notional_usd', maxUsd: '1000000', windowHours: 24 }] },
    // `loadActiveConstitutionInfo` (Phase 6) requires this alongside `status: 'active'` — real
    // rows always have both together (`commitment.ts` sets them in the same UPDATE).
    activatedAt: new Date('2026-08-01T00:00:00Z'),
  };
}

interface WalletFixture {
  reconciledThroughSlot: number | null;
  reconciliationState: string;
  baselineCompletedAt: Date | null;
  // Only load-bearing in the flag-on integration tests below (`describe('reconcileWallet —
  // loss-limit integration (flag on)')`) — every other test in this file leaves
  // `rules.loss_limit_enabled` at its default-mocked `false`, so `backfillLotMatching` never
  // actually runs for them and these two stay `null` harmlessly. `needsLotBackfill` and
  // `isAfterLotWatermark` have their own direct unit tests above regardless.
  lotsBuiltThroughSlot: number | null;
  lotsBuiltThroughTransactionIndex: number | null;
}

/** A loosely-typed stand-in for a `TradeRow` — only the fields this file's mocks and assertions actually touch. */
type FakeTradeRow = Record<string, unknown> & { id: string; signature: string; slot: number; transactionIndex: number };

/** A fake `trade_intents` row for the Phase 5 linkage/sweep fixtures below — only the fields those paths read or write. */
interface FakeIntentRow {
  id: string;
  walletId: string;
  signature: string;
  status: string;
  expiresAt: Date;
}

const NEVER_RECONCILED: WalletFixture = {
  reconciledThroughSlot: null,
  reconciliationState: 'never',
  baselineCompletedAt: null,
  lotsBuiltThroughSlot: null,
  lotsBuiltThroughTransactionIndex: null,
};
const ALREADY_BASELINED: WalletFixture = {
  reconciledThroughSlot: 50,
  reconciliationState: 'current',
  baselineCompletedAt: new Date('2026-08-01T00:00:00Z'),
  lotsBuiltThroughSlot: null,
  lotsBuiltThroughTransactionIndex: null,
};

/**
 * A shared, mutable fake `wallets` row plus a signature-deduplicating `trades` table, and
 * (since the loss-limit fix) a `position_lots` insert/update spy and a fixed
 * `existingTrades` fixture for `loadUnmatchedTrades` — enough to exercise
 * reconcile-wallet.ts's real logic (cursor-advance SQL, ON CONFLICT dedup, row-lock
 * acquisition per batch, `baseline_completed_at` bookkeeping, and — flag on — FIFO lot
 * backfill/live-matching) without a real database.
 *
 * Table identity (`table === positionLotsTable` etc.), not call shape, is what routes each
 * mock branch — the real schema objects are imported unmocked for exactly this comparison.
 */
function fakeDatabase(
  initial: WalletFixture = NEVER_RECONCILED,
  {
    hasActiveConstitution = true,
    failFinalBatchUpdate = false,
    existingTrades = [],
    liveIntents = [],
  }: {
    hasActiveConstitution?: boolean;
    failFinalBatchUpdate?: boolean;
    existingTrades?: FakeTradeRow[];
    /** Phase 5: pre-existing `trade_intents` rows the linkage lookup and the sweep can match against. */
    liveIntents?: FakeIntentRow[];
  } = {},
) {
  const wallet = { ...initial };
  const persistedSignatures = new Set<string>();
  const lockCalls: string[] = [];
  const cursorAdvanceSetCalls: unknown[] = [];
  const conflictTargets: unknown[] = [];
  const positionLotInsertCalls: unknown[] = [];
  const positionLotUpdateCalls: unknown[] = [];
  const tradeUpdateCalls: unknown[] = [];
  const tradeInsertCalls: (Record<string, unknown> & { signature: string })[] = [];
  const intents = liveIntents.map((intent) => ({ ...intent }));
  /** `resolveMatchedIntent`'s guarded transitions, from inside a batch's transaction. */
  const intentResolveCalls: { intentId: string; next: string }[] = [];
  /** `sweepStrandedSubmittedIntents`'s guarded transition, from the top-level (non-transactional) update. */
  const intentSweepCalls: { walletId: string; next: string; sweptIds: string[] }[] = [];
  /** The sweep's guarded UPDATE `WHERE` clause, rendered to SQL text — for the structural shape assertion below. */
  const intentSweepWhereSqlCalls: string[] = [];

  // `loadWalletReconciliationInfo` selects a *projection* (an object arg to `.select()`) from
  // `wallets`; `loadActiveConstitutionInfo` selects the whole row (`.select()`, no arg) from
  // `constitutions` — both still land in the shared branch below, distinguished by
  // `projection`'s presence, same as before. `loadUnmatchedTrades` is new: `.select()` (no
  // arg) from `trades`, with `.orderBy(...)` instead of `.limit(...)` — table identity is the
  // only way to route it correctly since it shares "no projection" with the constitution read.
  selectMock.mockImplementation((projection?: unknown) => ({
    from: (table: unknown) => {
      if (table === tradesTable) {
        return { where: () => ({ orderBy: async () => existingTrades }) };
      }

      return {
        where: () => ({
          limit: async () =>
            projection
              ? [
                  {
                    reconciledThroughSlot: wallet.reconciledThroughSlot,
                    baselineCompletedAt: wallet.baselineCompletedAt,
                    lotsBuiltThroughSlot: wallet.lotsBuiltThroughSlot,
                    lotsBuiltThroughTransactionIndex: wallet.lotsBuiltThroughTransactionIndex,
                  },
                ]
              : hasActiveConstitution
                ? [activeConstitutionRow()]
                : [],
        }),
      };
    },
  }));

  updateMock.mockImplementation((table: unknown) => {
    // Phase 5's sweep: `getDb().update(tradeIntents)...` — top-level, not inside any batch's
    // transaction (a single guarded UPDATE is atomic on its own, same reasoning as
    // `backfillLotMatching`'s final watermark clamp). Filtering is derived from the real
    // exported `isStrandedSubmittedIntent` predicate under test, applied to this fixture's
    // `intents`, rather than reimplementing the grace-period math in parallel here (the exact
    // anti-pattern `.ai/decisions/live-intent-reservation-vs-quote-slot.md`'s mutation-testing
    // finding warns against).
    if (table === tradeIntentsTable) {
      return {
        set: (values: { status: string }) => ({
          where: (condition: unknown) => ({
            returning: async () => {
              const { sql: renderedSql, params } = whereSql(condition);
              intentSweepWhereSqlCalls.push(renderedSql);
              const [queryWalletId, queryStatus] = params as [string, string];
              const now = new Date();
              const swept = intents.filter(
                (intent) => intent.walletId === queryWalletId && intent.status === queryStatus && isStrandedSubmittedIntent(intent.expiresAt, now),
              );

              for (const intent of swept) {
                intent.status = values.status;
              }

              intentSweepCalls.push({ walletId: queryWalletId, next: values.status, sweptIds: swept.map((intent) => intent.id) });

              return swept.map((intent) => ({ id: intent.id }));
            },
          }),
        }),
      };
    }

    return {
      set: (values: { reconciliationState?: string; baselineCompletedAt?: Date }) => ({
        where: async () => {
          if (values.reconciliationState) {
            wallet.reconciliationState = values.reconciliationState;
          }
          if (values.baselineCompletedAt) {
            wallet.baselineCompletedAt = values.baselineCompletedAt;
          }
          return undefined;
        },
      }),
    };
  });

  function tx() {
    return {
      select: () => ({
        from: (table: unknown) => {
          if (table === positionLotsTable) {
            return { where: () => ({ orderBy: async () => [] }) }; // no pre-existing lots needed by any test in this file
          }

          // Phase 5's linkage lookup (`findMatchingLiveIntentId`): the wallet's live
          // (`signed`/`submitted`) intent sharing this exact signature, if any. Filtering is
          // derived from the real WHERE's own bound params (walletId, signature, ...statuses),
          // not reimplemented here — the same technique the "quote-slot" decision's
          // mutation-testing finding requires.
          if (table === tradeIntentsTable) {
            return {
              where: (condition: unknown) => ({
                limit: async () => {
                  const { params } = whereSql(condition);
                  const [queryWalletId, querySignature, ...statuses] = params as string[];
                  return intents
                    .filter((intent) => intent.walletId === queryWalletId && intent.signature === querySignature && statuses.includes(intent.status))
                    .slice(0, 1)
                    .map((intent) => ({ id: intent.id }));
                },
              }),
            };
          }

          // wallets — shared by `persistBatch`'s row-lock-only read (return value ignored)
          // and `backfillLotMatchingBatch`'s fresh watermark read (these two fields matter).
          return {
            where: () => ({
              for: () => {
                lockCalls.push('locked');
                return {
                  limit: async () => [
                    { lotsBuiltThroughSlot: wallet.lotsBuiltThroughSlot, lotsBuiltThroughTransactionIndex: wallet.lotsBuiltThroughTransactionIndex },
                  ],
                };
              },
            }),
          };
        },
      }),
      insert: (table: unknown) => {
        if (table === positionLotsTable) {
          return {
            values: (row: unknown) => {
              positionLotInsertCalls.push(row);
              return Promise.resolve(undefined);
            },
          };
        }

        return {
          values: (row: Record<string, unknown> & { signature: string; slot: number }) => {
            tradeInsertCalls.push(row);
            return {
              onConflictDoNothing: (target: unknown) => {
                conflictTargets.push(target);
                return {
                  returning: async () => {
                    if (persistedSignatures.has(row.signature)) {
                      return [];
                    }
                    persistedSignatures.add(row.signature);
                    return [{ id: row.signature }];
                  },
                };
              },
            };
          },
        };
      },
      update: (table: unknown) => {
        if (table === positionLotsTable) {
          return {
            set: (values: unknown) => ({
              where: async () => {
                positionLotUpdateCalls.push(values);
              },
            }),
          };
        }

        if (table === tradesTable) {
          return {
            set: (values: unknown) => ({
              where: async () => {
                tradeUpdateCalls.push(values);
              },
            }),
          };
        }

        // Phase 5's `resolveMatchedIntent`: the guarded `signed|submitted → confirmed|failed`
        // transition, inside the same batch transaction as the trade insert. Same
        // derive-from-the-real-WHERE technique as the select branch above.
        if (table === tradeIntentsTable) {
          return {
            set: (values: { status: string }) => ({
              where: (condition: unknown) => ({
                returning: async () => {
                  const { params } = whereSql(condition);
                  const [intentId, ...statuses] = params as string[];
                  const intent = intents.find((candidate) => candidate.id === intentId && statuses.includes(candidate.status));

                  if (!intent) {
                    return [];
                  }

                  intent.status = values.status;
                  intentResolveCalls.push({ intentId: intent.id, next: values.status });

                  return [{ ...intent }];
                },
              }),
            }),
          };
        }

        return {
          set: (values: { reconciledThroughSlot?: unknown; baselineCompletedAt?: Date }) => {
            cursorAdvanceSetCalls.push(values);
            return {
              where: async () => {
                if (failFinalBatchUpdate) {
                  throw new Error('connection lost mid-commit');
                }
                // Mirrors what a real committed UPDATE would do — this is what proves the
                // cursor advance and `baselineCompletedAt` land together, in one statement,
                // when it succeeds (and neither lands, per the branch above, when it fails).
                if (values.baselineCompletedAt) {
                  wallet.baselineCompletedAt = values.baselineCompletedAt;
                }
                return undefined;
              },
            };
          },
        };
      },
    };
  }

  transactionMock.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback(tx()));

  return {
    wallet,
    persistedSignatures,
    lockCalls,
    cursorAdvanceSetCalls,
    conflictTargets,
    positionLotInsertCalls,
    positionLotUpdateCalls,
    tradeUpdateCalls,
    tradeInsertCalls,
    intents,
    intentResolveCalls,
    intentSweepCalls,
    intentSweepWhereSqlCalls,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveSessionMock.mockResolvedValue(session());
  priceTradeMock.mockResolvedValue({ usdValue: '10', priceSource: 'stablecoin' });
  loadWindowedTradesMock.mockResolvedValue([]);
  // Every flag defaults off — matches every kill switch's fail-closed default elsewhere in
  // this codebase. The loss-limit integration tests below override this per key.
  isFeatureEnabledMock.mockResolvedValue(false);
  deriveSwapFromTransactionMock.mockImplementation((tx: { transaction: { signatures: string[] }; slot: number }) =>
    derivedSwap(tx.transaction.signatures[0]!, tx.slot),
  );
});

// `needsLotBackfill` is a pure predicate — no DB, no mocks — over `wallets.lots_built_through_slot`
// vs. `reconciled_through_slot`. It is the gap-detection at the heart of BLOCKING 2's fix: a
// wallet whose `rules.loss_limit_enabled` flag was off while trades kept reconciling must have
// its FIFO lot history backfilled from the correct point when the flag is later turned on,
// never resumed mid-stream (which would silently corrupt later disposals' FIFO order).
describe('needsLotBackfill', () => {
  it('needs a backfill when lots have never been built at all', () => {
    expect(needsLotBackfill(null, 100)).toBe(true);
  });

  it('needs a backfill when the lots watermark trails the reconciled cursor — the flag-was-off gap', () => {
    expect(needsLotBackfill(50, 100)).toBe(true);
  });

  it('needs no backfill once the lots watermark has caught up to the reconciled cursor', () => {
    expect(needsLotBackfill(100, 100)).toBe(false);
  });

  it('needs no backfill when the lots watermark is already ahead (a concurrent run advanced it)', () => {
    expect(needsLotBackfill(150, 100)).toBe(false);
  });
});

// `isAfterLotWatermark` is the fresh, in-lock authority `backfillLotMatchingBatch` checks per
// trade — the fix for the second round's BLOCKING 2: a coarse slot-only comparison would
// itself skip a straggler sharing the watermark's own slot with a higher transaction index
// (the same class of bug NIT 1 flagged in `loadUnmatchedTrades`), so this is a proper
// (slot, transactionIndex) tuple comparison.
describe('isAfterLotWatermark', () => {
  it('everything is after a null watermark — nothing has ever been matched', () => {
    expect(isAfterLotWatermark(1, 0, null, null)).toBe(true);
  });

  it('a later slot is after the watermark regardless of transaction index', () => {
    expect(isAfterLotWatermark(101, 0, 100, 999)).toBe(true);
  });

  it('an earlier slot is never after the watermark', () => {
    expect(isAfterLotWatermark(99, 999, 100, 0)).toBe(false);
  });

  it('the same slot with a higher transaction index is after the watermark — the exact straggler NIT 1 was about', () => {
    expect(isAfterLotWatermark(100, 6, 100, 5)).toBe(true);
  });

  it('the same slot with a lower or equal transaction index is not after the watermark', () => {
    expect(isAfterLotWatermark(100, 5, 100, 5)).toBe(false);
    expect(isAfterLotWatermark(100, 4, 100, 5)).toBe(false);
  });

  it('treats a null watermark transaction index as -1 — any real transaction index in that slot is after it', () => {
    expect(isAfterLotWatermark(100, 0, 100, null)).toBe(true);
  });
});

// The predicate that keeps `computeLotMatch` from opening a SOL/stablecoin "position" for the
// quote leg of a swap — without it, a TOKEN→SOL or TOKEN→USDC trade would track SOL/USDC
// itself as a round trip and inflate the realized-loss figure with the quote leg's own price
// movement, not the trader's actual bet.
describe('isQuoteMint', () => {
  it('is true for wrapped SOL', () => {
    expect(isQuoteMint(WSOL_MINT)).toBe(true);
  });

  it('is true for a curated stablecoin', () => {
    expect(isQuoteMint([...STABLECOIN_MINTS][0]!)).toBe(true);
  });

  it('is false for an ordinary token mint', () => {
    expect(isQuoteMint('BONK1111111111111111111111111111111111111')).toBe(false);
  });
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
    fakeDatabase(NEVER_RECONCILED);
    getTransactionsForAddressMock.mockResolvedValue([heliusTx('sig-a', 100)]);

    const result = await reconcileWallet('cid-3');

    expect(result.isBaseline).toBe(true);
    expect(recordEventMock).not.toHaveBeenCalledWith(expect.objectContaining({ eventType: 'trade.excluded' }), expect.anything());
    expect(recordEventMock).not.toHaveBeenCalledWith(expect.objectContaining({ eventType: 'rule.decision_recorded' }), expect.anything());
    expect(recordEventMock).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'wallet.backfill_started' }));
    expect(recordEventMock).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'wallet.backfill_completed' }));
  });

  it('marks baseline_completed_at on a successful baseline run, and only then treats later runs as live', async () => {
    const { wallet } = fakeDatabase(NEVER_RECONCILED);
    getTransactionsForAddressMock.mockResolvedValue([heliusTx('sig-a', 100)]);

    await reconcileWallet('cid-baseline-1');

    expect(wallet.baselineCompletedAt).not.toBeNull();

    const second = await reconcileWallet('cid-baseline-2');
    expect(second.isBaseline).toBe(false);
  });

  it('does not re-run the baseline forever when the first run finds zero transactions', async () => {
    const { wallet } = fakeDatabase(NEVER_RECONCILED);
    getTransactionsForAddressMock.mockResolvedValue([]);

    const first = await reconcileWallet('cid-4a');
    expect(first.isBaseline).toBe(true);
    expect(wallet.reconciliationState).toBe('current');
    expect(wallet.baselineCompletedAt).not.toBeNull();

    // The cursor is still null (nothing was ever found), but the baseline is marked done.
    const second = await reconcileWallet('cid-4b');
    expect(second.isBaseline).toBe(false);
  });

  /**
   * The BLOCKING regression: `reconciliation_state` alone cannot express "baseline
   * finished" — a failed first run must still be retried as baseline. Before
   * `baseline_completed_at`, a failed first connect (the common Helius-outage path) would
   * have the *retry* see `reconciliation_state: 'failed'` and wrongly persist the 90-day
   * backfill as live trades, feeding pre-commitment history into `evaluateTrade()`.
   */
  it('first run fails → second run still treats the pull as baseline and still emits no rule decisions', async () => {
    const { wallet } = fakeDatabase(NEVER_RECONCILED);
    getTransactionsForAddressMock.mockRejectedValueOnce(new Error('helius unavailable'));

    await expect(reconcileWallet('cid-fail-1')).rejects.toThrow('helius unavailable');

    expect(wallet.reconciliationState).toBe('failed');
    expect(wallet.baselineCompletedAt).toBeNull();

    getTransactionsForAddressMock.mockResolvedValue([heliusTx('sig-retry', 100)]);
    const retry = await reconcileWallet('cid-fail-2');

    expect(retry.isBaseline).toBe(true);
    expect(recordEventMock).not.toHaveBeenCalledWith(expect.objectContaining({ eventType: 'rule.decision_recorded' }), expect.anything());
    expect(recordEventMock).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'wallet.backfill_started' }));
    expect(wallet.baselineCompletedAt).not.toBeNull();
  });

  /**
   * The narrower version of the same invariant: `baseline_completed_at` must not be a
   * separate statement issued after the final batch's transaction commits — a crash in that
   * window would leave the cursor advanced but the baseline still unmarked. Proven two ways:
   * the cursor advance and `baselineCompletedAt` are pushed to `cursorAdvanceSetCalls` in the
   * very same `.set(...)` call (one statement), and when that statement itself fails,
   * neither actually lands on the wallet.
   */
  it('cursor advance and baseline_completed_at are written in the same statement — a crash there leaves both unset', async () => {
    const { wallet, cursorAdvanceSetCalls } = fakeDatabase(NEVER_RECONCILED, { failFinalBatchUpdate: true });
    getTransactionsForAddressMock.mockResolvedValue([heliusTx('sig-crash', 100)]);

    await expect(reconcileWallet('cid-atomic-crash')).rejects.toThrow('connection lost mid-commit');

    // Same `.set(...)` call carried both fields — proof they are one statement, not two.
    const values = cursorAdvanceSetCalls[0] as { reconciledThroughSlot: unknown; baselineCompletedAt?: Date };
    expect(values.reconciledThroughSlot).toBeDefined();
    expect(values.baselineCompletedAt).toBeInstanceOf(Date);

    // And since that one statement failed, neither actually committed.
    expect(wallet.baselineCompletedAt).toBeNull();
    expect(wallet.reconciliationState).toBe('failed');
  });

  it('a baseline run with more than one batch only folds baseline_completed_at into the final batch', async () => {
    const { wallet, cursorAdvanceSetCalls } = fakeDatabase(NEVER_RECONCILED);
    const signatures = Array.from({ length: 101 }, (_, index) => `sig-multi-${index}`);
    getTransactionsForAddressMock.mockResolvedValue(signatures.map((sig, index) => heliusTx(sig, 100 + index)));

    const result = await reconcileWallet('cid-multi-batch');

    expect(result.isBaseline).toBe(true);
    expect(cursorAdvanceSetCalls).toHaveLength(2); // two batches, 100 + 1
    expect((cursorAdvanceSetCalls[0] as { baselineCompletedAt?: Date }).baselineCompletedAt).toBeUndefined();
    expect((cursorAdvanceSetCalls[1] as { baselineCompletedAt?: Date }).baselineCompletedAt).toBeInstanceOf(Date);
    expect(wallet.baselineCompletedAt).not.toBeNull();
  });

  it('re-running over the same range does not double-insert — the (wallet_id, signature) constraint is honored', async () => {
    const { persistedSignatures, conflictTargets } = fakeDatabase(ALREADY_BASELINED);
    getTransactionsForAddressMock.mockResolvedValue([heliusTx('sig-dup', 100)]);

    const firstRun = await reconcileWallet('cid-5a');
    expect(firstRun.tradesPersisted).toBe(1);
    expect(persistedSignatures.size).toBe(1);
    // (walletId, signature) — a composite conflict target, not a single global-unique column.
    const conflictOptions = conflictTargets[0] as { target: unknown[] };
    expect(conflictOptions.target).toHaveLength(2);

    const secondRun = await reconcileWallet('cid-5b');
    expect(secondRun.tradesPersisted).toBe(0); // ON CONFLICT DO NOTHING — already there
    expect(persistedSignatures.size).toBe(1); // still exactly one row
  });

  it('advances the cursor via GREATEST(...) so a concurrent run can never move it backward', async () => {
    const { cursorAdvanceSetCalls } = fakeDatabase(ALREADY_BASELINED);
    getTransactionsForAddressMock.mockResolvedValue([heliusTx('sig-cursor', 100)]);

    await reconcileWallet('cid-cursor');

    expect(cursorAdvanceSetCalls).toHaveLength(1);
    const values = cursorAdvanceSetCalls[0] as { reconciledThroughSlot: unknown };
    const { sql: renderedSql } = pgDialect.sqlToQuery(values.reconciledThroughSlot as Parameters<PgDialect['sqlToQuery']>[0]);
    expect(renderedSql.toLowerCase()).toContain('greatest');
    expect(renderedSql.toLowerCase()).toContain('coalesce');
  });

  it("records trade.excluded, not rule.decision_recorded, for a live run's excluded trade", async () => {
    fakeDatabase(ALREADY_BASELINED);
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
   * The row lock must cover only the DB writes, not `priceTrade`'s HTTP round trips.
   * `transactionMock` is only ever invoked by `persistBatch`, *after* `priceBatch` has
   * already awaited every `priceTrade` call for the batch — so if pricing happened while a
   * transaction was already open, `priceTradeMock` would be called with `transactionMock`
   * already having been invoked at least once for this batch. It never is: this test
   * asserts pricing is fully done before the first transaction (and thus the first lock)
   * for this batch opens.
   */
  it('prices the batch before opening the locked transaction — the lock never spans a priceTrade call', async () => {
    fakeDatabase(ALREADY_BASELINED);
    getTransactionsForAddressMock.mockResolvedValue([heliusTx('sig-price', 100)]);

    let transactionOpenedBeforePricing = false;
    priceTradeMock.mockImplementation(async () => {
      if (transactionMock.mock.calls.length > 0) {
        transactionOpenedBeforePricing = true;
      }
      return { usdValue: '10', priceSource: 'stablecoin' };
    });

    await reconcileWallet('cid-lock-scope');

    expect(priceTradeMock).toHaveBeenCalledTimes(1);
    expect(transactionOpenedBeforePricing).toBe(false);
  });

  /**
   * 101 trades forces two persistence batches (`PERSIST_BATCH_SIZE` is 100). Only the
   * 101st (alone in batch two) fails, so batch one's 100 trades — each already committed
   * in its own transaction — must still be there afterward, and the wallet must read
   * `failed`, never a false `current`.
   */
  it('marks reconciliation_state failed, not current, on a mid-run failure, and preserves an earlier batch\'s progress', async () => {
    const { wallet, persistedSignatures } = fakeDatabase(ALREADY_BASELINED);

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
    const { persistedSignatures, lockCalls } = fakeDatabase(ALREADY_BASELINED);
    getTransactionsForAddressMock.mockResolvedValue([heliusTx('sig-race', 100)]);

    const [a, b] = await Promise.all([reconcileWallet('cid-8a'), reconcileWallet('cid-8b')]);

    // Every batch acquired the lock (both runs' single-page transactions each did).
    expect(lockCalls.length).toBeGreaterThanOrEqual(2);
    // No duplicate: exactly one of the two runs actually persisted the trade.
    expect(a.tradesPersisted + b.tradesPersisted).toBe(1);
    expect(persistedSignatures.size).toBe(1);
  });
});

/**
 * `rules.loss_limit_enabled` on, end to end through `reconcileWallet()` — the coverage two
 * rounds of review found missing: every other test in this file leaves the flag at its
 * default-mocked `false`, so the backfill path and the quote-mint wiring were previously
 * exercised by nothing but their own pure-function unit tests.
 */
describe('reconcileWallet — loss-limit integration (flag on)', () => {
  function enableLossLimitOnly() {
    isFeatureEnabledMock.mockImplementation(async (key: string) => key === 'rules.loss_limit_enabled');
  }

  it('a backfill run reconstructs position_lots from an already-persisted, never-matched trade', async () => {
    const oldAcquisition: FakeTradeRow = {
      id: 'trade-old-1',
      walletId: WALLET_ID,
      signature: 'sig-old-1',
      slot: 50,
      transactionIndex: 0,
      occurredAt: new Date('2026-08-02T00:00:00Z'), // after activeConstitutionRow()'s activatedAt (2026-08-01)
      soldMint: [...STABLECOIN_MINTS][0]!, // a quote mint — the disposal half is skipped entirely
      boughtMint: 'BONK1111111111111111111111111111111111111',
      soldAmountBaseUnits: '100000000',
      boughtAmountBaseUnits: '5000000',
      usdValue: '100',
      isBaseline: false,
      excludedReason: null,
    };

    const { positionLotInsertCalls, tradeUpdateCalls } = fakeDatabase(
      {
        reconciledThroughSlot: 100,
        reconciliationState: 'current',
        baselineCompletedAt: new Date('2026-08-01T00:00:00Z'),
        lotsBuiltThroughSlot: null, // never built — the flag-was-off gap
        lotsBuiltThroughTransactionIndex: null,
      },
      { existingTrades: [oldAcquisition] },
    );
    enableLossLimitOnly();
    getTransactionsForAddressMock.mockResolvedValue([]); // no new Helius activity — the whole point is backfilling old trades

    await reconcileWallet('cid-backfill-1');

    expect(positionLotInsertCalls).toEqual([
      expect.objectContaining({
        walletId: WALLET_ID,
        mint: 'BONK1111111111111111111111111111111111111',
        remainingBaseUnits: '5000000',
        costBasisUsd: '100',
        openedAfterActivation: true,
        slot: 50,
        transactionIndex: 0,
      }),
    ]);
    expect(tradeUpdateCalls).toEqual([{ isRoundTripClose: false, realizedLossUsd: null }]);
    expect(recordEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'trade.lot_matched', payload: expect.objectContaining({ signature: 'sig-old-1' }) }),
      expect.anything(),
    );
  });

  it('never opens a position_lots row for a quote-mint (SOL) leg of a live swap', async () => {
    const { positionLotInsertCalls } = fakeDatabase(ALREADY_BASELINED);
    enableLossLimitOnly();
    getTransactionsForAddressMock.mockResolvedValue([heliusTx('sig-quote', 100)]);
    deriveSwapFromTransactionMock.mockReturnValueOnce(
      derivedSwap('sig-quote', 100, {
        soldMint: 'BONK1111111111111111111111111111111111111',
        boughtMint: WSOL_MINT,
        soldAmountBaseUnits: '5000000',
        boughtAmountBaseUnits: '2000000000',
        soldDecimals: 5,
        boughtDecimals: 9,
      }),
    );

    await reconcileWallet('cid-quote-1');

    expect(positionLotInsertCalls).toEqual([]);
    expect(recordEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'trade.lot_matched', payload: expect.objectContaining({ signature: 'sig-quote', isRoundTripClose: false }) }),
      expect.anything(),
    );
  });
});

/**
 * Phase 5: a reconciled trade whose signature matches a live (`signed`/`submitted`)
 * `trade_intents` row is linked back to it (`trades.trade_intent_id`) and the intent is
 * guarded-transitioned to `confirmed`/`failed` — in the same transaction as the trade insert,
 * per the plan. The existing `(wallet_id, signature)` dedup (`ON CONFLICT ... DO NOTHING`) must
 * stay unaffected: these tests only ever add linkage on top of it, never change when a trade is
 * considered "new".
 */
describe('reconcileWallet — trade_intent linkage (Phase 5)', () => {
  it('links a real trade to its live submitted intent and confirms it', async () => {
    const { intents, tradeInsertCalls, intentResolveCalls } = fakeDatabase(ALREADY_BASELINED, {
      liveIntents: [{ id: 'intent-linked', walletId: WALLET_ID, signature: 'sig-linked', status: 'submitted', expiresAt: new Date(Date.now() + 60_000) }],
    });
    getTransactionsForAddressMock.mockResolvedValue([heliusTx('sig-linked', 100)]);

    await reconcileWallet('cid-link-1');

    expect(tradeInsertCalls).toHaveLength(1);
    expect(tradeInsertCalls[0]?.tradeIntentId).toBe('intent-linked');
    expect(intentResolveCalls).toEqual([{ intentId: 'intent-linked', next: 'confirmed' }]);
    expect(intents.find((intent) => intent.id === 'intent-linked')?.status).toBe('confirmed');
    expect(recordEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'trade.intent_confirmed',
        payload: expect.objectContaining({ intentId: 'intent-linked', walletId: WALLET_ID, signature: 'sig-linked', stage: 'reconciliation' }),
      }),
      expect.anything(),
    );
  });

  it('leaves a trade with no matching live intent unaffected — the common case, an external trade', async () => {
    const { tradeInsertCalls, intentResolveCalls } = fakeDatabase(ALREADY_BASELINED, { liveIntents: [] });
    getTransactionsForAddressMock.mockResolvedValue([heliusTx('sig-external', 100)]);

    await reconcileWallet('cid-link-2');

    expect(tradeInsertCalls[0]?.tradeIntentId).toBeNull();
    expect(intentResolveCalls).toEqual([]);
    expect(recordEventMock).not.toHaveBeenCalledWith(expect.objectContaining({ eventType: 'trade.intent_confirmed' }), expect.anything());
    expect(recordEventMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'trade.intent_failed', payload: expect.objectContaining({ stage: 'reconciliation' }) }),
      expect.anything(),
    );
  });

  it('transitions the intent to failed when its matching signature derives to an excluded candidate — landed on chain with no real swap effect', async () => {
    const { intents, intentResolveCalls } = fakeDatabase(ALREADY_BASELINED, {
      liveIntents: [{ id: 'intent-onchain-fail', walletId: WALLET_ID, signature: 'sig-onchain-fail', status: 'submitted', expiresAt: new Date(Date.now() + 60_000) }],
    });
    getTransactionsForAddressMock.mockResolvedValue([heliusTx('sig-onchain-fail', 100)]);
    deriveSwapFromTransactionMock.mockReturnValueOnce(
      derivedSwap('sig-onchain-fail', 100, {
        excludedReason: 'no_net_change',
        soldMint: null,
        boughtMint: null,
        soldAmountBaseUnits: null,
        boughtAmountBaseUnits: null,
        soldDecimals: null,
        boughtDecimals: null,
      }),
    );

    await reconcileWallet('cid-link-3');

    expect(intentResolveCalls).toEqual([{ intentId: 'intent-onchain-fail', next: 'failed' }]);
    expect(intents.find((intent) => intent.id === 'intent-onchain-fail')?.status).toBe('failed');
    expect(recordEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'trade.intent_failed',
        payload: expect.objectContaining({ intentId: 'intent-onchain-fail', stage: 'reconciliation', reason: 'no_net_change' }),
      }),
      expect.anything(),
    );
  });

  it('does not re-link or re-transition on a rerun — the (wallet_id, signature) dedup this phase must not disturb', async () => {
    const { intents, intentResolveCalls, persistedSignatures } = fakeDatabase(ALREADY_BASELINED, {
      liveIntents: [{ id: 'intent-rerun', walletId: WALLET_ID, signature: 'sig-rerun', status: 'submitted', expiresAt: new Date(Date.now() + 60_000) }],
    });
    getTransactionsForAddressMock.mockResolvedValue([heliusTx('sig-rerun', 100)]);

    const first = await reconcileWallet('cid-link-4a');
    expect(first.tradesPersisted).toBe(1);
    expect(persistedSignatures.size).toBe(1);
    expect(intentResolveCalls).toHaveLength(1);

    const second = await reconcileWallet('cid-link-4b');
    expect(second.tradesPersisted).toBe(0); // ON CONFLICT DO NOTHING — unaffected by this phase
    expect(persistedSignatures.size).toBe(1);
    expect(intentResolveCalls).toHaveLength(1); // no second transition attempt
    expect(intents.find((intent) => intent.id === 'intent-rerun')?.status).toBe('confirmed'); // unchanged since the first run
  });
});

/**
 * Phase 5, Step 5 (the Phase 4 review's required addition): a `submitted` intent whose
 * transaction never lands on chain at all is otherwise unresolvable, since the linkage above
 * only ever resolves a signature that *did* land. `isStrandedSubmittedIntent` is the pure
 * boundary the guarded sweep runs — tested directly against fixed clock values here, and
 * exercised through `reconcileWallet()` itself in the `sweep` `describe` below (using the same
 * exported predicate to drive the fixture's own filtering, per this file's established
 * derive-from-the-real-predicate convention).
 */
describe('isStrandedSubmittedIntent', () => {
  const now = new Date('2026-08-27T12:00:00Z');
  const GRACE_MS = 2 * 60 * 1_000;

  it('is stranded once expiresAt plus the grace period has passed', () => {
    expect(isStrandedSubmittedIntent(new Date(now.getTime() - GRACE_MS - 1), now)).toBe(true);
  });

  it('is stranded exactly at the grace boundary (inclusive)', () => {
    expect(isStrandedSubmittedIntent(new Date(now.getTime() - GRACE_MS), now)).toBe(true);
  });

  it('is not stranded a moment before the grace boundary — still legitimately in flight', () => {
    expect(isStrandedSubmittedIntent(new Date(now.getTime() - GRACE_MS + 1), now)).toBe(false);
  });

  it('is not stranded when expiresAt has not passed at all', () => {
    expect(isStrandedSubmittedIntent(new Date(now.getTime() + 60_000), now)).toBe(false);
  });
});

describe('reconcileWallet — submitted intent sweep (Phase 5, Step 5)', () => {
  it('sweeps a genuinely-stranded submitted intent to failed, with a distinct sweep-stage event', async () => {
    const { intents, intentSweepCalls } = fakeDatabase(ALREADY_BASELINED, {
      liveIntents: [
        { id: 'intent-stranded', walletId: WALLET_ID, signature: 'sig-never-landed', status: 'submitted', expiresAt: new Date(Date.now() - 10 * 60_000) },
      ],
    });
    getTransactionsForAddressMock.mockResolvedValue([]); // never landed — no Helius activity for it at all

    await reconcileWallet('cid-sweep-1');

    expect(intentSweepCalls[0]?.sweptIds).toEqual(['intent-stranded']);
    expect(intents.find((intent) => intent.id === 'intent-stranded')?.status).toBe('failed');
    expect(recordEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'trade.intent_failed',
        payload: expect.objectContaining({ intentId: 'intent-stranded', walletId: WALLET_ID, reason: 'blockhash_expired_unresolved', stage: 'sweep' }),
      }),
    );
  });

  it('does not sweep a submitted intent still legitimately in flight — within the grace period past expiry', async () => {
    const { intents, intentSweepCalls } = fakeDatabase(ALREADY_BASELINED, {
      liveIntents: [
        // 30s past its own expiry — comfortably inside the 2-minute grace `isStrandedSubmittedIntent` allows for
        // Helius' finalized-commitment indexing lag, so this must not be swept as if abandoned.
        { id: 'intent-in-flight', walletId: WALLET_ID, signature: 'sig-in-flight', status: 'submitted', expiresAt: new Date(Date.now() - 30_000) },
      ],
    });
    getTransactionsForAddressMock.mockResolvedValue([]);

    await reconcileWallet('cid-sweep-2');

    expect(intentSweepCalls[0]?.sweptIds).toEqual([]);
    expect(intents.find((intent) => intent.id === 'intent-in-flight')?.status).toBe('submitted');
    expect(recordEventMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'trade.intent_failed', payload: expect.objectContaining({ stage: 'sweep' }) }),
    );
  });

  it('the sweep never fires for an already-resolved intent — only submitted is ever swept', async () => {
    const { intents, intentSweepCalls } = fakeDatabase(ALREADY_BASELINED, {
      liveIntents: [
        { id: 'intent-already-confirmed', walletId: WALLET_ID, signature: 'sig-already-confirmed', status: 'confirmed', expiresAt: new Date(Date.now() - 10 * 60_000) },
      ],
    });
    getTransactionsForAddressMock.mockResolvedValue([]);

    await reconcileWallet('cid-sweep-3');

    expect(intentSweepCalls[0]?.sweptIds).toEqual([]);
    expect(intents.find((intent) => intent.id === 'intent-already-confirmed')?.status).toBe('confirmed');
  });

  it('releases the swept intent from the rolling-allowance reservation set', async () => {
    // `RESERVING_TRADE_INTENT_STATUSES` (schema.ts) is what `intent-lifecycle.ts`'s
    // `loadLiveIntentUsd` sums to reserve allowance. Once this sweep flips a stranded intent to
    // `failed`, it structurally falls out of that set and stops reserving — no change to
    // `intent-lifecycle.ts` itself is needed for the release to take effect.
    expect(RESERVING_TRADE_INTENT_STATUSES).not.toContain('failed');

    const { intents } = fakeDatabase(ALREADY_BASELINED, {
      liveIntents: [
        { id: 'intent-release', walletId: WALLET_ID, signature: 'sig-release', status: 'submitted', expiresAt: new Date(Date.now() - 10 * 60_000) },
      ],
    });
    getTransactionsForAddressMock.mockResolvedValue([]);

    await reconcileWallet('cid-sweep-4');

    const swept = intents.find((intent) => intent.id === 'intent-release');
    expect(swept?.status).toBe('failed');
    expect(RESERVING_TRADE_INTENT_STATUSES).not.toContain(swept?.status);
  });

  it('the guarded UPDATE is scoped to this wallet, the submitted status, and an expires_at-vs-now() database-clock comparison', async () => {
    const { intentSweepWhereSqlCalls } = fakeDatabase(ALREADY_BASELINED, { liveIntents: [] });
    getTransactionsForAddressMock.mockResolvedValue([]);

    await reconcileWallet('cid-sweep-5');

    expect(intentSweepWhereSqlCalls).toHaveLength(1);
    const renderedSql = intentSweepWhereSqlCalls[0]!.toLowerCase();
    expect(renderedSql).toContain('"wallet_id" =');
    expect(renderedSql).toContain('"status" =');
    expect(renderedSql).toContain('"expires_at" <=');
    expect(renderedSql).toContain('now()');
    expect(renderedSql).toContain('interval');
  });
});
