import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Constitution } from '@degencage/rules';

import {
  DELAYED_INCREASE_MS,
  PendingChangeRejected,
  applyDuePendingChanges,
  cancelPendingChange,
  requestLimitChange,
} from './pending-changes';

const {
  selectMock,
  updateMock,
  insertMock,
  deleteMock,
  transactionMock,
  txSelectMock,
  txUpdateMock,
  resolveSessionMock,
  recordEventMock,
} = vi.hoisted(() => ({
  selectMock: vi.fn(),
  updateMock: vi.fn(),
  insertMock: vi.fn(),
  deleteMock: vi.fn(),
  transactionMock: vi.fn(),
  txSelectMock: vi.fn(),
  txUpdateMock: vi.fn(),
  resolveSessionMock: vi.fn(),
  recordEventMock: vi.fn(),
}));

vi.mock('../db/client', () => ({
  getDb: () => ({
    select: selectMock,
    update: updateMock,
    insert: insertMock,
    delete: deleteMock,
    transaction: transactionMock,
  }),
}));
vi.mock('../auth/session', () => ({ resolveSession: resolveSessionMock }));
vi.mock('../../observability/events', () => ({ recordEvent: recordEventMock }));

const SESSION_USER_ID = 'user-1';
const SESSION_WALLET_ID = 'wallet-1';
const CONSTITUTION_ID = 'constitution-1';
const LIMIT_ID = 'limit-1';

function sessionIdentity() {
  return {
    walletAddress: 'So11111111111111111111111111111111111111112',
    walletId: SESSION_WALLET_ID,
    userId: SESSION_USER_ID,
    expiresAt: new Date(Date.now() + 60_000),
    idHash: 'session-hash',
  };
}

function constitutionDocument(overrides: { maxUsd?: string } = {}): Constitution {
  return {
    schemaVersion: 1,
    limits: [{ id: LIMIT_ID, type: 'daily_notional_usd', maxUsd: '500', windowHours: 24, ...overrides }],
  };
}

function activeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CONSTITUTION_ID,
    userId: SESSION_USER_ID,
    walletId: SESSION_WALLET_ID,
    status: 'active',
    document: constitutionDocument(),
    schemaVersion: 1,
    commitmentStartedAt: new Date(Date.now() - 3_600_000),
    activatedAt: new Date(Date.now() - 3_600_000),
    createdAt: new Date(),
    ...overrides,
  };
}

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pending-1',
    constitutionId: CONSTITUTION_ID,
    limitId: LIMIT_ID,
    field: 'maxUsd',
    oldValue: '500',
    newValue: '900',
    effectiveAt: new Date(Date.now() + DELAYED_INCREASE_MS),
    appliedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

/** A thenable that is also chainable with `.limit()` / `.for('update').limit()` — covers every shape `select().from().where()` takes across this module. */
function queryResult(rows: unknown[]) {
  const promise = Promise.resolve(rows);

  return Object.assign(promise, {
    limit: () => Promise.resolve(rows),
    for: () => ({ limit: () => Promise.resolve(rows) }),
  });
}

/** A thenable that is also chainable with `.returning()` — covers a bare `update().set().where()` await and one followed by `.returning()`. */
function updateResult(rows: unknown[]) {
  const promise = Promise.resolve(rows);

  return Object.assign(promise, { returning: () => Promise.resolve(rows) });
}

function selectReturnsOn(mock: ReturnType<typeof vi.fn>, rows: unknown[]) {
  mock.mockReturnValueOnce({ from: () => ({ where: () => queryResult(rows) }) });
}

function updateReturnsOn(mock: ReturnType<typeof vi.fn>, rows: unknown[]) {
  const setSpy = vi.fn();
  const whereSpy = vi.fn();

  mock.mockReturnValueOnce({
    set: (values: unknown) => {
      setSpy(values);

      return {
        where: (whereArg: unknown) => {
          whereSpy(whereArg);

          return updateResult(rows);
        },
      };
    },
  });

  return { setSpy, whereSpy };
}

const selectReturns = (rows: unknown[]) => selectReturnsOn(selectMock, rows);
const updateReturns = (rows: unknown[]) => updateReturnsOn(updateMock, rows);
const txSelectReturns = (rows: unknown[]) => selectReturnsOn(txSelectMock, rows);
const txUpdateReturns = (rows: unknown[]) => updateReturnsOn(txUpdateMock, rows);

function insertReturns(rows: unknown[]) {
  const valuesSpy = vi.fn();

  insertMock.mockReturnValueOnce({
    values: (values: unknown) => {
      valuesSpy(values);

      return { returning: () => Promise.resolve(rows) };
    },
  });

  return { valuesSpy };
}

