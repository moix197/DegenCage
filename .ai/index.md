# Knowledge Index

The map agents read first. One row per module/package: its single responsibility,
where it lives, and links to any decision or pattern doc. Keep rows terse —
this is a lookup table, not documentation. Retire rows that no longer point
anywhere real.

## Modules

| Module / package | Responsibility (one line) | Path | Decisions / patterns |
| ---------------- | ------------------------- | ---- | -------------------- |
| `@degencage/web` | Next.js App Router UI + route handlers; owns everything server-side that isn't the rule engine | `apps/web` ([README](../apps/web/README.md)) | [hosting-and-growth-path](decisions/hosting-and-growth-path.md) |
| `@degencage/rules` | The rule engine — pure, I/O-free, the product IP | `packages/rules` | [monorepo-package-shape](decisions/monorepo-package-shape.md) |
| db | Drizzle schema, migrations, and the one pooled Postgres handle (`getDb()`) | `apps/web/src/server/db` | [migration-and-test-tooling](decisions/migration-and-test-tooling.md), [single-source-of-truth-database](decisions/single-source-of-truth-database.md) |
| flags | `isFeatureEnabled()` — the single fail-closed kill-switch read path | `apps/web/src/server/flags` | [feature-flags-and-kill-switches](decisions/feature-flags-and-kill-switches.md) |
| observability | `logger` + `captureError` — the only import points for pino and Sentry | `apps/web/src/observability` | [observability-stack](decisions/observability-stack.md) |
| auth | SIWS sign-in, rate-limited nonce issuance, session issue/revoke/`resolveSession()`, and the client wallet account watcher | `apps/web/src/server/auth` ([README](../apps/web/src/server/auth/README.md)), `apps/web/src/client/wallet` | [rate-limit-forwarded-header-trust](decisions/rate-limit-forwarded-header-trust.md), [wallet-account-switch-desync](decisions/wallet-account-switch-desync.md), [wallet-standard-ui-dependency](decisions/wallet-standard-ui-dependency.md) |

> Add a row when a module lands. Don't pre-populate rows for paths that don't exist.

## Cross-cutting

| Concern | Where it's handled | Notes |
| ------- | ------------------ | ----- |
| Hosting / deploy | Vercel + hosted Postgres; managed services added additively, no VPS. The nonce limit **trusts the platform's forwarded headers** — re-verify before moving off Vercel | [hosting-and-growth-path](decisions/hosting-and-growth-path.md), [rate-limit-forwarded-header-trust](decisions/rate-limit-forwarded-header-trust.md) |
| Package layout | pnpm workspace; `apps/web` + `packages/rules`, not split further yet | [monorepo-package-shape](decisions/monorepo-package-shape.md) |
| Data store | one Postgres = source of truth; Redis / event store are never a copy of it | [single-source-of-truth-database](decisions/single-source-of-truth-database.md) |
| Rule enforcement | server-side only, server-authored timestamps | [server-side-rule-evaluation](decisions/server-side-rule-evaluation.md) |
| Time & history | `occurred_at` (block) vs `observed_at` (detection); stats derived, never counters | [event-time-vs-observation-time](decisions/event-time-vs-observation-time.md) |
| Product vision & phases | CLAUDE.md → *What we're building*; `roadmap__small.pdf` | not duplicated here |
| Observability | events → Postgres; errors → Sentry; logs → pino/stdout; traces deferred | [observability-stack](decisions/observability-stack.md); rules in CLAUDE.md |
| Kill switches / fail-closed / idempotency | `feature_flags` table + `isFeatureEnabled()`; rules in CLAUDE.md → *Safety infrastructure* | [feature-flags-and-kill-switches](decisions/feature-flags-and-kill-switches.md) |
| Schema / migrations / tests / DB host | Drizzle + drizzle-kit, Vitest, Neon (pooled WebSocket driver) | [migration-and-test-tooling](decisions/migration-and-test-tooling.md) |
| Caller identity | `resolveSession()` is the **only** answer to "which wallet is this request for" — no route reads an address from a request body; single-use nonce, supersede+consume+insert in one transaction, 30-day sliding expiry inside a 90-day absolute cap | [auth README](../apps/web/src/server/auth/README.md) |
| Unauthenticated write surfaces | `/api/auth/nonce` is throttled by counting its own rows in Postgres (10 / 5 min, keyed by a hashed client address) and reaped opportunistically — no scheduler and no Redis before the Phase 4 worker. The key is an **unverified forwarded header**: a deployment trust assumption, not a bug | [auth README](../apps/web/src/server/auth/README.md), [rate-limit-forwarded-header-trust](decisions/rate-limit-forwarded-header-trust.md) |
| Wallet identity | session identity can lag the wallet's active account after an in-extension switch — **accepted limitation**, read before using `resolveSession()` without a fresh signature | [wallet-account-switch-desync](decisions/wallet-account-switch-desync.md) |
