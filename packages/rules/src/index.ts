/**
 * The rule engine's public API.
 *
 * Load-bearing invariant: this package does **no I/O** — no DB, no `fetch`, no
 * `next/*`. It is a pure function of (constitution, history, proposed trade) →
 * decision, which is what lets a worker process or an on-chain consumer reuse it
 * verbatim. `src/index.test.ts` asserts that invariant against the source.
 *
 * Phase 1 ships only the placeholder below; `evaluateTrade` lands in Phase 4.
 */

/** Identity over a decision value — the placeholder proving the package builds and tests standalone. */
export function identityDecision<TDecision>(decision: TDecision): TDecision {
  return decision;
}

export {
  ASSET_TIERS,
  CONSTITUTION_SCHEMA_VERSION,
  migrateConstitution,
  parseConstitution,
  type AssetTier,
  type Constitution,
  type ConstitutionParseResult,
  type ConstitutionRejectionReason,
  type LimitId,
  type LimitRule,
} from './constitution';

export {
  addUsd,
  compareUsd,
  evaluateTrade,
  subtractUsd,
  sumRealizedLosses,
  sumTradeUsd,
  type Decision,
  type EvaluableTrade,
  type LimitEvaluation,
  type LimitVerdict,
} from './evaluate';
