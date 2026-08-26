# `server/constitution` — authoring, committing, activating

Turns a drafted set of limits into an *active* constitution, and makes the 20-minute wait
in between real. Nothing here evaluates a trade — that is `packages/rules` from Phase 4.
The document shape itself is also `packages/rules`; this module owns only its lifecycle.

Decisions that outlive this module live in `.ai/`:
[constitution-schema](../../../../../.ai/decisions/constitution-schema.md),
[commitment-window-server-clock](../../../../../.ai/decisions/commitment-window-server-clock.md),
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
                                             UPDATE … WHERE elapsed  → 'active'
                                             no match → 425 commitment_not_elapsed
```

One row per user (`constitutions_user_id_idx` is UNIQUE). Editing a constitution *after*
activation is Phase 8's timelocked pending-change mechanism, not this module: `draft` is
the only status `saveDraftConstitution` will write to.

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
