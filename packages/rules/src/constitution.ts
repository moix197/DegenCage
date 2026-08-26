/**
 * The constitution schema — a versioned, discriminated-union document (the plan's key
 * decision #1, accepted as-is): `Constitution`/`LimitRule`/`AssetTier` types, parsing of an
 * untrusted document, and `migrateConstitution()` for upgrading an older stored shape on
 * read.
 *
 * Pure: no I/O. Same invariant as the rest of `packages/rules` (see `src/index.ts`) — a
 * worker or on-chain consumer can reuse this verbatim.
 *
 * New limit types are new members of the `LimitRule` union plus a new evaluator case
 * (Phase 4+); the `constitutions` table and its jsonb column need no `ALTER TABLE` for
 * that. Only a breaking *reshape* of an existing field bumps `CONSTITUTION_SCHEMA_VERSION`
 * and needs a case in `migrateConstitution`.
 */

export const CONSTITUTION_SCHEMA_VERSION = 1 as const;

export type AssetTier = 'STABLE' | 'SOL' | 'BTC' | 'ETH' | 'ALT' | 'MEMECOIN';
export type LimitId = string; // stable uuid, survives edits

const ASSET_TIERS: readonly AssetTier[] = ['STABLE', 'SOL', 'BTC', 'ETH', 'ALT', 'MEMECOIN'];

export type LimitRule =
  | { id: LimitId; type: 'daily_notional_usd'; maxUsd: string; windowHours: number }
  | {
      id: LimitId;
      type: 'asset_tier_acquisition_usd';
      tier: AssetTier;
      maxUsd: string;
      windowHours: number;
    }
  | { id: LimitId; type: 'rolling_loss_usd'; maxUsd: string; windowHours: number };

export interface Constitution {
  schemaVersion: typeof CONSTITUTION_SCHEMA_VERSION;
  limits: LimitRule[];
}

/** Why an untrusted document (or a stored one, post-migration) failed validation. */
export type ConstitutionRejectionReason =
  | 'invalid_document'
  | 'unsupported_schema_version'
  | 'limits_not_an_array'
  | 'invalid_limit_id'
  | 'duplicate_limit_id'
  | 'unknown_limit_type'
  | 'invalid_max_usd'
  | 'invalid_window_hours'
  | 'invalid_asset_tier';

export type ConstitutionParseResult =
  | { ok: true; constitution: Constitution }
  | { ok: false; reason: ConstitutionRejectionReason };

type LimitParseResult = { ok: true; rule: LimitRule } | { ok: false; reason: ConstitutionRejectionReason };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** A decimal string, strictly greater than zero. Exact-decimal math itself is Phase 4+'s concern. */
function isPositiveDecimalString(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value)) {
    return false;
  }

  return Number.parseFloat(value) > 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isAssetTier(value: unknown): value is AssetTier {
  return typeof value === 'string' && (ASSET_TIERS as readonly string[]).includes(value);
}

function validateLimitRule(raw: unknown): LimitParseResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'unknown_limit_type' };
  }

  const candidate = raw as Record<string, unknown>;

  if (!isNonEmptyString(candidate.id)) {
    return { ok: false, reason: 'invalid_limit_id' };
  }

  if (!isPositiveDecimalString(candidate.maxUsd)) {
    return { ok: false, reason: 'invalid_max_usd' };
  }

  if (!isPositiveFiniteNumber(candidate.windowHours)) {
    return { ok: false, reason: 'invalid_window_hours' };
  }

  const id = candidate.id;
  const maxUsd = candidate.maxUsd;
  const windowHours = candidate.windowHours;

  switch (candidate.type) {
    case 'daily_notional_usd':
      return { ok: true, rule: { id, type: 'daily_notional_usd', maxUsd, windowHours } };

    case 'rolling_loss_usd':
      return { ok: true, rule: { id, type: 'rolling_loss_usd', maxUsd, windowHours } };

    case 'asset_tier_acquisition_usd':
      if (!isAssetTier(candidate.tier)) {
        return { ok: false, reason: 'invalid_asset_tier' };
      }

      return {
        ok: true,
        rule: { id, type: 'asset_tier_acquisition_usd', tier: candidate.tier, maxUsd, windowHours },
      };

    default:
      return { ok: false, reason: 'unknown_limit_type' };
  }
}

/**
 * Validates an untrusted document against the *current* schema version — the draft/save
 * endpoint's gate. Accepts any well-formed `LimitRule`, including the two types the
 * authoring UI does not offer yet (Phases 5/6 add their UI on top of this same validator,
 * without a server change).
 */
export function parseConstitution(raw: unknown): ConstitutionParseResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'invalid_document' };
  }

  const candidate = raw as Record<string, unknown>;

  if (candidate.schemaVersion !== CONSTITUTION_SCHEMA_VERSION) {
    return { ok: false, reason: 'unsupported_schema_version' };
  }

  if (!Array.isArray(candidate.limits)) {
    return { ok: false, reason: 'limits_not_an_array' };
  }

  const limits: LimitRule[] = [];
  const seenIds = new Set<string>();

  for (const rawLimit of candidate.limits) {
    const result = validateLimitRule(rawLimit);

    if (!result.ok) {
      return result;
    }

    if (seenIds.has(result.rule.id)) {
      return { ok: false, reason: 'duplicate_limit_id' };
    }

    seenIds.add(result.rule.id);
    limits.push(result.rule);
  }

  return { ok: true, constitution: { schemaVersion: CONSTITUTION_SCHEMA_VERSION, limits } };
}

/**
 * The one shape this module has ever stored before `schemaVersion` and `windowHours`
 * existed: every limit was an implicit rolling 24h window (decision 4). Upgrading is
 * additive only — nothing here reinterprets a field, it just fills in what used to be
 * implied.
 */
function upgradeUnversionedLimit(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) {
    return raw;
  }

  const candidate = raw as Record<string, unknown>;

  return 'windowHours' in candidate ? candidate : { ...candidate, windowHours: 24 };
}

/**
 * Upgrades a stored document to the current schema version, in place, on read, then
 * validates the result. Trusted input (our own `constitutions.document`), so failure here
 * means the stored row is corrupt, not that a caller sent something malformed — that is
 * `parseConstitution`'s job, on the draft/save path.
 */
export function migrateConstitution(raw: unknown): Constitution {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('stored constitution is not an object');
  }

  const candidate = raw as Record<string, unknown>;

  const upgraded =
    candidate.schemaVersion === undefined
      ? {
          schemaVersion: CONSTITUTION_SCHEMA_VERSION,
          limits: Array.isArray(candidate.limits)
            ? candidate.limits.map(upgradeUnversionedLimit)
            : candidate.limits,
        }
      : candidate;

  const result = parseConstitution(upgraded);

  if (!result.ok) {
    throw new Error(`stored constitution failed validation after migration: ${result.reason}`);
  }

  return result.constitution;
}
