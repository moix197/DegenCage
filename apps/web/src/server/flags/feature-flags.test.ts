import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FeatureFlagRow } from '../db/schema';
import {
  isFeatureEnabled,
  loadFeatureFlagStatus,
  resolveFeatureFlag,
} from './feature-flags';

const { selectMock, captureErrorMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  captureErrorMock: vi.fn(),
}));

vi.mock('../db/client', () => ({ getDb: () => ({ select: selectMock }) }));
vi.mock('../../observability/error-tracking', () => ({ captureError: captureErrorMock }));

function row(overrides: Partial<FeatureFlagRow> = {}): FeatureFlagRow {
  return {
    key: 'auth.wallet_connect',
    enabled: true,
    scope: null,
    updatedAt: new Date('2026-08-26T00:00:00Z'),
    ...overrides,
  };
}

/** Mimics drizzle's `select().from().where().limit()` chain. */
function lookupReturning(result: FeatureFlagRow[] | Error) {
  selectMock.mockReturnValue({
    from: () => ({
      where: () => ({
        limit: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)),
      }),
    }),
  });
}

/** Mimics drizzle's awaitable `select({ total }).from()` chain. */
function countReturning(result: { total: number }[] | Error) {
  selectMock.mockReturnValue({
    from: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveFeatureFlag', () => {
  it('is disabled when no row exists — unknown key means off', () => {
    expect(resolveFeatureFlag(undefined)).toBe(false);
  });

  it('is disabled when the row exists but is off', () => {
    expect(resolveFeatureFlag(row({ enabled: false }))).toBe(false);
  });

  it('is enabled globally when the row is on and unscoped', () => {
    expect(resolveFeatureFlag(row())).toBe(true);
    expect(resolveFeatureFlag(row({ scope: {} }))).toBe(true);
    expect(resolveFeatureFlag(row({ scope: { userIds: [] } }))).toBe(true);
  });

  it('honours a per-user scope, and excludes everyone else', () => {
    const scoped = row({ scope: { userIds: ['user-1'] } });

    expect(resolveFeatureFlag(scoped, { userId: 'user-1' })).toBe(true);
    expect(resolveFeatureFlag(scoped, { userId: 'user-2' })).toBe(false);
    expect(resolveFeatureFlag(scoped)).toBe(false);
  });
});

describe('isFeatureEnabled', () => {
  it('respects a seeded, enabled row', async () => {
    lookupReturning([row({ key: 'web.home_status_panel' })]);

    await expect(isFeatureEnabled('web.home_status_panel')).resolves.toBe(true);
  });

  it('fails closed for an unknown key', async () => {
    lookupReturning([]);

    await expect(isFeatureEnabled('never.seeded')).resolves.toBe(false);
  });

  it('fails closed when the database is unreachable, and reports the error', async () => {
    lookupReturning(new Error('connection terminated'));

    await expect(isFeatureEnabled('auth.wallet_connect')).resolves.toBe(false);
    expect(captureErrorMock).toHaveBeenCalledOnce();
    expect(captureErrorMock.mock.calls[0]?.[1]).toMatchObject({
      flagKey: 'auth.wallet_connect',
      failedClosed: true,
    });
  });
});

describe('loadFeatureFlagStatus', () => {
  it('reports connected with the row count on a successful round trip', async () => {
    countReturning([{ total: 3 }]);

    await expect(loadFeatureFlagStatus()).resolves.toEqual({ connected: true, flagCount: 3 });
  });

  it('reports not-connected rather than an empty flag set when the query fails', async () => {
    countReturning(new Error('connection terminated'));

    await expect(loadFeatureFlagStatus()).resolves.toEqual({ connected: false, flagCount: 0 });
    expect(captureErrorMock).toHaveBeenCalledOnce();
  });
});
