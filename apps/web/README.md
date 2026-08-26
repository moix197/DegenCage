# `@degencage/web`

Next.js App Router app: the UI, the route handlers, and everything server-side that is
not the rule engine. Architecture and the *why* behind each choice live in `.ai/` — this
file is setup and commands only.

## Setup

```bash
pnpm install
cp .env.example .env      # at the repo ROOT, not here — then fill in real values
pnpm db:migrate           # apply migrations (direct connection)
pnpm db:seed              # seed feature flags
pnpm dev                  # http://localhost:3000
```

All commands run from the **repo root**; they inject the root `.env` via `dotenv-cli`.
`.env` is gitignored — never commit it.

| Command | What it does |
| ------- | ------------ |
| `pnpm dev` | Next dev server |
| `pnpm build` | Production build (`output: 'standalone'`) |
| `pnpm test` | Vitest across `apps/web` + `packages/rules` |
| `pnpm typecheck` | `tsc --noEmit` in every workspace |
| `pnpm db:generate` | Generate a migration from `src/server/db/schema.ts` |
| `pnpm db:migrate` | Apply pending migrations |
| `pnpm db:seed` | Upsert the feature-flag rows in `src/server/db/seed.ts` |

## Env vars

| Var | Required | Used by |
| --- | -------- | ------- |
| `DATABASE_URL` | yes | drizzle-kit `generate`/`migrate` — **direct** Neon connection |
| `DATABASE_URL_POOLED` | yes | the app at runtime — **pooled** connection; `getDb()` throws without it |
| `SENTRY_DSN` | no | unset means Sentry no-ops; errors are still logged |
| `LOG_LEVEL` | no | pino level, defaults to `info` |

Later phases add their vars to `.env.example` as they introduce them.

## Server-side entry points

- `src/server/db/client.ts` — `getDb()`, the only Postgres handle.
- `src/server/flags/feature-flags.ts` — `isFeatureEnabled(key, ctx?)`. Every gated
  feature calls this; it fails closed on an unknown key, a disabled row, an out-of-scope
  user, or a database error. Add new flags to `src/server/db/seed.ts` in the same change
  as the feature they guard.
- `src/server/observability/logger.ts` — `logger`. Import `pino` nowhere else.
- `src/server/observability/error-tracking.ts` — `captureError`. Import
  `@sentry/nextjs` nowhere else.

## Why `node_modules` is hoisted

`pnpm-workspace.yaml` sets `nodeLinker: hoisted`. Next's `output: 'standalone'` trace step
recreates `node_modules` symlinks, which Windows refuses outside an elevated or
Developer-Mode process; a symlink-free `node_modules` makes the build work the same
everywhere. The catch: pnpm no longer catches undeclared dependencies, so **declare every
package you import** in the importing workspace's `package.json`.
