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

**Rate-limit asymmetry (the same shape, applied to the request itself):** Only genuine
loosening is throttled — `requestLimitChange`'s increase path (`scheduleIncrease`). A decrease
(`applyDecreaseImmediately`) **and** `cancelPendingChange` both never call a rate limiter at
all; the function is simply never invoked on either path. Cancelling a pending increase
*removes* a loosening rather than requesting one — it keeps the user at, or moves them toward,
the stricter current state, exactly the direction a decrease also moves in — so it gets the
same unconditional exemption as tightening, not the throttle. (An earlier version of this rule
throttled cancel too, reasoning that "cancelling still edits commitment state." That inverted
the safety direction: caught in review and corrected here.)

This reuses `assertWithinConstitutionActionRateLimit` (`server/constitution/rate-limit.ts`,
already counting `constitution.drafted`/`constitution.activation_rejected_early` for the
draft/commit flow) as an **action gate**, not only a write guard — `assertRateLimitForLoosening`
(`pending-changes.ts`) calls it before doing anything else in `scheduleIncrease` and turns a
`ConstitutionActionRateLimited` into `PendingChangeRejected('rate_limited')`, rejecting the
request outright rather than merely skipping an event write.

**The counter tracks attempts, not successes** (a second review finding): the gate counts
`constitution.limit_increase_attempted`, a new event recorded unconditionally the moment a call
passes the gate — *before* `assertNoExistingPendingChange` gets a chance to reject it with
`pending_change_exists`. The first version counted `constitution.limit_increase_requested`
instead, which is written only on a fully successful request. That made the exact case this
throttle exists to catch — hammering "loosen" on a limit that already has a pending increase —
invisible and unthrottleable: every such call failed on `pending_change_exists` before any
success event was ever written, so the counter never moved and `ConstitutionActionRateLimited`
never fired. `constitution.limit_increase_attempted` closes that gap and is itself a Phase 9
signal — "how many times did this user try to loosen a limit," independent of whether any of
those tries succeeded, which `constitution.limit_increase_requested` alone cannot answer.

**Fail-closed direction is itself asymmetric**, mirroring the decrease/increase split above:
- A limiter failure that *is* the expected `ConstitutionActionRateLimited` (the count query
  ran, the caller is over the threshold) rejects the increase, same as any other rejection
  reason.
- A limiter failure that is *not* that — the database itself unreachable — is re-thrown as-is
  by `assertRateLimitForLoosening` rather than swallowed or treated as "allow": an unreachable
  limiter must **reject** the increase it was asked to gate (CLAUDE.md → fail closed), the same
  direction every other kill-switch/limiter failure in this codebase fails.
- The decrease **and** cancel paths are unaffected by either case, because neither ever calls
  the limiter — there is no failure mode there to fail closed (or open) about.

**Behavioral signal:** a throttled increase attempt records `constitution.edit_rate_limited`
(payload: `path: 'increase_requested'`, plus the relevant `limitId`). That write is itself
self-throttled (`recordRateLimitedAttempt`, same shape as `commitment.ts`'s private
`recordEventWithinRateLimit`) so a caller hammering past the limit does not also grow this
event type unbounded — the rejection still fires on every call, only the audit trail stops
growing once it has enough rows to prove the pattern.

**Rejected:**

- **Apply `new_value` unconditionally on schedule** — the stale-value hole above. Rejected
  after being found in code review on the first version of this phase.
- **Rate-limiting `cancelPendingChange`** — inverts the safety direction: cancelling removes a
  loosening, the same direction as a decrease, and must be exempt for the same reason. Shipped
  once, caught in the next review round, removed here.
- **Rate-limiting the decrease path too, "for symmetry"** — the opposite of the point. Tighten-
  ing your own constitution must be safe unconditionally, including when the rate limiter
  itself is down; the only way to guarantee that is to never call it on that path at all,
  which is what `applyDecreaseImmediately` does.
- **Counting `constitution.limit_increase_requested` (successes) for the throttle** — the
  attempt-vs-success bug above. Rejected after being found in the same review round as the
  cancel-throttling mistake.
- **Guarding only the event *write*, the same way `commitment.ts` uses this helper today** —
  would let someone spam increase requests as long as they don't mind the audit trail being
  incomplete; the edit surface is exactly where someone hammering "loosen my limits" shows up
  (this decision's own motivating report), so the action itself has to be gated, not just its
  bookkeeping.
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
