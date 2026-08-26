import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Constitution } from '@degencage/rules';

import {
  COMMITMENT_PERIOD_MS,
  ConstitutionActionRejected,
  activateConstitution,
  saveDraftConstitution,
  startCommitment,
} from './commitment';

const { selectMock, updateMock, insertMock, resolveSessionMock, recordEventMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  updateMock: vi.fn(),
  insertMock: vi.fn(),
  resolveSessionMock: vi.fn(),
  recordEventMock: vi.fn(),
}));

vi.mock('../db/client', () => ({
  getDb: () => ({ select: selectMock, update: updateMock, insert: insertMock }),
}));
vi.mock('../auth/session', () => ({ resolveSession: resolveSessionMock }));
vi.mock('../../observability/events', () => ({ recordEvent: recordEventMock }));

const SESSION_USER_ID = 'user-1';
const SESSION_WALLET_ID = 'wallet-1';
const FORGED_WALLET_ID = 'attacker-supplied-wallet-id';

function sessionIdentity() {
  return {
    walletAddress: 'So11111111111111111111111111111111111111112',
    walletId: SESSION_WALLET_ID,
    userId: SESSION_USER_ID,
    expiresAt: new Date(Date.now() + 60_000),
    idHash: 'session-hash',
  };
}

function constitutionDocument(): Constitution {
  return {
    schemaVersion: 1,
    limits: [{ id: 'limit-1', type: 'daily_notional_usd', maxUsd: '500', windowHours: 24 }],
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'constitution-1',
    userId: SESSION_USER_ID,
    walletId: SESSION_WALLET_ID,
    status: 'draft',
    document: constitutionDocument(),
    schemaVersion: 1,
    commitmentStartedAt: null,
    activatedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

/** Mimics drizzle's `select().from().where().limit()` chain. */
function selectReturns(rows: unknown[]) {
  selectMock.mockReturnValue({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(rows),
      }),
    }),
  });
}

/** Mimics drizzle's `update().set().where().returning()` chain, capturing what was set. */
function updateReturns(rows: unknown[]) {
  const setSpy = vi.fn();

  updateMock.mockReturnValue({
    set: (values: unknown) => {
      setSpy(values);

      return { where: () => ({ returning: () => Promise.resolve(rows) }) };
    },
  });

  return { setSpy };
}

/** Mimics drizzle's `insert().values().returning()` chain, capturing what was inserted. */
function insertReturns(rows: unknown[]) {
  const valuesSpy = vi.fn();

  insertMock.mockReturnValue({
    values: (values: unknown) => {
      valuesSpy(values);

      return { returning: () => Promise.resolve(rows) };
    },
  });

  return { valuesSpy };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveSessionMock.mockResolvedValue(sessionIdentity());
});

