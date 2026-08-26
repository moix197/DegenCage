# Event time vs observation time

**Decision:** Every observed on-chain event stores both `occurred_at` (block time) and
`observed_at` (when we detected it). All derived stats — streaks, violation counts,
discipline percentages, rankings — compute from `occurred_at`. Each wallet carries a
`reconciled_through` cursor. Aggregates are derived from the append-only event log,
never incremented in place.

**Why:** Through Phase 3, wallet history is reconciled on app open (see
[hosting-and-growth-path](hosting-and-growth-path.md)), so observation lags reality by
however long a user stays away. Because the chain is a permanent ledger this is a
*freshness* problem, not data loss — anything missed can be backfilled later.

What backfill cannot repair is a schema that recorded only detection time. A user who
returns after three weeks would have their entire history collapsed into a single day,
permanently and irreversibly. That is the whole reason this is decided now rather than
when leaderboards land.

The Phase 4 worker (scheduled sweeps of every wallet, logged in or not) closes the
freshness gap, and it arrives before gamification in the roadmap's progression. Given
these constraints, that backfill produces numbers identical to having watched live.

**Rejected:**

- **Detection-time-only timestamps** — the cheapest schema, permanently distorts every
  time-based metric.
- **Incrementing counters on detection** — cannot be corrected when late-arriving data
  changes a past day's numbers.
- **Treating unsynced users as clean** — see the survivorship-bias constraint below.

**Constraints it creates:**

- `occurred_at` comes from chain, `observed_at` is ours. Never conflate them, and never
  let a client supply either (see
  [server-side-rule-evaluation](server-side-rule-evaluation.md)).
- Per-wallet `reconciled_through` (last signature or slot swept). Reconciliation is
  resumable and idempotent; a backfill is "move the cursor back and re-run."
- **"Unreconciled" is a distinct state from "clean."** Rankings must exclude or flag
  stale wallets. Otherwise churned users — disproportionately the ones who blew through
  their limits — never have their violations recorded, and every aggregate reads better
  than reality. Survivorship bias is the specific failure mode.
- Stats are computed from the event log, not stored as mutable counters.

**Ranking is public by wallet address.** Decided: addresses are public by design, so
leaderboards rank them directly — no opt-in gate, no display-handle indirection. Noted
for revisiting: the linkage published (address → discipline profile, violations, losses)
is derived data that is not itself on chain.
