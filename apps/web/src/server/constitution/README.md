# `server/constitution` — authoring, committing, activating, editing

Turns a drafted set of limits into an *active* constitution, makes the 20-minute wait in
between real, and (`pending-changes.ts`, Phase 8) edits an already-active one. Nothing here
evaluates a trade — that is `packages/rules` from Phase 4. The document shape itself is also
`packages/rules`; this module owns only its lifecycle.

Decisions that outlive this module live in `.ai/`:
[constitution-schema](../../../../../.ai/decisions/constitution-schema.md),
[commitment-window-server-clock](../../../../../.ai/decisions/commitment-window-server-clock.md),
[asymmetric-constitution-edits](../../../../../.ai/decisions/asymmetric-constitution-edits.md),
[server-actions-for-constitution-edit](../../../../../.ai/decisions/server-actions-for-constitution-edit.md),
[guarded-state-transition](../../../../../.ai/patterns/guarded-state-transition.md).
This file is the flow and the invariants.

## The flow

```
draft ──POST /api/constitution──────────> saveDraftConstitution   (re-editable)
  │                                        parseConstitution() first, DB second
  ▼
committing ──POST /api/constitution/commit──> startCommitment
  │                                            commitment_started_at = SQL now()
  │        (20 minutes, measured in Postgres)
  ▼
active ──POST /api/constitution/activate──> activateConstitution
  │                                          UPDATE … WHERE elapsed  → 'active'
  │                                          no match → 425 commitment_not_elapsed
  │
  └─ editing (Phase 8, `pending-changes.ts`) ──> requestLimitChange(limitId, newMaxUsd)
       decrease  ──> applyDecreaseImmediately   document mutated now
       increase  ──> scheduleIncrease           constitution_pending_changes row,
                                                 effective_at = now() + 48h, document untouched
                      │
                      ▼ (48h later, on the next app-open trigger)
                 applyDuePendingChanges → applyOneDuePendingChange, per row, under FOR UPDATE
                      current maxUsd === row.old_value?
                        yes → apply: document mutated, applied_at = now()
                        no  → void:  document untouched, voided_at = now()
```

One row per user (`constitutions_user_id_idx` is UNIQUE). `draft` is the only status
`saveDraftConstitution` will write to — editing an already-`active` constitution goes through
`pending-changes.ts` instead, never back through the draft/commit/activate path.

## Invariants a change must not break

- **Identity comes only from `resolveSession()`.** No function here takes a user or wallet
  id as a parameter, so a forged `wallet_id` in a request body has nothing to attach to.
- **Every transition carries its guard in the UPDATE's WHERE**, never in a preceding
  SELECT — see the pattern doc. A check-then-act save/commit race previously let a
  committed document be swapped without restarting the clock.
- **The 20 minutes are measured by Postgres' clock on both sides.** `remainingMs` on the
  wire is a *display* countdown from the app's clock; the gate re-runs in SQL on activate.
- **Both mutations are idempotent.** Re-committing returns the existing row rather than
  restarting the clock; re-activating an already-`active` constitution is a no-op, not a
  rejection — otherwise the loser of a benign race is recorded as an early activation.
- **Fail closed on a broken invariant.** A `committing` row with a null
  `commitment_started_at` should be unreachable; it is captured and rejected rather than
  asserted away.
- **Rejection reasons map to status in one place** (`httpStatusForRejection`).
  `commitment_not_elapsed` answers **425 Too Early** — the server refuses until a condition
  *it* tracks is met, which is neither a conflict nor a malformed request. Unlike
  `/api/auth/*`, reasons are returned to the caller: every one of these paths is already
  authenticated, so there is no probing oracle to protect.

## Events and their throttle

`constitution.drafted`, `constitution.commitment_started`, `constitution.activated`,
`constitution.activation_rejected_early`. The last one is a behavioural signal, not just a
guard failure — it is a user trying to escape their own cooling-off period.

`pending-changes.ts` adds six more: `constitution.limit_decreased`,
`constitution.limit_increase_requested`, `constitution.limit_increase_applied`,
`constitution.limit_increase_cancelled`, `constitution.limit_increase_voided`, and
`constitution.edit_rate_limited`. `limit_increase_voided` is Phase 5's "decrease-requests as a
proxy for wants-stricter-rules" signal's mirror image: a voided row is the audit trail for
"the system caught a stale increase and refused it," load-bearing evidence that the timelock's
safety check actually fired, not just that it exists in code. `edit_rate_limited` is the
Phase 8 rate-limiting follow-up's own signal — recorded once per throttled `requestLimitChange`
(increase direction) or `cancelPendingChange` call, payload carries `path:
'increase_requested' | 'cancel_pending'` so the two throttled surfaces share one event type
instead of two near-duplicates.

Five of those six are unthrottled — `limit_decreased` most deliberately: decreases are the one
action this whole module refuses to ever throttle (see the rate-limiting section below).
`edit_rate_limited` is the exception, and it throttles *itself* the same way `drafted`/
`activation_rejected_early` throttle their own writes below.

The two a session can generate in a loop (`drafted`, `activation_rejected_early`) have
their **event write** throttled per user by `rate-limit.ts`. Read carefully:

- **It guards the write, never the action.** A caller looping `/activate` still gets its
  correct rejection every time; only the audit trail stops growing once it has enough rows
  to prove the pattern. A rate-limit check that *fails* never turns a successful user
  action into a 503 — it skips the write, as `recordSignInRejection` does.
