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
import { ConstitutionActionRateLimited } from './rate-limit';

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
  isFeatureEnabledMock,
  assertWithinConstitutionActionRateLimitMock,
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
  isFeatureEnabledMock: vi.fn(),
  assertWithinConstitutionActionRateLimitMock: vi.fn(),
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
vi.mock('../flags/feature-flags', () => ({ isFeatureEnabled: isFeatureEnabledMock }));
// Only `assertWithinConstitutionActionRateLimit` is mocked — `ConstitutionActionRateLimited`
// stays the real class (spread from `actual`), so `instanceof` checks in `pending-changes.ts`
// and the `mockRejectedValueOnce(new ConstitutionActionRateLimited())` calls below refer to
// the exact same constructor. Mocking the DB query this function itself runs (rather than the
// query result) is deliberate here: unlike every other query in this file, the same
// `assertWithinConstitutionActionRateLimit` call is shared by two very different call sites
// (gate the action; separately, self-throttle the `edit_rate_limited` event write), and both
// need independent per-test control that a shared `selectMock` sequence cannot give cleanly.
vi.mock('./rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./rate-limit')>();

  return { ...actual, assertWithinConstitutionActionRateLimit: assertWithinConstitutionActionRateLimitMock };
});

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
    voidedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

/** A thenable that is also chainable with `.limit()` / `.for('update').limit()` / `.orderBy().limit()` — covers every shape `select().from().where()` takes across this module. */
function queryResult(rows: unknown[]) {
  const promise = Promise.resolve(rows);

  return Object.assign(promise, {
    limit: () => Promise.resolve(rows),
    for: () => ({ limit: () => Promise.resolve(rows) }),
    // Recurses so `.orderBy()` itself is awaitable AND further chainable with `.limit()` —
    // the due-rows scan's `select().from().where().orderBy().limit(N)` shape.
    orderBy: () => queryResult(rows),
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

/** Same as `selectReturnsOn`, but captures the WHERE predicate, the `.orderBy(...)` argument, and the `.limit(n)` argument — the due-rows scan's `select().from().where().orderBy().limit(N)` shape. */
function selectReturnsCapturingWhereOrderAndLimit(mock: ReturnType<typeof vi.fn>, rows: unknown[]) {
  const whereSpy = vi.fn();
  const orderBySpy = vi.fn();
  const limitSpy = vi.fn();

  mock.mockReturnValueOnce({
    from: () => ({
      where: (whereArg: unknown) => {
        whereSpy(whereArg);

        return {
          orderBy: (orderArg: unknown) => {
            orderBySpy(orderArg);

            return {
              limit: (n: unknown) => {
                limitSpy(n);

                return Promise.resolve(rows);
              },
            };
          },
        };
      },
    }),
  });

  return { whereSpy, orderBySpy, limitSpy };
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
  // On by default so every existing test exercises the real apply/void logic; the kill-switch
  // tests below override this per-call.
  isFeatureEnabledMock.mockResolvedValue(true);
  // Not rate limited by default — the rate-limit tests below override this per-call. Every
  // other test in this file exercises the increase/cancel paths as if the caller were nowhere
  // near the throttle.
  assertWithinConstitutionActionRateLimitMock.mockResolvedValue(undefined);
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

    expect(firstPass).toEqual({ appliedCount: 0, voidedCount: 0 });
    expect(secondPass).toEqual({ appliedCount: 0, voidedCount: 0 });
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
    txSelectReturns([activeRow()]); // load the constitution row under FOR UPDATE (current maxUsd '500' === oldValue '500')
    const { setSpy: documentSetSpy } = txUpdateReturns([]); // fold the new value into `document`
    txUpdateReturns([{ ...duePending, appliedAt: new Date() }]); // mark the row applied

    const result = await applyDuePendingChanges('corr-9');

    expect(result).toEqual({ appliedCount: 1, voidedCount: 0 });
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

    const result = await applyDuePendingChanges('corr-10');

    expect(result).toEqual({ appliedCount: 0, voidedCount: 0 });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  /**
   * The stale-value repro: request an increase 500→900, then a decrease lands (500→10)
   * before the 48h elapses — simulated here by the constitution row `applyOneDuePendingChange`
   * loads having a *current* `maxUsd` ('10') that no longer matches the pending row's
   * `old_value` ('500'). Applying `new_value` ('900') on top would silently jump the limit
   * from the user's actual current value (10) to 900 — an increase never requested from that
   * baseline. The row must be voided, not applied, and `document` must stay untouched.
   */
  it('voids a due increase whose old_value no longer matches the limit\'s current value, without touching document', async () => {
    const duePending = pendingRow({ oldValue: '500', newValue: '900', effectiveAt: new Date(Date.now() - 1_000) });
    selectReturns([{ id: duePending.id }]); // due-rows scan

    txSelectReturns([duePending]); // claim the pending row under FOR UPDATE
    // The limit's current maxUsd has moved to '10' since the increase was requested — a
    // decrease that landed in between.
    txSelectReturns([activeRow({ document: constitutionDocument({ maxUsd: '10' }) })]);
    const { setSpy: voidSetSpy, whereSpy: voidWhereSpy } = txUpdateReturns([{ ...duePending, voidedAt: new Date() }]);

    const result = await applyDuePendingChanges('corr-stale');

    expect(result).toEqual({ appliedCount: 0, voidedCount: 1 });
    // Exactly one tx.update call (the voided-row bookkeeping) — never the `constitutions`
    // document update the applied path would also make.
    expect(txUpdateMock).toHaveBeenCalledTimes(1);
    expect((voidSetSpy.mock.calls[0]?.[0] as { voidedAt: unknown }).voidedAt).toBeDefined();
    const { params: voidWhereParams } = whereSql(voidWhereSpy.mock.calls[0]?.[0]);
    expect(voidWhereParams).toContain(duePending.id);

    expect(recordEventMock.mock.calls[0]?.[0]).toMatchObject({
      eventType: 'constitution.limit_increase_voided',
      correlationId: 'corr-stale',
      payload: expect.objectContaining({
        pendingChangeId: duePending.id,
        expectedOldValue: '500',
        observedCurrentValue: '10',
        newValue: '900',
      }),
    });
  });

  /**
   * The decimal-vs-string-equality bug: `"500"` and `"500.00"` are the same value, so a
   * pending row requested against `oldValue: '500'` must still apply — not void — when the
   * limit's current `maxUsd` happens to be stored/observed as `'500.00'` by the time it
   * becomes due. A raw `!==` string comparison would wrongly treat this as a stale value and
   * void a legitimate increase; `compareUsd` must be used instead.
   */
  it('applies a due increase whose current value is the same amount in different decimal formatting (500 vs 500.00)', async () => {
    const duePending = pendingRow({ oldValue: '500', newValue: '900', effectiveAt: new Date(Date.now() - 1_000) });
    selectReturns([{ id: duePending.id }]); // due-rows scan

    txSelectReturns([duePending]); // claim the pending row under FOR UPDATE
    // The limit's current maxUsd is formatted with trailing zeros but is the same value.
    txSelectReturns([activeRow({ document: constitutionDocument({ maxUsd: '500.00' }) })]);
    const { setSpy: documentSetSpy } = txUpdateReturns([]); // fold the new value into `document`
    txUpdateReturns([{ ...duePending, appliedAt: new Date() }]); // mark the row applied

    const result = await applyDuePendingChanges('corr-decimal-format');

    expect(result).toEqual({ appliedCount: 1, voidedCount: 0 });
    const documentSetArg = documentSetSpy.mock.calls[0]?.[0] as { document: Constitution };
    expect(documentSetArg.document.limits[0]?.maxUsd).toBe('900');

    expect(recordEventMock.mock.calls[0]?.[0]).toMatchObject({
      eventType: 'constitution.limit_increase_applied',
      correlationId: 'corr-decimal-format',
    });
  });

  /**
   * The kill switch: off, nothing is claimed, voided, or applied — the row simply waits.
   * `applyDuePendingChanges` still counts how many rows are stranded (for telemetry), so
   * `selectMock` *is* called once here (the count query) even though no transaction runs.
   */
  it('is a no-op when CONSTITUTION_PENDING_CHANGE_APPLY_FLAG is off', async () => {
    isFeatureEnabledMock.mockResolvedValue(false);
    selectReturns([{ total: 0 }]); // countDueRows: nothing stranded

    const result = await applyDuePendingChanges('corr-flag-off');

    expect(result).toEqual({ appliedCount: 0, voidedCount: 0 });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  /** Same as above, but with a real backlog — exercises the stranded-row count path without asserting on log output (this codebase does not mock `logger` in tests). */
  it('still counts stranded rows when the kill switch is off and a backlog exists', async () => {
    isFeatureEnabledMock.mockResolvedValue(false);
    selectReturns([{ total: 3 }]); // countDueRows: 3 rows are due but the switch is off

    const result = await applyDuePendingChanges('corr-flag-off-backlog');

    expect(result).toEqual({ appliedCount: 0, voidedCount: 0 });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  /** The real `effective_at <= now() AND applied_at IS NULL AND voided_at IS NULL` predicate, oldest-due-first ordering, and the batch cap. */
  it('scans with the real due predicate, orders oldest-due-first, and caps the batch size', async () => {
    const { whereSpy, orderBySpy, limitSpy } = selectReturnsCapturingWhereOrderAndLimit(selectMock, []);

    await applyDuePendingChanges('corr-predicate');

    const { sql: whereClause } = whereSql(whereSpy.mock.calls[0]?.[0]);
    expect(whereClause).toContain('"applied_at" is null');
    expect(whereClause).toContain('"voided_at" is null');
    expect(whereClause).toContain('"effective_at" <=');
    expect(orderBySpy).toHaveBeenCalledTimes(1);
    expect(limitSpy.mock.calls[0]?.[0]).toBeGreaterThan(0);
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
    expect(whereClause).toContain('"voided_at" is null');
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
    const result = await applyDuePendingChanges('corr-15');

    expect(result).toEqual({ appliedCount: 0, voidedCount: 0 });
    expect(transactionMock).not.toHaveBeenCalled();
  });
});

describe('rate limiting (loosening actions only)', () => {
  it('rejects an increase request once the loosening rate limit is exceeded, and records constitution.edit_rate_limited', async () => {
    selectReturns([activeRow()]); // loadActiveConstitutionForUser, reached before the gate
    assertWithinConstitutionActionRateLimitMock.mockRejectedValueOnce(new ConstitutionActionRateLimited());
    // The second call — `recordRateLimitedAttempt`'s own self-throttle check on the
    // `edit_rate_limited` write — falls through to `beforeEach`'s default (not limited).

    await expect(requestLimitChange(LIMIT_ID, '900', 'corr-rl-1')).rejects.toThrow(PendingChangeRejected);

    expect(insertMock).not.toHaveBeenCalled();
    expect(recordEventMock.mock.calls[0]?.[0]).toMatchObject({
      eventType: 'constitution.edit_rate_limited',
      correlationId: 'corr-rl-1',
      payload: expect.objectContaining({ path: 'increase_requested', limitId: LIMIT_ID }),
    });
  });

  /** Cancelling a pending increase is gated too — it edits commitment state, the same reason a request is gated. */
  it('rejects a cancel request once the loosening rate limit is exceeded, and records constitution.edit_rate_limited', async () => {
    assertWithinConstitutionActionRateLimitMock.mockRejectedValueOnce(new ConstitutionActionRateLimited());

    await expect(cancelPendingChange('pending-1', 'corr-rl-2')).rejects.toThrow(PendingChangeRejected);

    expect(deleteMock).not.toHaveBeenCalled();
    expect(recordEventMock.mock.calls[0]?.[0]).toMatchObject({
      eventType: 'constitution.edit_rate_limited',
      correlationId: 'corr-rl-2',
      payload: expect.objectContaining({ path: 'cancel_pending', pendingChangeId: 'pending-1' }),
    });
  });

  /** Fail-closed direction: a limiter that cannot answer must REJECT the loosening it was asked to gate, never let it through. */
  it('fails closed on an increase when the rate limiter itself is unavailable — rejects, never lets the increase through', async () => {
    selectReturns([activeRow()]);
    const limiterOutage = new Error('rate limiter database unavailable');
    assertWithinConstitutionActionRateLimitMock.mockRejectedValueOnce(limiterOutage);

    await expect(requestLimitChange(LIMIT_ID, '900', 'corr-rl-3')).rejects.toBe(limiterOutage);

    expect(insertMock).not.toHaveBeenCalled();
    expect(recordEventMock).not.toHaveBeenCalled();
  });

  it('fails closed on a cancel when the rate limiter itself is unavailable', async () => {
    const limiterOutage = new Error('rate limiter database unavailable');
    assertWithinConstitutionActionRateLimitMock.mockRejectedValueOnce(limiterOutage);

    await expect(cancelPendingChange('pending-1', 'corr-rl-4')).rejects.toBe(limiterOutage);

    expect(deleteMock).not.toHaveBeenCalled();
    expect(recordEventMock).not.toHaveBeenCalled();
  });

  /**
   * The asymmetry's whole point: a decrease never calls the limiter at all, so a limiter
   * outage — even a permanent one, configured here to reject every call — can never block
   * tightening. This is the opposite fail-closed direction from the increase/cancel tests
   * above, and it is the important one: tightening must stay safe *unconditionally*.
   */
  it('never calls the rate limiter on a decrease, even when the limiter is permanently unavailable', async () => {
    selectReturns([activeRow()]);
    updateReturns([activeRow({ document: constitutionDocument({ maxUsd: '300' }) })]);
    assertWithinConstitutionActionRateLimitMock.mockRejectedValue(new Error('rate limiter database unavailable'));

    const result = await requestLimitChange(LIMIT_ID, '300', 'corr-rl-5');

    expect(result.kind).toBe('applied');
    expect(assertWithinConstitutionActionRateLimitMock).not.toHaveBeenCalled();
  });

  /** The self-throttle: hammering past the limit must not also grow `constitution.edit_rate_limited` without bound. */
  it('does not record constitution.edit_rate_limited once that event type is itself already at its own throttle', async () => {
    assertWithinConstitutionActionRateLimitMock.mockRejectedValue(new ConstitutionActionRateLimited());

    await expect(cancelPendingChange('pending-1', 'corr-rl-6')).rejects.toThrow(PendingChangeRejected);

    expect(recordEventMock).not.toHaveBeenCalled();
    // Both calls happened — the gate, then `recordRateLimitedAttempt`'s own self-throttle
    // check — confirming this is the self-throttle suppressing the write, not the gate simply
    // never trying to record anything.
    expect(assertWithinConstitutionActionRateLimitMock).toHaveBeenCalledTimes(2);
  });
});
