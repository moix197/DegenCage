# Monorepo and package shape

**Decision:** pnpm workspace monorepo. Start with `apps/web` (Next.js) and
`packages/rules`. Add `packages/db` when queries are genuinely shared by a second
consumer. Add nothing else preemptively.

**Why:** `packages/rules` is split out on day 1 despite the no-speculative-abstraction
rule because it earns the split three separate ways: it is the product IP, it must be
unit-testable without a browser or a database, and both the future Phase 4 worker and
any eventual on-chain vault consume the same evaluation logic. A limit has to mean the
same thing in every runtime that asks.

Everything else starts inside `apps/web` and gets extracted on the second real use.
Pre-splitting into many packages invents boundaries before the code justifies them —
that is the failure mode here, not under-splitting.

**Rejected:**

- **Single Next.js app, no packages** — the rule engine ends up coupled to React and the
  DB, untestable in isolation and unusable from a worker process.
- **Six-to-eight package split up front** — boundary churn with no information to base
  the boundaries on.

**Constraints it creates:**

- `packages/rules` performs **no I/O**: no DB access, no `fetch`, no `next/*` imports.
  It is a pure function of (constitution, history, proposed trade) → decision. This is
  the single property that makes `apps/worker` later just a `main.ts` importing it, and
  it decouples the hosting decision from the business logic.
- Dependencies flow one way: `apps/*` → `packages/*`. Packages never import from apps.