- **Counted against `events`, keyed by `userId`** (both routes are session-gated, so there
  is no hashed client address here), reusing `CHALLENGE_RATE_LIMIT_MAX` /
  `CHALLENGE_RATE_LIMIT_WINDOW_MS` from `server/auth/challenge-rate-limit.ts`. Migration
  0005's `(user_id, event_type, occurred_at)` index serves the count.
- **Deliberate duplication, not drift.** `assertWithinChallengeRateLimit` could not be
  reused: its query is specific to `siws_challenges` and to a client-address key.
  Generalizing it would mean editing `server/auth/*`, out of scope for the phase that
  needed this. Only the constants are shared. **If a third consumer appears, extract it**
  rather than writing a third copy.
- **Accepted gap:** because the throttle sits on the write, `constitution.drafted` rows
  past 10 per 5 minutes are *dropped*, not deferred — a user saving a draft very rapidly
  loses some audit rows. Accepted: this is draft-stage only, before any commitment exists,
  and the surviving rows already show the behaviour. The same is not acceptable for
  anything recording a committed or active constitution.

## Kill switch

`constitution.author` (`CONSTITUTION_AUTHOR_FLAG`, seeded by `src/server/db/seed.ts`) gates
all four route handlers, including the `GET`. Off — or with the flag lookup itself failing
— every one answers `503`, so nothing can be drafted, committed, or activated. Already-active
constitutions are untouched; the switch stops authoring, it does not repeal anyone's rules.

## Editing an active constitution (`pending-changes.ts`)

Full rationale in [asymmetric-constitution-edits](../../../../../.ai/decisions/asymmetric-constitution-edits.md);
this section is the module's own shape.

- **`requestLimitChange(limitId, newMaxUsd, correlationId)`** loads the caller's *active*
  constitution (never `draft`/`committing`), finds the limit by its stable `id`, and decides
  direction with `compareUsd` against the limit's *current* `maxUsd` — never from anything the
  caller claims. Decrease → `applyDecreaseImmediately` (same WHERE-carries-the-precondition
  UPDATE shape as `commitment.ts`'s `updateExistingDraft`). Increase → `scheduleIncrease`,
  which first calls `assertNoExistingPendingChange` (one in-flight pending change per
  `limitId`+`field` at a time) and then inserts the `constitution_pending_changes` row with
  `effective_at = now() + interval … DELAYED_INCREASE_MS` — Postgres' own clock, never this
  process' `Date`.
- **`cancelPendingChange(pendingChangeId, correlationId)`** deletes the row, scoped to the
  caller's *own* active constitution (never trusts the id alone), and records
  `constitution.limit_increase_cancelled`. No `voided_at`/`cancelled_at` ambiguity here — a
  cancelled row is simply gone; the event is its only remaining trace.
- **Rate limiting is asymmetric, same as everything else here** (full rationale in the decision
  doc). `assertRateLimitForLoosening` gates `scheduleIncrease` and `cancelPendingChange` —
  each keyed on its own real event type (`constitution.limit_increase_requested` /
  `constitution.limit_increase_cancelled`) via the *reused*
  `assertWithinConstitutionActionRateLimit` (`./rate-limit.ts`), called here as an **action
  gate** rather than only a write guard: a throttled call is rejected as
  `PendingChangeRejected('rate_limited')`, not merely under-logged. `applyDecreaseImmediately`
  never calls it — decreasing is never throttled, and a limiter outage can never block it.
  A `ConstitutionActionRateLimited` throttles the action *and* (via the self-throttled
  `recordRateLimitedAttempt`) records `constitution.edit_rate_limited`; any other error from
  the limiter (the database itself unreachable) is re-thrown as-is, which is this path's own
  fail-closed: an unreachable limiter rejects the loosening it was asked to gate.
- **`applyDuePendingChanges(correlationId)`**, gated by `CONSTITUTION_PENDING_CHANGE_APPLY_FLAG`
  (seeded by `seed.ts`, same as every other switch here), scans up to
  `PENDING_CHANGE_APPLY_BATCH_LIMIT` rows where `effective_at <= now() AND applied_at IS NULL
  AND voided_at IS NULL`, then resolves each one under its own transaction+`FOR UPDATE`
  (`applyOneDuePendingChange`) so two racing callers can never double-resolve the same row.
  Before applying, it re-checks the limit's *current* `maxUsd` against the row's `old_value`:
  a match applies (`applied_at`, `constitution.limit_increase_applied`); a mismatch voids
  instead (`voided_at`, `constitution.limit_increase_voided`, payload carries both the
  expected and observed values) — see the decision doc for why this check exists.
- **Called from app-open page loads, not a route.** `apps/web/src/app/dashboard/page.tsx` and
  `apps/web/src/app/constitution/edit/page.tsx` both call `applyDuePendingChanges()` directly,
  best-effort, alongside their own server-side data loading. `POST /api/wallet/reconcile` also
  calls it, but nothing in this app currently calls that route — the two page loads are the
  real trigger. Wiring a new app-open surface to this mechanism means calling
  `applyDuePendingChanges()` from that surface directly, not assuming the reconcile route
  covers it.
- **`stillPending()`** is the one predicate — `applied_at IS NULL AND voided_at IS NULL` — every
  query in this file uses to mean "still actionable." Add a future terminal state only by
  extending it, never by filtering `applied_at` alone again.
