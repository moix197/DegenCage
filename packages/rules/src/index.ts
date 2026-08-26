/**
 * The rule engine's public API.
 *
 * Load-bearing invariant: this package does **no I/O** — no DB, no `fetch`, no
 * `next/*`. It is a pure function of (constitution, history, proposed trade) →
 * decision, which is what lets a worker process or an on-chain consumer reuse it
 * verbatim. `src/index.test.ts` asserts that invariant against the source.
 *
 * Phase 1 ships only the placeholder below; the real surface (constitution schema,
 * `evaluateTrade`) lands in Phases 3 and 4.
 */

/** Identity over a decision value — the placeholder proving the package builds and tests standalone. */
export function identityDecision<TDecision>(decision: TDecision): TDecision {
  return decision;
}
