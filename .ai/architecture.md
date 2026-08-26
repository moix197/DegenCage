# Architecture

The high-level shape of the system: package boundaries, how data flows, and the
rules that keep dependencies pointing one direction.

> The pnpm workspace, `apps/web`, and `packages/rules` are **built**. Anything marked
> *later* below is still target shape, not a tree on disk.

## System shape

```
apps/web        Next.js App Router — UI + route handlers (Vercel), output: 'standalone'
  src/app/                   routes and pages — entry points only, no business logic
  src/server/db/             drizzle schema, migrations, seed, the one pooled getDb()
  src/server/flags/          isFeatureEnabled() — fail-closed kill switches
  src/server/observability/  logger + captureError — the only pino/Sentry importers
packages/rules  the rule engine: pure, I/O-free, the product IP

later, only when the need is real:
packages/db     schema + queries — only once a second consumer needs them
apps/worker     Phase 4 wallet indexer (worker container, not a VPS)
```

`packages/db` was deliberately **not** introduced. `apps/web` is still the only consumer
of the schema and queries, so they live at `apps/web/src/server/db`. The bar for
extracting it is a second real consumer (`apps/worker`), not anticipation of one.

Deliberately not split further up front — see
[decisions/monorepo-package-shape](decisions/monorepo-package-shape.md).

## Dependency direction

`apps/*` → `packages/*`. Packages never import from apps. `packages/rules` sits at the
bottom and imports nothing of ours.

The load-bearing rule: **`packages/rules` does no I/O** — no DB, no `fetch`, no `next/*`.
It is a pure function of (constitution, history, proposed trade) → decision. That single
property is what keeps hosting decisions decoupled from business logic, and what makes
adding a worker process later a non-event.

## Data flow

```
wallet → apps/web (UI) → route handler → packages/rules → decision
                              │                              │
                              ▼                              ▼
                          Postgres                  structured event
                     (source of truth)            (audit trail, Phase 5)
                              │
                              ▼
                  allow → Jupiter → Solana (user signs)
```

Rules are evaluated server-side with server-authored timestamps, never in the client —
see [decisions/server-side-rule-evaluation](decisions/server-side-rule-evaluation.md).

One Postgres is authoritative for constitutions, rule state, allowances, and trade
history; the web app and any future worker share it — see
[decisions/single-source-of-truth-database](decisions/single-source-of-truth-database.md).
It is reached through exactly one handle (`getDb()`, pooled), managed by Drizzle —
see [decisions/migration-and-test-tooling](decisions/migration-and-test-tooling.md).

Two cross-cutting rules constrain every module above: a feature is gated by
`isFeatureEnabled()` and fails closed
([decisions/feature-flags-and-kill-switches](decisions/feature-flags-and-kill-switches.md)),
and it logs and reports errors through the observability wrappers rather than importing
pino or Sentry directly
([decisions/observability-stack](decisions/observability-stack.md)).

Product context, observability requirements, and safety-infrastructure rules (kill
switches, fail-closed, idempotency) live in **CLAUDE.md** and are not duplicated here.

> Update via the `sync-knowledge` skill when an architectural boundary, package,
> or flow is introduced or changed.
