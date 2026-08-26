# Architecture

The high-level shape of the system: package boundaries, how data flows, and the
rules that keep dependencies pointing one direction.

> **No code exists yet.** What follows is the agreed target shape, not a description of
> a tree on disk. Replace each section with the real thing as packages land.

## System shape

```
apps/web        Next.js — UI + route handlers (Vercel)
packages/rules  the rule engine: pure, I/O-free, the product IP
packages/db     schema + queries — added when a second consumer needs them

later, only when the need is real:
apps/worker     Phase 4 wallet indexer (worker container, not a VPS)
```

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

Product context, observability requirements, and safety-infrastructure rules (kill
switches, fail-closed, idempotency) live in **CLAUDE.md** and are not duplicated here.

> Update via the `sync-knowledge` skill when an architectural boundary, package,
> or flow is introduced or changed.
