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

**Resolved (Phase 5): the stranded-intent gap above is closed, on two paths.**

- **Linkage.** `reconcile-wallet.ts`'s `persistOneSwap` matches a newly-derived swap's
  `(wallet_id, signature)` against a live (`signed`/`submitted`) `trade_intents` row
  (`findMatchingLiveIntentId`) and guarded-transitions it to `confirmed`/`failed`
  (`resolveMatchedIntent`), in the same transaction as the `trades` insert. `resolveIntentOutcome`
  decides which: `confirmed` for a real (non-excluded) trade *or* one of
  `LANDED_BUT_EXCLUDED_REASONS` (`lst_swap`, `wrap_unwrap`, `missing_block_time`) — the signature
  landed and did what it was meant to, just outside what `trades` tracks for position accounting
  — `failed` only for a transaction that genuinely did not execute the intended swap
  (`no_net_change`, `pure_receive`, `pure_send`: reverted on-chain, or only one side registered).
  Folding every excluded reason to `failed` (the original Phase 5 shape) told the user a trade
  that had actually landed "never happened" — a review finding, fixed by this split.
- **The sweep.** `sweepStrandedSubmittedIntents`, run at the end of every `reconcileWallet()`
  call, guarded-transitions a `signed` or `submitted` intent to `failed` once its blockhash
  deadline (`expires_at`) plus a fixed grace period (`SWEEP_GRACE_PERIOD_MS`, 2 minutes — long
  enough to absorb Helius' own finalized-commitment indexing lag) has passed with no linkage
  ever having resolved it — the case the linkage above cannot reach because nothing ever landed
  to match against. Originally `submitted`-only; a later review found `signed` was exposed to
  the identical gap (a crash between `submit-service.ts`'s `transitionToSigned` and
  `transitionFromSigned` — the transaction may never have actually broadcast) and had no path
  back to a terminal status either, so the sweep now covers both statuses in
  `RECONCILABLE_INTENT_STATUSES`.
- **Reachability.** Both paths only ever run *inside* a `reconcileWallet()` call, and that call
  was originally reachable only from `/dashboard` and `/constitution/edit` page loads (plus the
  callerless `POST /api/wallet/reconcile`) — a user who stays on `/trade` never triggered either
  one, so a stranded `submitted` intent on that page alone would poll "submitted" forever
  regardless of the sweep existing. `GET /api/swap/intent/[id]` (the terminal's own status poll)
  now drives a best-effort `reconcileWallet()` call itself once an intent it reads back is
  `submitted`/`signed` and past `isStrandedSubmittedIntent`'s own grace boundary — gated by the
  same `chain.helius_reconcile` kill switch every other reconciliation trigger checks, and
  throttled per wallet (`assertWithinConstitutionActionRateLimit`) so a fast poll loop parked on
  a genuinely stuck intent cannot turn into an unbounded Helius-call generator. A failure on this
  path only ever leaves the poll showing a stale status, never a broken response.
