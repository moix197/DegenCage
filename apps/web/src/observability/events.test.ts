import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { events } from '../server/db/schema';
import { recordEvent } from './events';

const { insertMock, valuesMock } = vi.hoisted(() => ({
  insertMock: vi.fn(),
  valuesMock: vi.fn(),
}));

vi.mock('../server/db/client', () => ({ getDb: () => ({ insert: insertMock }) }));

/** Mimics drizzle's `insert(table).values(row)` chain. */
function captureInsert() {
  valuesMock.mockResolvedValue(undefined);
  insertMock.mockReturnValue({ values: valuesMock });
}

function insertedRow(): Record<string, unknown> {
  return valuesMock.mock.calls[0]?.[0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  captureInsert();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('recordEvent', () => {
  it('persists occurred_at, correlation_id, user and payload as given', async () => {
    const occurredAt = new Date('2026-08-20T10:00:00Z');

    await recordEvent({
      eventType: 'auth.session_created',
      occurredAt,
      correlationId: 'trade-intent-1',
      userId: 'user-1',
      payload: { walletAddress: 'So1111' },
    });

    expect(insertMock).toHaveBeenCalledWith(events);
    expect(insertedRow()).toMatchObject({
      eventType: 'auth.session_created',
      occurredAt,
      correlationId: 'trade-intent-1',
      userId: 'user-1',
      payload: { walletAddress: 'So1111' },
    });
  });

  it('stamps observed_at server-side, distinct from occurred_at', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T12:00:00Z'));

    await recordEvent({
      eventType: 'wallet.reconciliation_completed',
      occurredAt: new Date('2026-08-05T09:30:00Z'),
      correlationId: 'trade-intent-2',
    });

    const row = insertedRow();
    expect(row['observedAt']).toEqual(new Date('2026-08-26T12:00:00Z'));
    expect(row['occurredAt']).toEqual(new Date('2026-08-05T09:30:00Z'));
  });

  it('overwrites a caller-supplied observed_at rather than trusting it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T12:00:00Z'));

    const backdated = { observedAt: new Date('2020-01-01T00:00:00Z') };

    await recordEvent({
      eventType: 'rule.decision_recorded',
      occurredAt: new Date('2026-08-26T11:59:00Z'),
      correlationId: 'trade-intent-3',
      ...backdated,
    } as Parameters<typeof recordEvent>[0]);

    expect(insertedRow()['observedAt']).toEqual(new Date('2026-08-26T12:00:00Z'));
  });

  it('defaults an absent user and payload rather than writing undefined', async () => {
    await recordEvent({
      eventType: 'auth.session_revoked',
      occurredAt: new Date('2026-08-26T12:00:00Z'),
      correlationId: 'trade-intent-4',
    });

    expect(insertedRow()).toMatchObject({ userId: null, payload: {} });
  });

  it('writes through a caller-supplied executor so the event joins its transaction', async () => {
    const txValues = vi.fn().mockResolvedValue(undefined);
    const tx = { insert: vi.fn().mockReturnValue({ values: txValues }) };

    await recordEvent(
      {
        eventType: 'auth.session_created',
        occurredAt: new Date('2026-08-26T12:00:00Z'),
        correlationId: 'trade-intent-5',
      },
      tx as unknown as Parameters<typeof recordEvent>[1],
    );

    expect(txValues).toHaveBeenCalledOnce();
    expect(insertMock).not.toHaveBeenCalled();
  });
});