function deleteReturns(rows: unknown[]) {
  const whereSpy = vi.fn();

  deleteMock.mockReturnValueOnce({
    where: (whereArg: unknown) => {
      whereSpy(whereArg);

      return { returning: () => Promise.resolve(rows) };
    },
  });

  return { whereSpy };
}

const pgDialect = new PgDialect();

/** Renders a captured drizzle WHERE expression to literal SQL text and its bound params. */
function whereSql(whereArg: unknown): { sql: string; params: unknown[] } {
  return pgDialect.sqlToQuery(whereArg as Parameters<PgDialect['sqlToQuery']>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveSessionMock.mockResolvedValue(sessionIdentity());
  transactionMock.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({ select: txSelectMock, update: txUpdateMock }),
  );
});

describe('requestLimitChange', () => {
  it('rejects when there is no session — never touches the database', async () => {
    resolveSessionMock.mockResolvedValue(null);

    await expect(requestLimitChange(LIMIT_ID, '300', 'corr-1')).rejects.toThrow(PendingChangeRejected);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('rejects when the caller has no active constitution', async () => {
    selectReturns([]);

    await expect(requestLimitChange(LIMIT_ID, '300', 'corr-2')).rejects.toThrow(PendingChangeRejected);
  });

  it('rejects an unknown limit id', async () => {
    selectReturns([activeRow()]);

    await expect(requestLimitChange('no-such-limit', '300', 'corr-3')).rejects.toThrow(PendingChangeRejected);
    expect(updateMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('rejects a no-op value with no write and no event', async () => {
    selectReturns([activeRow()]);

    await expect(requestLimitChange(LIMIT_ID, '500', 'corr-4')).rejects.toThrow(PendingChangeRejected);
    expect(updateMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
    expect(recordEventMock).not.toHaveBeenCalled();
  });

  /** Decrease applies immediately and is reflected in `constitutions.document`. */
  it('applies a decrease immediately, writes it into constitutions.document, and records constitution.limit_decreased', async () => {
    selectReturns([activeRow()]);
    const { setSpy, whereSpy } = updateReturns([
      activeRow({ document: constitutionDocument({ maxUsd: '300' }) }),
    ]);

    const result = await requestLimitChange(LIMIT_ID, '300', 'corr-5');

    expect(result.kind).toBe('applied');
    const setArg = setSpy.mock.calls[0]?.[0] as { document: Constitution };
    expect(setArg.document.limits[0]?.maxUsd).toBe('300');
    expect(insertMock).not.toHaveBeenCalled();

    expect(recordEventMock.mock.calls[0]?.[0]).toMatchObject({
      eventType: 'constitution.limit_decreased',
      correlationId: 'corr-5',
      payload: expect.objectContaining({ constitutionId: CONSTITUTION_ID, limitId: LIMIT_ID, oldValue: '500', newValue: '300' }),
    });

    // Only an `active` row may be mutated this way — the same WHERE-carries-the-precondition
    // shape as `commitment.ts`'s `updateExistingDraft`.
    const { sql: whereClause, params } = whereSql(whereSpy.mock.calls[0]?.[0]);
    expect(whereClause).toContain('"status" =');
    expect(params).toContain('active');
  });

  /** Increase never touches `document` and does not apply before `effective_at`, even across repeated `applyDuePendingChanges` calls. */
  it('schedules an increase without touching document, and it stays pending across repeated applyDuePendingChanges calls', async () => {
    selectReturns([activeRow()]); // loadActiveConstitutionForUser
    selectReturns([]); // assertNoExistingPendingChange: nothing pending yet
    const { valuesSpy } = insertReturns([pendingRow()]);

    const result = await requestLimitChange(LIMIT_ID, '900', 'corr-6');

    expect(result.kind).toBe('pending');
    expect(updateMock).not.toHaveBeenCalled();
    const inserted = valuesSpy.mock.calls[0]?.[0] as { constitutionId: string; limitId: string; newValue: string };
    expect(inserted.constitutionId).toBe(CONSTITUTION_ID);
    expect(inserted.limitId).toBe(LIMIT_ID);
    expect(inserted.newValue).toBe('900');

    expect(recordEventMock.mock.calls[0]?.[0]).toMatchObject({
      eventType: 'constitution.limit_increase_requested',
      correlationId: 'corr-6',
    });

    // Not yet due: the DB-side WHERE (`effective_at <= now()`) would exclude it, simulated
    // here by the due-rows query itself returning nothing — repeated calls must not change
    // that outcome or ever touch a transaction.
    selectReturns([]);
    const firstPass = await applyDuePendingChanges('corr-7');
    selectReturns([]);
    const secondPass = await applyDuePendingChanges('corr-7');

    expect(firstPass).toBe(0);
    expect(secondPass).toBe(0);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('rejects a second increase request while one is already pending for the same limit', async () => {
    selectReturns([activeRow()]);
    selectReturns([{ id: 'pending-existing' }]); // assertNoExistingPendingChange finds one

    await expect(requestLimitChange(LIMIT_ID, '900', 'corr-8')).rejects.toThrow(PendingChangeRejected);
    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe('applyDuePendingChanges', () => {
  /** Increase applies once `effective_at` has passed. */
  it('applies a due increase into constitutions.document and records constitution.limit_increase_applied', async () => {
    const duePending = pendingRow({ effectiveAt: new Date(Date.now() - 1_000) });
    selectReturns([{ id: duePending.id }]); // due-rows scan

    txSelectReturns([duePending]); // claim the pending row under FOR UPDATE
    txSelectReturns([activeRow()]); // load the constitution row under FOR UPDATE
    const { setSpy: documentSetSpy } = txUpdateReturns([]); // fold the new value into `document`
    txUpdateReturns([{ ...duePending, appliedAt: new Date() }]); // mark the row applied

    const appliedCount = await applyDuePendingChanges('corr-9');

    expect(appliedCount).toBe(1);
    const documentSetArg = documentSetSpy.mock.calls[0]?.[0] as { document: Constitution };
    expect(documentSetArg.document.limits[0]?.maxUsd).toBe(duePending.newValue);

    expect(recordEventMock.mock.calls[0]?.[0]).toMatchObject({
      eventType: 'constitution.limit_increase_applied',
      correlationId: 'corr-9',
      payload: expect.objectContaining({ pendingChangeId: duePending.id, newValue: duePending.newValue }),
    });
  });

  it('is a no-op when the due-rows scan finds nothing', async () => {
    selectReturns([]);

    const appliedCount = await applyDuePendingChanges('corr-10');

    expect(appliedCount).toBe(0);
    expect(transactionMock).not.toHaveBeenCalled();
  });
});

describe('cancelPendingChange', () => {
  it('rejects when there is no session', async () => {
    resolveSessionMock.mockResolvedValue(null);

    await expect(cancelPendingChange('pending-1', 'corr-11')).rejects.toThrow(PendingChangeRejected);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('deletes the pending row, scoped to the caller\'s own constitution, and records constitution.limit_increase_cancelled', async () => {
    selectReturns([activeRow()]); // loadActiveConstitutionForUser
    const cancelled = pendingRow();
    const { whereSpy } = deleteReturns([cancelled]);

    await cancelPendingChange(cancelled.id, 'corr-12');

    expect(recordEventMock.mock.calls[0]?.[0]).toMatchObject({
      eventType: 'constitution.limit_increase_cancelled',
      correlationId: 'corr-12',
      payload: expect.objectContaining({ pendingChangeId: cancelled.id, constitutionId: CONSTITUTION_ID }),
    });

    const { sql: whereClause, params } = whereSql(whereSpy.mock.calls[0]?.[0]);
    expect(whereClause).toContain('"constitution_id" =');
    expect(whereClause).toContain('"applied_at" is null');
    expect(params).toContain(cancelled.id);
    expect(params).toContain(CONSTITUTION_ID);
  });

  it('rejects cancelling a row that is not the caller\'s own, or is already applied/gone', async () => {
    selectReturns([activeRow()]);
    deleteReturns([]); // the conditional DELETE ... WHERE matches nothing

    await expect(cancelPendingChange('someone-elses-pending', 'corr-13')).rejects.toThrow(PendingChangeRejected);
    expect(recordEventMock).not.toHaveBeenCalled();
  });

  /** A cancelled pending change is never applied — the row is gone, so the due-rows scan can never find it again. */
  it('a cancelled pending change is never picked up by a later applyDuePendingChanges pass', async () => {
    selectReturns([activeRow()]);
    deleteReturns([pendingRow()]);

    await cancelPendingChange('pending-1', 'corr-14');

    // The row no longer exists, so the due-rows scan (the same query real Postgres would run
    // after the DELETE committed) finds nothing left to apply.
    selectReturns([]);
    const appliedCount = await applyDuePendingChanges('corr-15');

    expect(appliedCount).toBe(0);
    expect(transactionMock).not.toHaveBeenCalled();
  });
});
