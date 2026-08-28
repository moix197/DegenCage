# Quote-slot occupancy and allowance reservation are two different status sets

**Decision:** `trade_intents` has two distinct "is this live" predicates, not one, and they
must never be collapsed back into a single status set:

- **`QUOTE_SLOT_STATUSES`** (`quoted`/`approved`) — which row occupies the wallet's single
  live-quote slot. This is what the partial unique index (`trade_intents_wallet_live_idx`)
  is predicated on, and what `intent-lifecycle.ts`'s `expireAllLive` (run on every new quote,
  and unconditionally on account switch via `session.ts`'s `expireLiveIntentsForSwitchedWallet`)
  and `reapExpiredIntents` operate over.
- **`RESERVING_TRADE_INTENT_STATUSES`** (`quoted`/`approved`/`signed`/`submitted`) — which
  rows consume rolling allowance, read by `loadLiveIntentUsd`. `signed`/`submitted` stay in
  this set long after they have left the quote slot: a broadcast trade keeps reserving until
  Phase 5 reconciliation resolves it (its signature lands in `trades`), because a `submitted`
  intent's `expires_at` is only a ~60-90s blockhash-derived estimate, not a real deadline for
  when the trade is actually settled.

Both constants live in `apps/web/src/server/db/schema.ts`, next to `tradeIntents`.

**Why:** a code-review pass on Phase 4 found the two conflated into one set. The symptom was
an allowance double-spend: a `submitted` intent (broadcast, not yet reconciled) was being
expired — either by the next quote request or by an account switch — which silently
released the allowance it should still have been holding. A second broadcast could then be
quoted and approved against room that was never actually free, while the first was still in
flight. The fix is the split above: a `signed`/`submitted` intent can leave the quote slot
(a new quote no longer needs to wait for it, and an account switch no longer kills it) without
ever stopping to reserve allowance until reconciliation says otherwise.

A mutation-testing pass after the fix found the regression tests for this were not actually
load-bearing: `quote-service.test.ts`'s in-memory `trade_intents` fake reimplemented the
quote-slot filter as its own hardcoded `status === 'quoted' || status === 'approved'` check
rather than reading the real predicate `expireAllLive` builds, so swapping
`expireAllLive`'s status array back to `RESERVING_TRADE_INTENT_STATUSES` (reintroducing the
exact bug this decision fixes) left all 105 swap tests green. The fixture now derives the
expired-row set from the actual predicate handed to `.where()` (parsed via `whereSql`), and
`intent-lifecycle.test.ts`'s `expireAllLiveIntentsForWallet` test now asserts the exact
status literals in the query, with explicit `not.toContain('signed'/'submitted')` — either
would fail if the sets were conflated again.

**Rejected:**

- **One "live" status set for both the index and the reservation** — the conflation this
  decision exists to undo; it either lets a `signed`/`submitted` intent block a new quote (if
  the wider set backs the index) or lets one silently stop reserving allowance (if the
  narrower set backs the reservation).
- **Keeping the test fixture's parallel hardcoded status filter** — proven insufficient by the
  mutation-testing pass above: a parallel implementation of the predicate under test can drift
  from it silently, which is exactly what happened.

**Constraints it creates:**

- `QUOTE_SLOT_STATUSES` must be kept in sync **by hand** with the partial unique index's
  `.where()` predicate in `schema.ts` — Postgres requires partial-index predicates to be
  immutable, so the constant cannot be interpolated into it at migration-generation time.
  `intent-lifecycle.test.ts` asserts the two stay identical, replayed against the actual
  migrations directory (not just `schema.ts`'s declared config).
- Any new `trade_intents` status must be deliberately placed in one, both, or neither of the
  two sets — never added to "the live set" as if there were only one.
- A test that fakes `trade_intents` semantics (quote-slot expiry, reservation) must derive its
  behaviour from the real predicate/status-set under test, not reimplement the filter as a
  parallel hardcoded list — see the mutation-testing finding above.

**Known gap, not yet built:** a `submitted` intent whose transaction never lands on chain at
all (not confirmed, not failed — just never resolved) is currently unresolvable: it keeps
reserving allowance indefinitely, because reconciliation only ever resolves a signature that
*did* land. Phase 5 as planned does not cover this. The plan now carries a required step for a
blockhash-expiry-driven `submitted → failed` sweep to close it — not implemented yet.
