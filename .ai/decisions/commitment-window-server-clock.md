# The commitment window is measured by the database clock

**Decision:** `commitment_started_at` and `activated_at` are written with SQL `now()`, and
"has the 20 minutes elapsed?" is a **predicate inside the activation UPDATE's WHERE** —
`commitment_started_at <= now() - interval '1 millisecond' * COMMITMENT_PERIOD_MS`. No
app-server `Date` ever decides whether the window has passed.

**Why:** `startCommitment` and `activateConstitution` are separate requests and may be
served by different instances. Comparing a timestamp written by one instance against
`new Date()` on another shifts the window by exactly the skew between their clocks — and
it shifts in the *user's favour* whenever the activating instance happens to run fast.
A serverless platform gives no guarantee about that, and there is no error term small
enough to be acceptable here: the enforced wait between deciding and committing is the
mechanism DegenCage sells. A cooling-off period that a lucky instance shortens is not one.

Postgres is already the single source of truth
([single-source-of-truth-database](single-source-of-truth-database.md)), so it is one clock
both sides already share, at no added cost — and doing the comparison where the row lives
is what lets the check and the write it authorizes be a single statement (see
[patterns/guarded-state-transition](../patterns/guarded-state-transition.md)).

This sharpens [server-side-rule-evaluation](server-side-rule-evaluation.md): server-authored
timestamps stop being sufficient as soon as there is more than one server. Every rule
deadline the product grows — Phase 8's 48-hour increase timelock, cooldowns — inherits this.

**Rejected:**

- **Compare in the app against `new Date()`** — clock skew, and it forces a check-then-act
  shape that a concurrent request can interleave with.
- **`SELECT now()` first, then compare in the app** — buys the shared clock but is still two
  statements, so the deadline can be re-checked stale. The predicate belongs in the write.
- **A client-side countdown as the gate** — the client is the party the mechanism restrains;
  its clock and its `setInterval` are adversarial input.

**Constraints it creates:**

- **`remainingMs` (from `serializeConstitutionRecord`) is display only.** It is computed
  against the app's `now` so the UI can render a countdown. It is never a gate: the
  authoritative comparison runs again, in Postgres, when Activate is clicked. Do not
  promote it, and do not let the UI's "0 remaining" imply an activation will succeed.
- Events use the database-written timestamp as `occurred_at` (`activated_at`,
  `commitment_started_at`), so the audit trail agrees with the guard that produced it —
  see [event-time-vs-observation-time](event-time-vs-observation-time.md).
- Any later deadline (timelocks, cooldowns) is written and compared the same way. An
  app-clock deadline anywhere in rule state is a defect, not a style difference.
