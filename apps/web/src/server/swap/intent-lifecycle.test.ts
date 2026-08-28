import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LIVE_TRADE_INTENT_STATUSES, tradeIntents, trades } from '../db/schema';
import type { Database } from '../db/client';
import {
  expireAllLiveIntentsForWallet,
  expireAndReserveLiveIntent,
  loadEvaluableWindowedTrades,
  loadLiveIntentUsd,
  reapExpiredIntents,
} from './intent-lifecycle';

/**
 * The concurrency guarantee this module exists to provide, tested the way this codebase tests
 * every DB-touching module: hermetically, with no real connection
 * (`.ai/decisions/migration-and-test-tooling.md`). Two things follow from that:
 *
 * - The partial unique index's real enforcement — Postgres refusing a second live row — is not
 *   something a mocked test can exercise; the honest hermetic proof is that the index is
 *   declared with exactly the predicate the concurrency guarantee depends on (`schema.ts`
 *   description below), which is what an actual migration ships.
 * - "Two concurrent callers never both leave a live row" is tested by driving two overlapping
 *   `expireAndReserveLiveIntent` calls through a small in-memory fake that serializes on the
 *   wallet lock exactly the way `SELECT ... FOR UPDATE` does — a faithful behavioural model of
 *   the guarantee, not a real Postgres exercising it.
 */

const { loadWindowedTradesMock } = vi.hoisted(() => ({ loadWindowedTradesMock: vi.fn() }));

vi.mock('../rules/rolling-allowance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../rules/rolling-allowance')>();
  return { ...actual, loadWindowedTrades: loadWindowedTradesMock };
});

const pgDialect = new PgDialect();

function whereSql(node: unknown): { sql: string; params: unknown[] } {
  return pgDialect.sqlToQuery(node as Parameters<PgDialect['sqlToQuery']>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  loadWindowedTradesMock.mockResolvedValue([]);
});

describe('trade_intents_wallet_live_idx (schema)', () => {
  it('is a unique index on wallet_id, predicated on exactly LIVE_TRADE_INTENT_STATUSES', () => {
    const config = getTableConfig(tradeIntents);
    const liveIndex = config.indexes.find((index) => index.config.name === 'trade_intents_wallet_live_idx');

    expect(liveIndex).toBeDefined();
    expect(liveIndex!.config.unique).toBe(true);
    expect(liveIndex!.config.columns.map((column) => (column as { name: string }).name)).toEqual(['wallet_id']);

    const { sql } = whereSql(liveIndex!.config.where);

    // The predicate is asserted against the literal statuses, not against
    // `LIVE_TRADE_INTENT_STATUSES` echoed back — Postgres partial-index predicates must be
    // immutable, so the two can only ever be kept in sync by hand (see the doc comment on
    // `LIVE_TRADE_INTENT_STATUSES`). This test is the tripwire for that drifting.
    for (const status of LIVE_TRADE_INTENT_STATUSES) {
      expect(sql).toContain(`'${status}'`);
    }
    expect(LIVE_TRADE_INTENT_STATUSES).toEqual(['quoted', 'approved', 'signed', 'submitted']);
  });
});

/** A minimal `DatabaseExecutor` stand-in: dispatches `.select()`/`.update()` by the real table object `.from()`/the table arg is called with. */
function makeExecutor(options: { tradeIntentsRows?: unknown[]; tradesRows?: unknown[]; updateReturns?: unknown[] } = {}) {
  const { tradeIntentsRows = [], tradesRows = [], updateReturns = [] } = options;
  const selectCalls: unknown[] = [];
  const updateCalls: { table: unknown; set: unknown; where: unknown }[] = [];
  const selectWhereCalls: { table: unknown; where: unknown }[] = [];

  return {
    selectCalls,
    updateCalls,
    selectWhereCalls,
    select: () => ({
      from: (table: unknown) => {
        selectCalls.push(table);
        return {
          where: (predicate: unknown) => {
            selectWhereCalls.push({ table, where: predicate });
            return Promise.resolve(table === trades ? tradesRows : tradeIntentsRows);
          },
        };
      },
    }),
    update: (table: unknown) => ({
      set: (values: unknown) => ({
        where: (predicate: unknown) => {
          updateCalls.push({ table, set: values, where: predicate });
          return { returning: async () => updateReturns };
        },
      }),
    }),
  };
}

describe('reapExpiredIntents', () => {
  it('guards on wallet, live status and expiry against the database clock — never a DELETE', async () => {
    const executor = makeExecutor({ updateReturns: [{ id: 'expired-1' }] });

    const reaped = await reapExpiredIntents('wallet-1', executor as never);

    expect(reaped).toEqual(['expired-1']);
    expect(executor.updateCalls).toHaveLength(1);
    expect(executor.updateCalls[0]!.table).toBe(tradeIntents);
    expect((executor.updateCalls[0]!.set as { status: string }).status).toBe('expired');

    const { sql, params } = whereSql(executor.updateCalls[0]!.where);
    expect(sql).toContain('"wallet_id" =');
    expect(sql).toContain('"status" in');
    expect(sql).toContain('"expires_at" <=');
    expect(sql).toContain('now()');
    expect(params).toContain('wallet-1');
    for (const status of LIVE_TRADE_INTENT_STATUSES) {
      expect(params).toContain(status);
    }
  });

  it('is a no-op when nothing qualifies — an already-terminal or not-yet-expired row is left alone', async () => {
    const executor = makeExecutor({ updateReturns: [] });

    await expect(reapExpiredIntents('wallet-1', executor as never)).resolves.toEqual([]);
  });
});

