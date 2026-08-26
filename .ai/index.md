# Knowledge Index

The map agents read first. One row per module/package: its single responsibility,
where it lives, and links to any decision or pattern doc. Keep rows terse —
this is a lookup table, not documentation. Retire rows that no longer point
anywhere real.

## Modules

| Module / package | Responsibility (one line) | Path | Decisions / patterns |
| ---------------- | ------------------------- | ---- | -------------------- |
| _none yet_ | _No code has landed; target shape is agreed, not built._ | | [monorepo-package-shape](decisions/monorepo-package-shape.md) |

> Add the first real row when the first package lands. Don't pre-populate rows for paths
> that don't exist.

## Cross-cutting

| Concern | Where it's handled | Notes |
| ------- | ------------------ | ----- |
| Hosting / deploy | Vercel + hosted Postgres; managed services added additively, no VPS | [hosting-and-growth-path](decisions/hosting-and-growth-path.md) |
| Package layout | pnpm workspace; `apps/web` + `packages/rules`, not split further yet | [monorepo-package-shape](decisions/monorepo-package-shape.md) |
| Data store | one Postgres = source of truth; Redis / event store are never a copy of it | [single-source-of-truth-database](decisions/single-source-of-truth-database.md) |
| Rule enforcement | server-side only, server-authored timestamps | [server-side-rule-evaluation](decisions/server-side-rule-evaluation.md) |
| Time & history | `occurred_at` (block) vs `observed_at` (detection); stats derived, never counters | [event-time-vs-observation-time](decisions/event-time-vs-observation-time.md) |
| Product vision & phases | CLAUDE.md → *What we're building*; `roadmap__small.pdf` | not duplicated here |
| Observability | events → Postgres; errors → Sentry; logs → pino/stdout; traces deferred | [observability-stack](decisions/observability-stack.md); rules in CLAUDE.md |
| Kill switches / fail-closed / idempotency | CLAUDE.md → *Safety infrastructure* | not duplicated here |
