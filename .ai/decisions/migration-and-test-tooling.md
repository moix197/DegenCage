# Migration, test, and Postgres-host tooling

**Decision:** Drizzle ORM + drizzle-kit for schema and migrations, Vitest as the single
test runner for the whole workspace, Neon as the Postgres host, reached through
`@neondatabase/serverless`' **WebSocket pool** (`drizzle-orm/neon-serverless`).

Two connection strings, and the split is load-bearing:

| Env var | Connection | Used by |
| ------- | ---------- | ------- |
| `DATABASE_URL` | direct | drizzle-kit `generate` / `migrate` only |
| `DATABASE_URL_POOLED` | pooled | everything the app does at runtime |

**Why:**

*Drizzle* — the schema is TypeScript, so `$inferSelect` types flow straight into
`packages/rules`' pure functions with no codegen step and no runtime between us and the
SQL. Migrations are plain checked-in `.sql` under `apps/web/src/server/db/migrations/`,
which matters because rule state is append-only and auditable (CLAUDE.md): a reviewer
reads the SQL, not an ORM's intent.

*The WebSocket pool over the HTTP driver.* Neon offers both. HTTP is a one-shot query
per request and cannot express a multi-statement transaction — but
[single-source-of-truth-database](single-source-of-truth-database.md) makes idempotency
the *database's* job via transactions, row locks (`SELECT ... FOR UPDATE`), and unique
constraints, and Phase 4's reconciliation depends on exactly that. Choosing HTTP now
would mean rewriting the client the moment two writers exist. The pooled connection is
non-negotiable regardless of driver: serverless opens a connection per invocation.

*Vitest* — one root `vitest.config.ts` covers `apps/web` and `packages/rules` together,
so `packages/rules` stays testable with no browser and no database, which is the property
[monorepo-package-shape](monorepo-package-shape.md) exists to protect. It reuses Vite's
transform, so the TS-source workspace package needs no build step to be tested or
imported.

*Neon* — hosted, reachable from Vercel, has a real pooler, and its free tier fits Phase 0.
Supabase was the equivalent alternative; Neon won on branching (a throwaway branch per
migration test) since we are not using Supabase's auth or storage.

**Rejected:**

- **Prisma** — heavier runtime, a generate step in the critical path, and a query layer
  that obscures the lock/transaction semantics this project has to reason about directly.
- **Raw SQL + a hand-rolled migration runner** — migrations are the one place to reuse a
  mature tool; hand-rolling it is a bug source with no upside.
- **`drizzle-orm/neon-http`** — simpler, but no transactions. See above.
- **`@vercel/postgres`** — the lock-in wrapper [hosting-and-growth-path](hosting-and-growth-path.md)
  rules out.
- **Jest** — a second toolchain to configure for TS/ESM when Vite's is already present.

**Constraints it creates:**

- **Runtime never touches `DATABASE_URL`.** `getDb()` requires `DATABASE_URL_POOLED` and
  throws otherwise, so a direct-connection leak fails loudly instead of quietly
  exhausting Postgres.
- Root `.env` is the single env source; root scripts (`pnpm dev`/`build`/`db:*`) inject it
  via `dotenv-cli`. Nothing reads a per-app `.env.local`.
- Every schema change is a generated, committed migration — never an ad-hoc `ALTER` and
  never `drizzle-kit push` against a real database.
- Tests must stay hermetic: no test opens a database connection. DB-touching modules are
  split into a pure decision function plus a thin query, and the query is mocked
  (`apps/web/src/server/flags/feature-flags.test.ts` is the reference shape).
- **`nodeLinker: hoisted` in `pnpm-workspace.yaml`, forced by `output: 'standalone'`.**
  Next's trace step reproduces `node_modules` symlinks with untyped `fs.symlink` calls,
  which Windows refuses outside an elevated or Developer-Mode process (it permits
  junctions only) — the build dies at the final copy even though compile, typecheck, and
  page generation all succeed. A hoisted, symlink-free `node_modules` sidesteps it and
  keeps the build identical on Windows, Linux, and Vercel. The cost is pnpm's
  phantom-dependency protection: an undeclared import now resolves silently, so **every
  package must declare every dependency it imports**. Revisit if `output: 'standalone'`
  is ever dropped or all builds move to Linux CI.