describe('expireAllLiveIntentsForWallet', () => {
  it('expires unconditionally — no expires_at guard, unlike reapExpiredIntents', async () => {
    const executor = makeExecutor({ updateReturns: [{ id: 'live-1' }] });

    const expired = await expireAllLiveIntentsForWallet('wallet-1', executor as never);

    expect(expired).toEqual(['live-1']);
    const { sql } = whereSql(executor.updateCalls[0]!.where);
    expect(sql).toContain('"wallet_id" =');
    expect(sql).toContain('"status" in');
    expect(sql).not.toContain('expires_at');
  });
});

/**
 * A `Database`-shaped fake whose `.transaction()` serializes on a single mutex, the way
 * Postgres's `SELECT ... FROM wallets WHERE id = $1 FOR UPDATE` serializes two concurrent
 * transactions on the same row. This is what makes the "two overlapping calls" test below a
 * behavioural proof of the guarantee rather than a coincidence of `Promise.all` scheduling.
 */
function makeSerializingDatabase(initialLive: { id: string } | null) {
  let live = initialLive;
  let locked = false;
  const waiters: (() => void)[] = [];
  const lockOrder: number[] = [];
  let nextLockSeq = 0;

  async function acquire(): Promise<void> {
    if (!locked) {
      locked = true;
      lockOrder.push(nextLockSeq++);
      return;
    }

    await new Promise<void>((resolve) => waiters.push(resolve));
    locked = true;
    lockOrder.push(nextLockSeq++);
  }

  function release(): void {
    locked = false;
    waiters.shift()?.();
  }

  return {
    lockOrder,
    getLive: () => live,
    setLive: (row: { id: string }) => {
      live = row;
    },
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      await acquire();
      try {
        const tx = {
          select: () => ({ from: () => ({ where: () => ({ for: () => ({ limit: async () => [{ id: 'wallet-1' }] }) }) }) }),
          update: () => ({
            set: () => ({
              where: () => ({
                returning: async () => {
                  if (!live) return [];
                  const expired = [live];
                  live = null;
                  return expired;
                },
              }),
            }),
          }),
        };

        return await fn(tx);
      } finally {
        release();
      }
    },
  };
}

/**
 * A `Database`-shaped fake for `expireAndReserveLiveIntent`'s own transaction body: a wallet
 * lock (`select().from().where().for().limit()`) plus a guarded expire
 * (`update().set().where().returning()`), the two operations that must run before the
 * caller's insert.
 */
function makeTransactionDb(expireReturns: unknown[], onOp?: (op: 'lock' | 'expire') => void) {
  return {
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn({
        select: () => ({
          from: () => ({
            where: () => ({
              for: () => {
                onOp?.('lock');
                return { limit: async () => [{ id: 'wallet-1' }] };
              },
            }),
          }),
        }),
        update: () => ({
          set: () => ({
            where: () => ({
              returning: async () => {
                onOp?.('expire');
                return expireReturns;
              },
            }),
          }),
        }),
      }),
  };
}

