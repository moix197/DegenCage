# Constitution edits are asymmetric: decrease is instant, increase is a 48h timelock

**Decision:** Once a constitution is `active`, tightening any limit's `maxUsd` (a decrease)
writes straight into `constitutions.document` and takes effect immediately. Loosening it (an
increase) never touches `document` directly — it inserts a row into
`constitution_pending_changes` with `effective_at = now() + 48h` (Postgres' own clock, per
[commitment-window-server-clock](commitment-window-server-clock.md)) and only folds into
`document` once that deadline has passed. Only `maxUsd` is editable this way; `windowHours`
and `tier` are part of a `LimitRule` too, but neither maps onto "looser"/"stricter" as
unambiguously as `maxUsd` does (a *longer* window can mean *less* allowed per unit time, not
more) — deciding that direction is out of scope until a phase actually needs it.

Applying a due increase is **lazy, not scheduled**: `applyDuePendingChanges()`
(`apps/web/src/server/constitution/pending-changes.ts`) runs on the same app-open triggers
`reconcileWallet()` already uses — `apps/web/src/app/dashboard/page.tsx` and
`apps/web/src/app/constitution/edit/page.tsx` both call it directly, server-side, on page
load. `POST /api/wallet/reconcile` also calls it, kept wired for a future non-page caller, but
**no code path in this app calls that route today** — the two page loads are what actually
resolve a due change. Phase 0 has no cron and no worker
([hosting-and-growth-path](hosting-and-growth-path.md)), so "resolved by whoever opens the app
next" is the same trade-off already accepted for chain reconciliation, applied a second time.

**Why:** The whole product is a friction mechanism against future-emotional-you loosening
your own rules (CLAUDE.md → *What we're building*). A decrease is always safe to apply
immediately — it can only make a limit *stricter*, never a vector for the thing the product
exists to prevent. An increase is exactly that vector, so it inherits the same
"decide-while-calm, wait it out, then it's real" shape as the 20-minute commitment period
(`commitment-window-server-clock.md`), just scaled from minutes to 48 hours and applied to a
single limit instead of the whole document.

**Stale-value voiding (the hole this closes):** A due increase must never apply blindly. If a
user requests 100→500, then later decreases the same limit to 10 before the 48h elapses, a
naive "apply `new_value`" would jump the limit from 10 straight to 500 — an increase the user
never asked for *from the value they're actually at now*. `applyOneDuePendingChange` re-reads
the limit's *current* `maxUsd` inside the same transaction that claims the row, and compares
it against the pending row's `old_value` (the value that was current when the increase was
requested):

- **Match** → apply `new_value`, `applied_at = now()`, `constitution.limit_increase_applied`.
- **Mismatch** (a decrease, or a different resolved increase, landed in between) → **void**,
  not apply and not silently drop: `voided_at = now()`, `document` untouched,
  `constitution.limit_increase_voided` recorded with both `expectedOldValue` (the row's
  `old_value`) and `observedCurrentValue` (what the limit actually is now) in its payload.

`voided_at` is a third terminal state alongside `applied_at`, not a repurposing of it and not
a delete — `constitution_pending_changes` stays append-only evidence of exactly what was
requested, what was found, and what happened, the same invariant CLAUDE.md requires of rule
state generally ("Rule state is append-only and auditable"). A cancellation (the user's own
choice, mid-flight) still deletes the row outright — `constitution.limit_increase_cancelled`
is that action's durable record instead — voiding is reserved for the system deciding *not*
to honor a stale request, which is exactly the case that needs its own answer of "why didn't
this apply" sitting in the events log.

**Rejected:**

- **Apply `new_value` unconditionally on schedule** — the stale-value hole above. Rejected
  after being found in code review on the first version of this phase.
- **A scheduler / cron worker to apply due increases** — Phase 0 explicitly has neither
  (`hosting-and-growth-path.md`); reusing the existing lazy app-open trigger is one pattern,
  not two.
- **Route-only trigger** (`POST /api/wallet/reconcile` alone) — nothing in the app calls that
  route, so a due increase would never actually resolve. Found in the same review; fixed by
  calling `applyDuePendingChanges()` directly from both page loads that already run
  server-side on app open.
- **Soft-delete a cancelled row (`cancelled_at`) instead of `DELETE`** — considered for
  symmetry with `voided_at`, but the phase's schema was specified without it and a delete is
  simpler for "this was withdrawn, no evidence beyond the event is needed." `voided_at` earns
  its own column because the *row itself* — its `old_value`/`new_value`, not just the event
  payload — is what a later investigation of "why didn't my increase apply" needs to find.
- **Symmetric timelocks (decrease also delayed)** — defeats the purpose: a user who wants to
  tighten a rule the moment they notice a problem must be able to, immediately, with zero
  friction. Only loosening is the adversarial direction.

**Constraints it creates:**

- **The apply path has its own kill switch**, `CONSTITUTION_PENDING_CHANGE_APPLY_FLAG`
  (`constitution.pending_change_apply`), separate from `CONSTITUTION_AUTHOR_FLAG` (which gates
  requesting/cancelling) and from `CHAIN_HELIUS_RECONCILE_FLAG` (an unrelated integration
  switch the reconcile route happens to also carry). It must ship **seeded enabled** in
  `src/server/db/seed.ts` — every flag here fails closed
  ([feature-flags-and-kill-switches](feature-flags-and-kill-switches.md)), and an unseeded
  switch for this specific path means "a due increase never applies" by default, silently
  reintroducing the dead-entry-point bug this decision's own review found.
- **Every `constitution_pending_changes` query filters `applied_at IS NULL AND voided_at IS
  NULL`** to mean "still actionable" — `assertNoExistingPendingChange`, the edit page's
  pending list, `cancelPendingChange`'s ownership check, and the due-rows scan all share this
  predicate (`stillPending()` in `pending-changes.ts`). Add a fourth terminal state only by
  extending that helper, never by reading `applied_at` alone again.
- **One `applyDuePendingChanges()` call resolves at most a fixed batch** (currently 50 rows) —
  an unbounded scan on a shared app-open path is a footgun once row counts grow; a backlog
  beyond the cap is picked up by the next trigger, not held open in one scan.
- **Applying is global, not scoped to the caller's session** — whoever's app-open trigger fires
  first resolves *every* user's due rows, not only their own, so a change becomes due even if
  its owner never reopens the app. Accepted for Phase 0's single-process, no-worker shape;
  revisit if/when a real worker exists.
