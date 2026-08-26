# One database as the source of truth

**Decision:** A single Postgres instance is the source of truth for constitutions, rule
state, allowances, and trade history. The web app and any future worker share it.
Additional stores are only ever for a *different kind* of data — never a partition of
rule state.

**Why:** The product exists to answer one question: *has this user's allowance for this
asset been spent?* Two stores means two answers, and the commitment mechanism is only
as trustworthy as that answer. Splitting it buys a distributed-systems problem in
exchange for nothing.

Legitimate second stores are different **access patterns**, not copies of truth — today
that means only a Redis cache for cooldown timers, rate limits, and kill-switch state.
Postgres stays authoritative and the cache must be expendable without affecting
correctness.

Behavioral events live **in** Postgres, not in a separate analytics store. An earlier
draft of this file cited Axiom/ClickHouse as the example second store; that was
superseded by [observability-stack](observability-stack.md), which explains why product
data whose retention determines a user's streak cannot sit behind a vendor's expiry
policy. Revisit on volume, not on principle.

**Rejected:**

- **A database per service** — see above; rule state has exactly one owner.
- **Postgres on the VPS / app box** — would force public exposure for Vercel to reach it.
  Hosted Postgres is reachable from any compute, trivially.
- **Client-side or localStorage rule state** — see
  [server-side-rule-evaluation](server-side-rule-evaluation.md).
- **MongoDB / a document store.** Considered seriously on team-familiarity grounds, which
  is a real velocity argument at Phase 0. It lost on two product-specific points. First,
  the allowance check is a read-modify-write (read today's spend for an asset → compare
  to limit → write the trade) that must be atomic across two writers, or allowances get
  double-spent; document stores solve that only when all contested state lives in one
  document, or via multi-document transactions — the complexity NoSQL was meant to avoid.
  Second, Phase 5 is almost entirely `GROUP BY` over time windows, and document stores
  push toward precomputed counters, which directly contradicts
  [event-time-vs-observation-time](event-time-vs-observation-time.md)'s derive-never-
  increment rule.

**Constraints it creates:**

- Connect through a **pooler** (Supabase pooler, Neon serverless driver, or PgBouncer)
  from day 1. Serverless opens a connection per invocation and exhausts Postgres fast —
  set this up before it breaks, not after.
- With two concurrent writers (web + worker), CLAUDE.md's idempotency rule is enforced
  by the **database** — transactions, row locks, unique constraints — not by application
  code. Sharing one store across two runtimes is what makes that placement mandatory
  rather than stylistic.
- The database stays with a hosted provider. Keep Vercel's region near the DB region.
- Redis is cache only. Losing it degrades latency, never correctness.
- **Use `jsonb` for the constitution and for event payloads.** Rule shapes will churn as
  Phase 2 adds limit types, and event payloads vary by event type — both are genuinely
  document-shaped and should not drive a migration every time they change. Relational
  columns are for what needs joins, constraints, and aggregation: wallets, allowances,
  trades, rule-state transitions. This is how the schema flexibility that motivated the
  NoSQL question is satisfied without a second database.