describe('expireAndReserveLiveIntent', () => {
  it('locks the wallet row before expiring and before the caller inserts', async () => {
    const order: string[] = [];
    const db = makeTransactionDb([], (op) => order.push(op));

    await expireAndReserveLiveIntent(
      'wallet-1',
      async () => {
        order.push('insert');
        return 'intent-new';
      },
      db as unknown as Database,
    );

    expect(order).toEqual(['lock', 'expire', 'insert']);
  });

  it('hands the caller the id of the intent it expired, or null when none was live', async () => {
    const withPriorLive = makeTransactionDb([{ id: 'prior-1' }]);
    const withNoPriorLive = makeTransactionDb([]);

    const seenWithPrior = await expireAndReserveLiveIntent('wallet-1', async (_tx, expiredIntentId) => expiredIntentId, withPriorLive as unknown as Database);
    const seenWithNone = await expireAndReserveLiveIntent('wallet-1', async (_tx, expiredIntentId) => expiredIntentId, withNoPriorLive as unknown as Database);

    expect(seenWithPrior).toBe('prior-1');
    expect(seenWithNone).toBeNull();
  });

  /**
   * The concurrency guarantee itself. `db` starts with one live intent already reserved
   * (mimicking a wallet mid-quote); two "concurrent" quote requests for the same wallet race
   * to expire it and reserve their own. The wallet-row lock — modelled by `makeSerializingDatabase`
   * exactly as `SELECT ... FOR UPDATE` behaves — must serialize them: whichever request's
   * expire-then-insert runs first sees the original prior intent, and the second sees the
   * *first's* new intent as its own "prior" to expire, never both reading the same row as
   * still live. After both settle, the wallet holds exactly one live row: the second request's.
   */
  it('never leaves two live rows when two callers race for the same wallet', async () => {
    const db = makeSerializingDatabase({ id: 'prior-quoted' });

    // Each insertFn does what the real `INSERT` does: leave its own row as the wallet's new
    // live one, inside the same locked section the expire ran in.
    const [resultA, resultB] = await Promise.all([
      expireAndReserveLiveIntent(
        'wallet-1',
        async (_tx, expiredIntentId) => {
          db.setLive({ id: 'quote-a' });
          return { id: 'quote-a', expiredIntentId };
        },
        db as unknown as Database,
      ),
      expireAndReserveLiveIntent(
        'wallet-1',
        async (_tx, expiredIntentId) => {
          db.setLive({ id: 'quote-b' });
          return { id: 'quote-b', expiredIntentId };
        },
        db as unknown as Database,
      ),
    ]);

    // Exactly one of the two racing calls saw the original prior intent, and the other saw
    // the winner's own insert as its "prior" — never both seeing (or both missing) the same
    // live row.
    const expiredIds = [resultA.expiredIntentId, resultB.expiredIntentId];
    expect(expiredIds).toContain('prior-quoted');
    expect(new Set(expiredIds).size).toBe(2);
    expect(db.lockOrder).toEqual([0, 1]);
    // Only the second (later-locked) request's insert survives — at most one live row, ever.
    expect(db.getLive()).toEqual({ id: 'quote-b' });
  });
});

describe('loadLiveIntentUsd', () => {
  it('reaps before reading, so a wall-clock-expired row is never counted', async () => {
    const order: string[] = [];
    const executor = {
      update: () => ({
        set: () => ({
          where: () => {
            order.push('reap');
            return { returning: async () => [] };
          },
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => {
            order.push('read');
            return Promise.resolve([]);
          },
        }),
      }),
    };

    await loadLiveIntentUsd('wallet-1', 24, new Date(), executor as never);

    expect(order).toEqual(['reap', 'read']);
  });

  it('sums live intents via sumTradeUsd, and excludes a live intent whose signature already landed in trades', async () => {
    const now = new Date();
    const executor = makeExecutor({
      tradeIntentsRows: [
        { id: 'live-a', usdValue: '100', createdAt: now, signature: null },
        { id: 'live-b', usdValue: '50', createdAt: now, signature: 'sig-reconciled' },
        { id: 'live-c', usdValue: '25', createdAt: now, signature: 'sig-not-yet-reconciled' },
      ],
      tradesRows: [{ signature: 'sig-reconciled' }],
    });

    const result = await loadLiveIntentUsd('wallet-1', 24, now, executor as never);

    expect(result.entries.map((entry) => entry.usdValue)).toEqual(['100', '25']);
    expect(result.totalUsd).toBe('125');
  });

  it('fails closed: totalUsd is null the moment any counted entry is unpriced', async () => {
    const now = new Date();
    const executor = makeExecutor({
      tradeIntentsRows: [
        { id: 'live-a', usdValue: '100', createdAt: now, signature: null },
        { id: 'live-b', usdValue: null, createdAt: now, signature: null },
      ],
    });

    const result = await loadLiveIntentUsd('wallet-1', 24, now, executor as never);

    expect(result.totalUsd).toBeNull();
  });

  it('excludes the intent under submission by id — the self-block fix', async () => {
    const now = new Date();
    // A real query with the exclusion applied would never return the excluded row in the
    // first place — the fixture reflects that, and the assertion below is what actually
    // proves the exclusion was requested rather than merely that this fixture is small.
    const executor = makeExecutor({
      tradeIntentsRows: [{ id: 'other-live', usdValue: '25', createdAt: now, signature: null }],
    });

    const result = await loadLiveIntentUsd('wallet-1', 24, now, executor as never, 'self');

    expect(result.totalUsd).toBe('25');
    const tradeIntentsSelect = executor.selectWhereCalls.find((call) => call.table === tradeIntents);
    const { sql, params } = whereSql(tradeIntentsSelect!.where);
    expect(sql).toContain('"id" <>');
    expect(params).toContain('self');
  });
});

describe('loadEvaluableWindowedTrades', () => {
  it('unions persisted trades with live-intent entries into one list', async () => {
    const now = new Date();
    loadWindowedTradesMock.mockResolvedValue([{ occurredAt: now, usdValue: '10' }]);
    const executor = makeExecutor({ tradeIntentsRows: [{ id: 'live-a', usdValue: '5', createdAt: now, signature: null }] });

    const result = await loadEvaluableWindowedTrades('wallet-1', 24, now, executor as never);

    expect(result).toEqual([
      { occurredAt: now, usdValue: '10' },
      { occurredAt: now, usdValue: '5' },
    ]);
  });
});