describe('saveDraftConstitution', () => {
  it('rejects when there is no session — never touches the database', async () => {
    resolveSessionMock.mockResolvedValue(null);

    await expect(saveDraftConstitution(constitutionDocument(), 'trade-intent-1')).rejects.toThrow(
      ConstitutionActionRejected,
    );
    expect(selectMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed document without writing anything', async () => {
    selectReturns([]);

    await expect(
      saveDraftConstitution({ schemaVersion: 1, limits: [{ type: 'daily_notional_usd' }] }, 'trade-intent-2'),
    ).rejects.toThrow(ConstitutionActionRejected);
    expect(insertMock).not.toHaveBeenCalled();
    expect(recordEventMock).not.toHaveBeenCalled();
  });

  it('ignores a forged wallet_id in the request body — the wallet always comes from the session', async () => {
    selectReturns([]);
    const { valuesSpy } = insertReturns([row()]);

    await saveDraftConstitution(
      { ...constitutionDocument(), walletId: FORGED_WALLET_ID, userId: 'attacker-user' },
      'trade-intent-3',
    );

    const inserted = valuesSpy.mock.calls[0]?.[0] as { walletId: string; userId: string };
    expect(inserted.walletId).toBe(SESSION_WALLET_ID);
    expect(inserted.userId).toBe(SESSION_USER_ID);
    expect(inserted.walletId).not.toBe(FORGED_WALLET_ID);
  });

  it('records constitution.drafted on a successful save', async () => {
    selectReturns([]);
    insertReturns([row()]);

    await saveDraftConstitution(constitutionDocument(), 'trade-intent-4');

    expect(recordEventMock.mock.calls[0]?.[0]).toMatchObject({
      eventType: 'constitution.drafted',
      correlationId: 'trade-intent-4',
      userId: SESSION_USER_ID,
    });
  });

  it('refuses to edit a constitution that is already committing or active', async () => {
    selectReturns([row({ status: 'committing', commitmentStartedAt: new Date() })]);

    await expect(saveDraftConstitution(constitutionDocument(), 'trade-intent-5')).rejects.toThrow(
      ConstitutionActionRejected,
    );
    expect(insertMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('startCommitment', () => {
  it('rejects when there is no session', async () => {
    resolveSessionMock.mockResolvedValue(null);

    await expect(startCommitment('trade-intent-6')).rejects.toThrow(ConstitutionActionRejected);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('rejects when there is no draft to commit', async () => {
    updateReturns([]);
    selectReturns([]);

    await expect(startCommitment('trade-intent-7')).rejects.toThrow(ConstitutionActionRejected);
  });

  it('moves a draft to committing and records the event', async () => {
    const startedRow = row({ status: 'committing', commitmentStartedAt: new Date() });
    const { setSpy } = updateReturns([startedRow]);

    const result = await startCommitment('trade-intent-8');

    expect(result.status).toBe('committing');
    expect((setSpy.mock.calls[0]?.[0] as { status: string }).status).toBe('committing');
    expect(recordEventMock.mock.calls[0]?.[0]).toMatchObject({
      eventType: 'constitution.commitment_started',
      correlationId: 'trade-intent-8',
    });
  });

  /** A double-click must not restart the 20-minute clock or double-record the event. */
  it('is idempotent: re-calling while already committing re-checks instead of erroring', async () => {
    const alreadyStarted = new Date(Date.now() - 60_000);
    updateReturns([]); // the conditional UPDATE ... WHERE status='draft' matches nothing
    selectReturns([row({ status: 'committing', commitmentStartedAt: alreadyStarted })]);

    const result = await startCommitment('trade-intent-9');

    expect(result.status).toBe('committing');
    expect(result.commitmentStartedAt).toEqual(alreadyStarted);
    expect(recordEventMock).not.toHaveBeenCalled();
  });
});

describe('activateConstitution', () => {
  it('rejects when there is no session', async () => {
    resolveSessionMock.mockResolvedValue(null);

    await expect(activateConstitution('trade-intent-10')).rejects.toThrow(ConstitutionActionRejected);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('rejects when there is no committing constitution at all', async () => {
    updateReturns([]);
    selectReturns([]);

    await expect(activateConstitution('trade-intent-11')).rejects.toThrow(ConstitutionActionRejected);
  });

  it('rejects when the constitution is still a draft', async () => {
    updateReturns([]);
    selectReturns([row({ status: 'draft' })]);

    await expect(activateConstitution('trade-intent-12')).rejects.toThrow(ConstitutionActionRejected);
  });

  /**
   * The regression this whole phase exists to prevent: no client-claimed elapsed time is
   * ever passed to `activateConstitution` at all — it takes only a correlation id — so a
   * forged or replayed "it's been 20 minutes" claim has nothing to attach to. The atomic
   * UPDATE's own WHERE clause is what proves elapsed time server-side; this test simulates
   * it not matching, which is what happens whenever the deadline has not passed.
   */
  it('rejects activation before 20 minutes have elapsed, regardless of client-claimed time, and records the attempt', async () => {
    const startedAt = new Date(Date.now() - 5 * 60 * 1_000); // only 5 minutes in
    updateReturns([]); // atomic UPDATE ... WHERE commitment_started_at <= deadline matches nothing
    selectReturns([row({ status: 'committing', commitmentStartedAt: startedAt })]);

    await expect(activateConstitution('trade-intent-13')).rejects.toThrow(ConstitutionActionRejected);

    expect(recordEventMock.mock.calls[0]?.[0]).toMatchObject({
      eventType: 'constitution.activation_rejected_early',
      correlationId: 'trade-intent-13',
      payload: { requiredMs: COMMITMENT_PERIOD_MS },
    });
  });

  it('activates once the commitment period has elapsed', async () => {
    const startedAt = new Date(Date.now() - COMMITMENT_PERIOD_MS - 1_000);
    const activatedAt = new Date();
    const { setSpy } = updateReturns([
      row({ status: 'active', commitmentStartedAt: startedAt, activatedAt }),
    ]);

    const result = await activateConstitution('trade-intent-14');

    expect(result.status).toBe('active');
    expect((setSpy.mock.calls[0]?.[0] as { status: string }).status).toBe('active');
    expect(recordEventMock.mock.calls[0]?.[0]).toMatchObject({
      eventType: 'constitution.activated',
      correlationId: 'trade-intent-14',
    });
  });

  /** Re-clicking "Activate" after it already succeeded must not error or re-record anything. */
  it('is idempotent: re-activating an already-active constitution is a no-op, not a rejection', async () => {
    updateReturns([]); // the atomic UPDATE only matches status='committing', so it matches nothing
    selectReturns([row({ status: 'active', commitmentStartedAt: new Date(Date.now() - 3_600_000) })]);

    const result = await activateConstitution('trade-intent-15');

    expect(result.status).toBe('active');
    expect(recordEventMock).not.toHaveBeenCalled();
  });
});
