# Baseline counterfactual: ad hoc `evaluateTrade` over the private 90-day record

**Decision:** Phase 9's "external violation frequency" signal compares a user's live
post-activation violation rate against what their *own, currently-active* constitution
would have flagged had it been applied retroactively to their 90-day pre-activation
baseline trades. That comparison is computed **entirely in memory, on demand, inside
`server/metrics/queries.ts`'s `getExternalViolationFrequencyComparison`**, by calling
`@degencage/rules`' `evaluateTrade()` directly against `trades` rows where
`is_baseline = true`. The result is never persisted, never written as a
`rule.decision_recorded` event, and never reachable from any user-facing route or page —
only from the secret-gated `/api/admin/metrics` and the unlinked `/admin/metrics` page
(see [admin-metrics-secret-gate](admin-metrics-secret-gate.md)).

**Why this doesn't violate decision 9:** decision 9 established that the baseline backfill
is a private behavioral record — never evaluated, never in a rolling window, no decision
or exclusion events written for it (`reconcile-wallet.ts`'s `persistOneSwap` returns
before recording anything for a baseline row). That invariant protects the *user*: their
own dashboard, violations feed, and rolling allowances must never surface a "violation" for
activity that happened before they committed to any rule. This metric doesn't touch any of
those surfaces — it's an internal-only, aggregate question ("would this bet have paid off,
on average, across users who opted in") computed for product validation, not a per-trade
judgement shown to the account that produced it. If this ever needs to become visible to
users (e.g. "here's what your baseline would have looked like"), that is a new,
deliberate feature decision — not a natural extension of this internal metric.

**Why not reuse `server/rules/rolling-allowance.ts`'s `loadWindowedTrades`:** that
function hardcodes `eq(trades.isBaseline, false)` — on purpose, as the enforcement of
decision 9 on the live path. Flipping that filter inline would be a one-character change
with the opposite meaning of the function's entire reason to exist; a new, separately
named query (`loadBaselineTrades` in `queries.ts`) makes the baseline read impossible to
mistake for the live one, and impossible to accidentally reuse from a live code path later.

**How the counterfactual is computed:** baseline trades for the wallet are loaded
ascending by `occurred_at`. For each trade in order, `evaluateTrade(constitution,
priorBaselineTrades, trade)` runs with `priorBaselineTrades` being every earlier baseline
trade (not baseline-and-live mixed) — `evaluateTrade`'s own `withinWindow` re-filters to
each limit's `windowHours` internally, so passing the full prior slice rather than a
pre-windowed one is correct, just slightly more work than necessary (`O(n²)` in the
baseline trade count for one wallet, over at most 90 days of history — acceptable for an
internal, low-traffic endpoint). A trade counts as a "violation" if *any* of its
evaluations does; this mirrors "violations/week" as a per-trade, not per-limit-evaluation,
rate, matching the live side's `rule.decision_recorded`-derived count in the same
function.

**`lossLimitEnabled: true` always, regardless of history:** the counterfactual asks "would
this constitution have caught this," not "was the loss-limit pipeline flag on when this
baseline trade was first reconciled." Passing the flag's real historical value would make
the comparison depend on operational history unrelated to the question being asked.

**Constraints it creates:**

- Any change to `EvaluableTrade`'s shape (`packages/rules/src/evaluate.ts`) must be
  mirrored in `BaselineTradeRow`/`loadBaselineTrades` — there is deliberately no shared
  type between the live windowed-trade query and this one (see "why not reuse" above), so
  they can silently drift if a new field is added to one and not the other. If that
  happens, `computeBaselineCounterfactualViolationCount`'s tests
  (`server/metrics/queries.test.ts`) will still pass while quietly comparing against a
  stale field set — watch for this specifically when Phase 2+ adds new `LimitRule` types.
- `weeksBetween`/`liveWeeksElapsed` both guard toward `0`, not a negative or `NaN`, when
  there's insufficient history (fewer than 2 baseline trades, or `now` before
  `activatedAt`) — `safeRate` then reports the per-week figure as `0` rather than
  `Infinity`/`NaN`. A `0` violations-per-week reading from either side should be read
  alongside its `*ViolationCount`/`*WeeksSpan` fields before being trusted as "clean."
