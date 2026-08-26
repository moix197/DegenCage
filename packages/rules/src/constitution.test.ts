import { describe, expect, it } from 'vitest';

import {
  CONSTITUTION_SCHEMA_VERSION,
  migrateConstitution,
  parseConstitution,
  type Constitution,
} from './constitution';

function wellFormedConstitution(): Constitution {
  return {
    schemaVersion: CONSTITUTION_SCHEMA_VERSION,
    limits: [
      { id: 'limit-1', type: 'daily_notional_usd', maxUsd: '500', windowHours: 24 },
      {
        id: 'limit-2',
        type: 'asset_tier_acquisition_usd',
        tier: 'MEMECOIN',
        maxUsd: '100',
        windowHours: 24,
      },
      { id: 'limit-3', type: 'rolling_loss_usd', maxUsd: '250.50', windowHours: 168 },
    ],
  };
}

describe('parseConstitution', () => {
  it('accepts a well-formed constitution carrying all three limit types', () => {
    const result = parseConstitution(wellFormedConstitution());

    expect(result).toEqual({ ok: true, constitution: wellFormedConstitution() });
  });

  it('rejects a document that is not an object', () => {
    expect(parseConstitution(null)).toEqual({ ok: false, reason: 'invalid_document' });
    expect(parseConstitution('not a constitution')).toEqual({
      ok: false,
      reason: 'invalid_document',
    });
  });

  it('rejects an unsupported schema version', () => {
    const doc = { ...wellFormedConstitution(), schemaVersion: 99 };

    expect(parseConstitution(doc)).toEqual({ ok: false, reason: 'unsupported_schema_version' });
  });

  it('rejects a document whose limits is not an array', () => {
    const doc = { schemaVersion: CONSTITUTION_SCHEMA_VERSION, limits: 'nope' };

    expect(parseConstitution(doc)).toEqual({ ok: false, reason: 'limits_not_an_array' });
  });

  it('rejects a limit missing its id', () => {
    const doc = {
      schemaVersion: CONSTITUTION_SCHEMA_VERSION,
      limits: [{ type: 'daily_notional_usd', maxUsd: '500', windowHours: 24 }],
    };

    expect(parseConstitution(doc)).toEqual({ ok: false, reason: 'invalid_limit_id' });
  });

  it('rejects a non-positive maxUsd', () => {
    const zero = {
      schemaVersion: CONSTITUTION_SCHEMA_VERSION,
      limits: [{ id: 'limit-1', type: 'daily_notional_usd', maxUsd: '0', windowHours: 24 }],
    };
    const negative = {
      schemaVersion: CONSTITUTION_SCHEMA_VERSION,
      limits: [{ id: 'limit-1', type: 'daily_notional_usd', maxUsd: '-5', windowHours: 24 }],
    };
    const notANumber = {
      schemaVersion: CONSTITUTION_SCHEMA_VERSION,
      limits: [{ id: 'limit-1', type: 'daily_notional_usd', maxUsd: 'abc', windowHours: 24 }],
    };

    expect(parseConstitution(zero)).toEqual({ ok: false, reason: 'invalid_max_usd' });
    expect(parseConstitution(negative)).toEqual({ ok: false, reason: 'invalid_max_usd' });
    expect(parseConstitution(notANumber)).toEqual({ ok: false, reason: 'invalid_max_usd' });
  });

  it('rejects a non-positive windowHours', () => {
    const doc = {
      schemaVersion: CONSTITUTION_SCHEMA_VERSION,
      limits: [{ id: 'limit-1', type: 'daily_notional_usd', maxUsd: '500', windowHours: 0 }],
    };

    expect(parseConstitution(doc)).toEqual({ ok: false, reason: 'invalid_window_hours' });
  });

  it('rejects an unknown limit type', () => {
    const doc = {
      schemaVersion: CONSTITUTION_SCHEMA_VERSION,
      limits: [{ id: 'limit-1', type: 'yolo_unlimited', maxUsd: '500', windowHours: 24 }],
    };

    expect(parseConstitution(doc)).toEqual({ ok: false, reason: 'unknown_limit_type' });
  });

  it('rejects an asset_tier_acquisition_usd limit with an invalid tier', () => {
    const doc = {
      schemaVersion: CONSTITUTION_SCHEMA_VERSION,
      limits: [
        { id: 'limit-1', type: 'asset_tier_acquisition_usd', tier: 'DOGE', maxUsd: '100', windowHours: 24 },
      ],
    };

    expect(parseConstitution(doc)).toEqual({ ok: false, reason: 'invalid_asset_tier' });
  });

  it('rejects duplicate limit ids, since Phase 8 addresses limits by stable id', () => {
    const doc = {
      schemaVersion: CONSTITUTION_SCHEMA_VERSION,
      limits: [
        { id: 'limit-1', type: 'daily_notional_usd', maxUsd: '500', windowHours: 24 },
        { id: 'limit-1', type: 'rolling_loss_usd', maxUsd: '100', windowHours: 24 },
      ],
    };

    expect(parseConstitution(doc)).toEqual({ ok: false, reason: 'duplicate_limit_id' });
  });
});

describe('migrateConstitution', () => {
  it('passes a document already at the current version straight through', () => {
    expect(migrateConstitution(wellFormedConstitution())).toEqual(wellFormedConstitution());
  });

  it('upgrades a hypothetical pre-versioning shape (no schemaVersion, no windowHours) to current', () => {
    const legacy = {
      limits: [{ id: 'limit-1', type: 'daily_notional_usd', maxUsd: '500' }],
    };

    expect(migrateConstitution(legacy)).toEqual({
      schemaVersion: CONSTITUTION_SCHEMA_VERSION,
      limits: [{ id: 'limit-1', type: 'daily_notional_usd', maxUsd: '500', windowHours: 24 }],
    });
  });

  it('throws rather than silently accepting a stored document that is corrupt', () => {
    expect(() => migrateConstitution({ limits: [{ id: 'limit-1', type: 'daily_notional_usd' }] })).toThrow();
  });

  it('throws on a non-object', () => {
    expect(() => migrateConstitution(null)).toThrow();
  });
});
