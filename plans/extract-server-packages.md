# Plan: Extract server packages out of `apps/web/src/server/**` + `observability/**`

**Created:** 2026-08-28
**Branch:** `refactor/extract-server-packages`
**Status:** not started

## Context

`apps/web/src/server/**` (13 directories) and `apps/web/src/observability/**` (3 files) have grown
into the de facto backend of DegenCage while living entirely inside the Next.js app. CLAUDE.md's
Architecture section requires "modular by packages... clear package boundaries... no circular
dependencies." Today there are circular *directory* dependencies (`auth -> swap -> chain -> auth`,
`observability <-> db`, a type-only `db <-> chain`) that are invisible to `tsc`/bundlers only
because everything still lives inside one app and resolves through relative imports. The moment any
of these directories becomes a real pnpm workspace package, those cycles become hard build errors —
so this refactor front-loads the cuts.

This is a **behavior-preserving refactor**. No feature work, no flag-state changes, no enforcement
changes. Phase 6 of the Jupiter live-swap plan stays deferred; all three kill switches stay seeded
`false`. The end state is 10 packages (`@degencage/rules` unchanged, plus 9 new:
`platform, chain, pricing, constitution, allowances, swap, dashboard, metrics, feedback`),
`server/auth` and `server/admin` frozen in place inside `apps/web` (a real auth library replaces
`auth` later — it is explicitly not being extended or packaged now).

**Why phases are not vertical slices here.** This plan is infrastructure with zero new user-facing
surface — the documented exception in the plan-sequential spec ("pure infrastructure prerequisites
with zero user-facing surface"). There is no new screen, field, or flow to exercise after any single
phase. Every phase is instead required to be independently **green** (672+ tests pass, count never
drops), **mergeable** (`pnpm -r typecheck` clean, `next build` succeeds), and **revertable** (one
package's move per phase, or one isolated concern), with "success criteria" phrased as *"all
existing behavior is provably unchanged AND this specific structural move is complete,"* verified by
the same three gates every time plus phase-specific checks (import-path sweeps, `git diff` on moved
files, `drizzle-kit generate` reporting no schema drift).

## Risk: high

Large mechanical surface (dozens of files, ~125 cross-directory import edges), a live-DB migration
relocation, and several subtle-but-load-bearing invariants that must not be disturbed while files
move around them — most importantly the atomic SIWS sign-in transaction in `auth/solana-siws.ts`
(session supersede + establish inside one `getDb().transaction`) and the fail-closed contract on
every flag/session/price read. No new logic is being written, which caps the risk below "ultra-high,"
but the blast radius (every route, every page, every test) is real.

## Dependencies & Risks

- **Order dependency inside the domain packages, found during planning, not part of the user's
  original phase sketch:** `server/chain/reconcile-wallet.ts` imports `loadWindowedTrades` from
  what becomes `@degencage/allowances` (the renamed `server/rules`). The originally sketched order
  (`Phase 4: chain+pricing` before `Phase 5: feedback+allowances`) would make `chain` a package that
  needs to import from a directory (`server/rules`) still living inside `apps/web` — illegal
  ("packages never import apps"). **Fix applied in this plan: swap the two phases** —
  `Phase 4 = allowances + feedback`, `Phase 5 = chain + pricing`. `feedback` has zero dependency on
  `chain`/`pricing`/`allowances`, so pairing it with `allowances` costs nothing and unblocks `chain`
  cleanly. `constitution+swap` (Phase 6) and `dashboard+metrics` (Phase 7) keep their original
  grouping and order — both already come after everything they depend on.
- **`chain <-> pricing` cycle — confirmed and resolved during planning verification.** Exactly two
  cross-directory edges, both runtime values, neither erasable (`verbatimModuleSyntax` +
  `isolatedModules` are both set, `tsconfig.base.json:10-11`): `chain/reconcile-wallet.ts:30`
  imports `priceTrade` from `pricing` (chain -> pricing), and `pricing/price-trade.ts:3` imports
  `isStablecoin` from `chain/stablecoin-mints.ts` (pricing -> chain). **Decided fix:** move
  `apps/web/src/server/chain/stablecoin-mints.ts` into `pricing` — it is 15 lines of pure data (one
  frozen `ReadonlySet` of 2 mint addresses + a one-line `isStablecoin(mint)` predicate, zero
  imports, zero I/O). Moving it deletes the only `pricing -> chain` edge and leaves a clean
  `chain -> pricing` DAG; it creates no new edge, since `chain -> pricing` already exists via
  `priceTrade`. Cost: 1 file move + 4 import rewrites (`pricing/price-trade.ts:3`,
  `chain/classify-token.ts:5`, `chain/reconcile-wallet.ts:29`, `chain/reconcile-wallet.test.ts:15`)
  plus the test-only mock at `chain/reconcile-wallet.test.ts:47` (mirrors the `priceTrade` edge).
  Rejected alternatives, recorded in `.ai/decisions/` at Phase 8: (a) keep `stablecoin-mints.ts` in
  `chain` and dependency-inject `priceTrade` into `reconcile-wallet.ts` to sever the edge instead —
  far more edits for the same outcome; (b) put it in `platform` — wrong by charter, this is domain
  data, not infrastructure; (c) a new shared leaf package — pure overhead for 15 lines. This makes
  `pricing` a leaf that must be created before or alongside `chain` — Phase 5 already creates both
  in one commit, so no cross-phase ordering issue results.
- **The session-as-parameter pattern (decision: cut `chain -> auth`) generalizes to two more
  modules, not just `chain`.** `cycles-and-di.md` §B independently found that `feedback/feedback.ts`
  (`requireSession()`) and `constitution/{commitment.ts,pending-changes.ts}` (two `requireSession()`
  call sites each) ambiently call `resolveSession()` from frozen `auth/session.ts`, exactly like
  `reconcile-wallet.ts` did. Once `feedback` (Phase 4) and `constitution` (Phase 6) become packages,
  those ambient calls become an illegal package -> app edge the same way `chain -> auth` was illegal.
  This plan applies the identical fix (explicit `session: SessionIdentity` parameter, resolved one
  level up by the route handler / RSC page / Server Action that already exists) inside each
  package's own creation phase, not in Phase 1 — Phase 1 is scoped to the one edge that is part of
  an actual **cycle** (`auth -> swap -> chain -> auth`); `feedback`/`constitution` are "package would
  import a frozen app module" violations, not cycles, and only bite once each is extracted.
- Neither the `chain <-> pricing` cut nor the feedback/constitution session generalization existed
  as a recorded `.ai/` decision before this plan — both are now fully specified above (Phase 5 and
  Phase 4/6 respectively) and get written to `.ai/decisions/` at Phase 8 sync, including the
  rejected alternatives for the `chain <-> pricing` cut (see Phase 5).
- **Phantom dependencies.** `nodeLinker: hoisted` gives zero safety net — every package must declare
  every bare import in its own `package.json`. Exact runtime deps for `platform` (drizzle-orm, the
  Neon client package, `ws` for the pooled WebSocket driver, `pino`, `@sentry/nextjs`, etc.) are not
  fully confirmed by research; each package-creation phase audits its own `src/**` imports against
  its `package.json` before considering the phase done — this is also what guardrail test (c)
  mechanically enforces from Phase 1 onward.
- **Migration journal corruption** if Phase 3 does anything other than a verbatim path move — no
  regeneration, no snapshot edits.
- **Windows dev environment**: `output: 'standalone'` forces `nodeLinker: hoisted` (symlink
  limitation) — do not touch that Next.js config setting as part of this refactor.
- Per-phase risk budget follows the user's stated top-3: phantom deps surfacing only on Vercel (not
  locally), a package silently importing `apps/web`, and migration journal corruption. Guardrail
  tests (Phase 1) and the Phase 3 isolation directly target these.
- **CLAUDE.md compliance, checked per phase, not just at the end:** pnpm only (every script/command
  in this plan is `pnpm`, never `npm`/`yarn`); thin entry points (Phase 7 pulls the last inline DB
  query out of `app/dashboard/page.tsx`); reuse before reinvent (Phase 2 explicitly keeps the
  existing `executor: DatabaseExecutor = getDb()` optional-parameter convention rather than
  inventing a context/DI mechanism — that convention already covers ~36 call sites); minimal changes
  (every move is `git mv` + import repoint, no incidental rewrites); preserve behavior (no phase
  changes a flag value, a route contract, or an enforcement outcome); no dead code (old
  `apps/web/src/server/**` paths are removed by the move itself, not left behind); observability is
  carried with its code (Phase 2 moves `logger`/`error-tracking`/`events` as one unit, never
  drops instrumentation).

## Phases

### Phase 0: Create worktree

**Mode:** hil
**Type:** config

**Steps:**

- [ ] Confirm branch name (`refactor/extract-server-packages`) and base ref (`main`) with the user
- [ ] Run `git worktree add ../degencage-extract-server-packages -b refactor/extract-server-packages main`
- [ ] Verify worktree is active and on the correct branch (`git worktree list`)

---

### Phase 1: Cycle cuts + flag-name registry + guardrail tests (no packages created yet)

**Risk:** medium
**Mode:** afk
**Type:** mixed
**Success criteria:** Behavior is provably unchanged (all existing routes/pages produce identical
output; `reconcileWallet`'s three callers now resolve the session themselves and pass it in instead
of relying on an ambient call inside `chain`) AND every `*_FLAG` name constant is centralized in one
registry module that the 9 defining modules and every consumer (including `seed.ts`) import from,
with flag key strings byte-identical to today AND two new guardrail tests exist, generalized to walk
any `packages/*/src` directory, so every later phase is gated by them automatically.
**Review focus:** diff every extracted flag key string against its pre-refactor value (they key DB
rows — zero tolerance for drift); confirm `chain/reconcile-wallet.ts` has zero remaining
`resolveSession`/`../auth/session` import and all three of its callers resolve session before
calling it; this phase is a hard prerequisite for every later phase, so its guardrail tests
(`test/architecture-guardrails.test.ts`, `packages/rules/src/index.test.ts`'s recursive purity
check) must both actually run and actually fail on a deliberately broken fixture — spot-check that,
not just that they pass.
**Commit message:** `refactor(server): cut chain->auth cycle, centralize flag names, add package guardrail tests`

**File changes:**

| Action | File | What changes |
|---|---|---|
| create | `apps/web/src/server/flags/flag-names.ts` | All 14 `*_FLAG` string constants, moved verbatim (same key strings) from their 9 defining modules |
| modify | `apps/web/src/server/auth/solana-siws.ts` | `WALLET_CONNECT_FLAG` now imported from `flag-names.ts`, no longer defined/exported here |
| modify | `apps/web/src/server/chain/helius-client.ts` | `CHAIN_HELIUS_FLAG` moved to registry |
| modify | `apps/web/src/server/chain/jupiter-tokens.ts` | `CLASSIFICATION_JUPITER_MCAP_FLAG` moved to registry |
| modify | `apps/web/src/server/chain/broadcast-transaction.ts` | `CHAIN_BROADCAST_FLAG` moved to registry |
| modify | `apps/web/src/server/chain/reconcile-wallet.ts` | `CHAIN_HELIUS_RECONCILE_FLAG` + `LOSS_LIMIT_ENABLED_FLAG` moved to registry; **and** `reconcileWallet(correlationId)` -> `reconcileWallet(correlationId, session: SessionIdentity)`, internal `resolveSession()` call removed, `import { resolveSession } from '../auth/session'` deleted |
| modify | `apps/web/src/server/constitution/commitment.ts` | `CONSTITUTION_AUTHOR_FLAG` moved to registry (session-param generalization deferred to Phase 6) |
| modify | `apps/web/src/server/constitution/pending-changes.ts` | `CONSTITUTION_PENDING_CHANGE_APPLY_FLAG` moved to registry |
| modify | `apps/web/src/server/flags/feature-flags.ts` | `DASHBOARD_DISCIPLINE_VIEW_FLAG`, `HOME_STATUS_PANEL_FLAG`, `TRADE_TERMINAL_FLAG` moved to registry; `isFeatureEnabled()` implementation stays here, imports the 3 constants back |
| modify | `apps/web/src/server/pricing/binance-klines.ts` | `PRICING_BINANCE_FLAG` moved to registry |
| modify | `apps/web/src/server/pricing/birdeye-price.ts` | `PRICING_BIRDEYE_FLAG` moved to registry |
| modify | `apps/web/src/server/swap/jupiter-client.ts` | `JUPITER_SWAP_BUILD_FLAG` moved to registry |
| modify | `apps/web/src/server/feedback/feedback.ts` | `FEEDBACK_CAPTURE_FLAG` moved to registry (not seeded, moved for consistency) |
| modify | `apps/web/src/server/db/seed.ts` | Single import from `flag-names.ts` replaces imports from 11 separate modules |
| modify | `apps/web/src/server/swap/quote-service.ts` | `LOSS_LIMIT_ENABLED_FLAG` now imported from `flag-names.ts`, not `../chain/reconcile-wallet` |
| modify | `apps/web/src/server/swap/submit-service.ts` | same `LOSS_LIMIT_ENABLED_FLAG` re-source |
| modify | `apps/web/src/app/api/dashboard/route.ts` | same `LOSS_LIMIT_ENABLED_FLAG` re-source |
| modify | `apps/web/src/app/api/wallet/reconcile/route.ts` | resolve session explicitly (`resolveSession()`), pass identity into `reconcileWallet(correlationId, session)` — this route did not previously call `resolveSession` itself |
| modify | `apps/web/src/app/api/swap/intent/[id]/route.ts` | confirm its existing `resolveSession()` call (line ~172) executes before the `reconcileWallet` call (line ~148, via `withDeadline`); thread the resolved identity through instead of relying on `reconcileWallet`'s old ambient call |
| modify | `apps/web/src/app/dashboard/page.tsx` | reuse the `SessionIdentity` already resolved at line ~107 when calling `reconcileWallet` at line ~144 |
| modify | `apps/web/src/server/chain/reconcile-wallet.test.ts` | update to pass a `SessionIdentity` fixture instead of mocking `resolveSession` |
| modify | `apps/web/src/server/flags/feature-flags.test.ts` | update for the 3 relocated constants if it imports them directly |
| modify | `vitest.config.ts` | widen `test.include` from `'packages/rules/src/**/*.test.ts'` to `'packages/*/src/**/*.test.ts'`, add `'test/**/*.test.ts'` |
| modify | `packages/rules/src/index.test.ts` | fix the `describe('package purity')` check from a flat `readdirSync` to a recursive walk (it currently passes vacuously for any subdirectory) |
| create | `test/architecture-guardrails.test.ts` | (b) no file under `packages/*/src` imports `@/`, `apps/web`, or a relative path that escapes its own package; (c) every bare (non-`node:`) import specifier under `packages/*/src` appears in that package's own `package.json` `dependencies`/`devDependencies` |

**Steps:**

- [ ] Grep every `*_FLAG` constant definition (9 files, 14 constants — see file table) and copy each
      into `flag-names.ts` with its exact string value unchanged (flag keys are DB row keys — must
      not change)
- [ ] Update each defining module to import its constant(s) back from `flag-names.ts` rather than
      defining them locally; remove the local `export const ..._FLAG` declarations
- [ ] Grep for every external consumer of each moved constant (`db/seed.ts`, `quote-service.ts`,
      `submit-service.ts`, `app/api/dashboard/route.ts`, and any other app-layer importer found by
      grep) and repoint the import to `flag-names.ts`; let `pnpm -r typecheck` surface anything missed
- [ ] Change `reconcileWallet`'s signature to take `session: SessionIdentity` as a second parameter;
      delete its internal `resolveSession()` call and the `../auth/session` import
- [ ] Update `reconcileWallet`'s three callers (`app/api/wallet/reconcile/route.ts`,
      `app/api/swap/intent/[id]/route.ts`, `app/dashboard/page.tsx`) to resolve the session
      themselves (adding the call where it doesn't already exist) and pass the identity in
- [ ] Update `reconcile-wallet.test.ts` and any route test mocking `resolveSession` for the new signature
- [ ] Widen `vitest.config.ts`'s `include` glob; add `test/` to it
- [ ] Fix `packages/rules/src/index.test.ts`'s purity check to recurse into subdirectories
- [ ] Write `test/architecture-guardrails.test.ts` covering guardrails (b) and (c), generic over
      `packages/*/src` so it automatically covers every package created in later phases
- [ ] Run `pnpm -r typecheck`, `pnpm test`, `pnpm --filter @degencage/web build` (or `next build`)
      and fix everything the flag-name/session-param sweep breaks

**Tests:**

| Action | File | What it covers |
|---|---|---|
| modify | `apps/web/src/server/chain/reconcile-wallet.test.ts` | `reconcileWallet` accepts an explicit session, no longer calls `resolveSession` |
| modify | `apps/web/src/app/api/wallet/reconcile/route.test.ts` (if present) | route resolves session before calling `reconcileWallet` |
| modify | `packages/rules/src/index.test.ts` | recursive purity check actually walks subdirectories |
| create | `test/architecture-guardrails.test.ts` | no package escapes its boundary; no bare import is undeclared in `package.json` |

**Verification:**

- [ ] `pnpm -r typecheck` clean
- [ ] `pnpm test` — 672+ tests pass (count must not drop)
- [ ] `pnpm --filter @degencage/web build` succeeds
- [ ] Manual: `pnpm dev`, exercise wallet connect + one reconcile trigger (dashboard load or
      `/api/wallet/reconcile`) to confirm reconciliation still runs and reads the correct wallet
- [ ] Grep confirms zero remaining `*_FLAG` string-literal re-definitions outside `flag-names.ts`

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [ ] Tests for this phase written and passing
- [ ] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `refactor(server): cut chain->auth cycle, centralize flag names, add package guardrail tests`
- [ ] Phase marked complete

---

### Phase 2: Create `@degencage/platform` (db + observability + flags + rate-limit)

**Risk:** high
**Mode:** afk
**Type:** backend
**Success criteria:** `apps/web` behaves identically end-to-end while `db`, `observability`,
`flags`, and the shared row-counting rate limiter are now served from `@degencage/platform` (with
subpath exports `.`, `./db`, `./flags`, `./rate-limit`, `./error-tracking`, `./events`) instead of
`apps/web/src/server/{db,flags}` and `apps/web/src/observability/**`. `apps/web`'s frozen `auth`
module no longer defines `CHALLENGE_RATE_LIMIT_MAX`/`_WINDOW_MS` itself — it imports them back from
platform. `TokenClassificationQuality` is defined in platform's schema, not in
`chain/classify-token.ts`. `next.config.ts` transpiles the new package. Migrations/`drizzle.config.ts`
are explicitly **not** touched yet (Phase 3).
**Review focus:** the SIWS atomic transaction in `apps/web/src/server/auth/solana-siws.ts:429`
(session supersede + establish inside one `getDb().transaction`) is untouched — `auth`/`admin` are
frozen for this entire plan, this phase included; `recordEvent`'s existing
`executor: DatabaseExecutor = getDb()` default-parameter convention is preserved verbatim, not
replaced by a new DI/context mechanism (no `setDb()`, no `AsyncLocalStorage` — none of that exists
in this codebase today and this refactor does not introduce it); `packages/platform/package.json`'s
dependencies were audited against actual `src/**` imports, not assumed from memory.
**Commit message:** `refactor: extract @degencage/platform (db, observability, flags, rate-limit)`

**File changes:**

| Action | File | What changes |
|---|---|---|
| create | `packages/platform/package.json` | `private: true`, `type: module`, `exports` map (`.`, `./db`, `./flags`, `./rate-limit`, `./error-tracking`, `./events`), `scripts.typecheck`, `scripts["db:seed"]`; runtime deps audited from actual imports (drizzle-orm, the Neon serverless client, `ws`, `pino`, `@sentry/nextjs`, `drizzle-zod` if used, etc.) — do not guess, grep `packages/platform/src/**` once files land |
| create | `packages/platform/tsconfig.json` | mirrors `packages/rules/tsconfig.json`: `{ extends: "../../tsconfig.base.json", include: ["src/**/*.ts"] }` |
| move | `apps/web/src/server/db/client.ts` -> `packages/platform/src/db/client.ts` | unchanged logic; still reads `DATABASE_URL_POOLED` lazily inside `getDb()` |
| move | `apps/web/src/server/db/schema.ts` -> `packages/platform/src/db/schema.ts` | `TokenClassificationQuality` now defined here directly (moved out of `chain/classify-token.ts`, see below) instead of type-imported; the existing `export type { TokenClassificationQuality }` re-export stays so downstream imports keep working |
| move | `apps/web/src/server/db/seed.ts` -> `packages/platform/src/db/seed.ts` | now imports flags from its own package (`./flags`), no cross-package/app imports |
| move | `apps/web/src/observability/logger.ts` -> `packages/platform/src/observability/logger.ts` | unchanged |
| move | `apps/web/src/observability/error-tracking.ts` -> `packages/platform/src/observability/error-tracking.ts` | change the `./logger` import to a lazy/dynamic import so a browser bundle pulling `./error-tracking` does not eagerly instantiate `pino` |
| move | `apps/web/src/observability/events.ts` -> `packages/platform/src/db/events.ts` (or `src/observability/events.ts`, kept next to `db` since it needs `getDb`) | `DatabaseExecutor` type moves out of this file into `packages/platform/src/db/types.ts` (or `client.ts`) as db's own public type; `recordEvent`'s `executor: DatabaseExecutor = getDb()` default is unchanged (now an intra-package call) |
| move | `apps/web/src/server/flags/feature-flags.ts` + `apps/web/src/server/flags/flag-names.ts` (from Phase 1) -> `packages/platform/src/flags/` | unchanged behavior |
| move | `apps/web/src/server/constitution/rate-limit.ts` -> `packages/platform/src/rate-limit/rate-limit.ts` | imports `CHALLENGE_RATE_LIMIT_MAX`/`_WINDOW_MS` from a new sibling `packages/platform/src/rate-limit/limits.ts` instead of `../auth/challenge-rate-limit` |
| create | `packages/platform/src/rate-limit/limits.ts` | `CHALLENGE_RATE_LIMIT_MAX`, `CHALLENGE_RATE_LIMIT_WINDOW_MS` extracted verbatim (same values) from `apps/web/src/server/auth/challenge-rate-limit.ts` |
| modify | `apps/web/src/server/auth/challenge-rate-limit.ts` | imports the two constants back from `@degencage/platform/rate-limit` instead of defining them (app -> package edge, legal) |
| modify | `apps/web/src/server/chain/classify-token.ts` | `TokenClassificationQuality` deleted from here; imports it from `@degencage/platform/db` instead |
| modify (bulk) | every remaining `apps/web/**` file that imports `getDb`, `schema`, `DatabaseExecutor`, `recordEvent`, `logger`, `captureError`, `isFeatureEnabled`, any `*_FLAG` constant, or `assertWithinConstitutionActionRateLimit` | repoint the import to the matching `@degencage/platform` subpath; there is no shortcut here — let `pnpm -r typecheck` enumerate every break after the moves land |
| modify | `apps/web/src/instrumentation-client.ts` | dynamic `import('./observability/error-tracking')` -> `import('@degencage/platform/error-tracking')` |
| modify | `apps/web/src/app/dashboard/dashboard-panel.tsx`, `apps/web/src/app/trade/trade-panel.tsx` | same dynamic-import repoint (client components) |
| modify | `apps/web/next.config.ts` | add `'@degencage/platform'` to `transpilePackages` |
| modify | `vitest.config.ts` | convert to a `projects` array: one project for `apps/web` (keeps the `@` alias), one for `packages/rules`, one for `packages/platform` — package projects get **no** `@` alias so a package test importing `@/...` fails loudly |
| modify | root `package.json` | `db:seed` -> `pnpm --filter @degencage/platform db:seed` (was `tsx apps/web/src/server/db/seed.ts` via dotenv wrapper) |

**Steps:**

- [ ] Scaffold `packages/platform` (`package.json`, `tsconfig.json`) mirroring `packages/rules`
- [ ] `git mv` `db/client.ts`, `db/schema.ts`, `db/seed.ts`, the three `observability/*.ts` files,
      `flags/{feature-flags,flag-names}.ts`, `constitution/rate-limit.ts` into their new
      `packages/platform/src/**` homes
- [ ] Move `TokenClassificationQuality`'s definition from `chain/classify-token.ts` into
      `db/schema.ts` (now in platform); update `classify-token.ts` to import it back
- [ ] Extract `CHALLENGE_RATE_LIMIT_MAX`/`_WINDOW_MS` into `platform/src/rate-limit/limits.ts`;
      update `auth/challenge-rate-limit.ts` to import them from `@degencage/platform/rate-limit`
- [ ] Move `DatabaseExecutor` out of `events.ts` into `db`'s own module
- [ ] Make `error-tracking.ts`'s `./logger` import lazy (dynamic `import()`) to avoid eager `pino`
      instantiation from a browser chunk
- [ ] Write `packages/platform`'s `exports` map and `scripts.typecheck`
- [ ] Add `'@degencage/platform'` to `next.config.ts`'s `transpilePackages`
- [ ] Convert `vitest.config.ts` to a `projects` array (apps/web with alias; `rules` and `platform`
      without)
- [ ] Sweep every remaining `apps/web/**` import of the moved modules to `@degencage/platform/...`;
      drive this off `pnpm -r typecheck` failures rather than manual grepping alone
- [ ] Retarget the root `db:seed` script
- [ ] Audit `packages/platform/src/**`'s actual runtime imports against `package.json` dependencies
      (guardrail test (c) from Phase 1 will fail loudly if this is wrong)
- [ ] Run all three gates

**Tests:**

| Action | File | What it covers |
|---|---|---|
| move (with source) | `apps/web/src/server/flags/feature-flags.test.ts`, `constitution/rate-limit.test.ts` (if present), `observability/*.test.ts` | move alongside their source into `packages/platform/src/**` |
| n/a | `test/architecture-guardrails.test.ts` | (from Phase 1) automatically now also checks `packages/platform` |

**Verification:**

- [ ] `pnpm -r typecheck` clean (every package, including the new `platform` typecheck script)
- [ ] `pnpm test` — 672+ tests pass, vitest `projects` run all three projects
- [ ] `pnpm --filter @degencage/web build` succeeds
- [ ] `pnpm db:seed` runs successfully against the (disposable) dev DB and reports the same flag rows
      as before, including confirming the three Phase-6 (live-swap) kill switches are still seeded
      `false` — this refactor moves flag *plumbing*, it must not touch flag *state*
- [ ] Manual: `pnpm dev`, confirm `dashboard-panel.tsx`/`trade-panel.tsx` still lazy-load error
      tracking in the browser without a console error (open devtools, trigger the dynamic import path)
- [ ] Grep confirms zero remaining `@/server/db`, `@/server/flags`, `@/observability`,
      `@/server/constitution/rate-limit` imports anywhere in `apps/web`

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [ ] Tests for this phase written and passing
- [ ] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `refactor: extract @degencage/platform (db, observability, flags, rate-limit)`
- [ ] Phase marked complete

---

### Phase 3: Move migrations + `drizzle.config.ts` into `platform` (ISOLATED)

**Risk:** high
**Mode:** hil
**Type:** config
**Success criteria:** `drizzle-kit generate` run from `packages/platform` against the existing dev DB
reports **no schema changes** (proof the schema/migration history round-tripped correctly), and
`git diff` on every moved migration file shows path-only changes with byte-identical content
(`meta/_journal.json` and every snapshot). This commit touches nothing else — no source files, no
imports, no other config.
**Review focus:** this is the strictest-isolation phase in the plan — reject any diff that touches
anything besides `packages/platform/{drizzle.config.ts,src/db/migrations/**,package.json}` and the
two root `db:generate`/`db:migrate` scripts; confirm every migration file was moved with `git mv`
(never deleted-and-recreated, which would lose history and risk a content drift); confirm
`meta/_journal.json` was never hand-edited or regenerated.
**Commit message:** `refactor(platform): move migrations and drizzle config (isolated)`

**File changes:**

| Action | File | What changes |
|---|---|---|
| move (`git mv`) | `apps/web/src/server/db/migrations/**` -> `packages/platform/src/db/migrations/**` | verbatim, including `meta/_journal.json` and every snapshot |
| move (`git mv`) | `apps/web/drizzle.config.ts` -> `packages/platform/drizzle.config.ts` | `schema`/`out` paths become local-relative (`./src/db/schema.ts`, `./src/db/migrations`) |
| modify | `packages/platform/package.json` | add `drizzle-kit` as a devDependency |
| modify | root `package.json` | `db:generate`/`db:migrate` -> `pnpm --filter @degencage/platform db:generate` / `db:migrate` |

**Steps:**

- [ ] `git mv apps/web/src/server/db/migrations packages/platform/src/db/migrations`
- [ ] `git mv apps/web/drizzle.config.ts packages/platform/drizzle.config.ts`
- [ ] Update the moved `drizzle.config.ts`'s `schema`/`out` fields to local-relative paths
- [ ] Add `drizzle-kit` to `packages/platform/package.json` devDependencies
- [ ] Retarget root `db:generate`/`db:migrate` scripts
- [ ] Run `pnpm --filter @degencage/platform db:generate` against the dev DB and confirm it reports
      no pending changes (proves schema.ts and migration history agree)
- [ ] `git diff --stat` on the moved migration files — confirm zero content diff, path-only

**Tests:**

No automated tests — justified because this is a pure file/path relocation with no behavior change;
its correctness is verified by `drizzle-kit generate`'s explicit "no schema changes" output and a
byte-identical `git diff`, both captured above as required verification steps, not skipped.

**Verification:**

- [ ] `pnpm -r typecheck` clean
- [ ] `pnpm test` — 672+ tests pass (unaffected by this phase, confirms nothing else broke)
- [ ] `pnpm --filter @degencage/web build` succeeds
- [ ] `pnpm --filter @degencage/platform db:generate` reports no schema drift
- [ ] `git diff` on migration files is path-only

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [ ] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase, including manually confirming
      against the live Neon dev DB
- [ ] Changes committed: `refactor(platform): move migrations and drizzle config (isolated)`
- [ ] Phase marked complete

---

### Phase 4: `@degencage/allowances` + `@degencage/feedback`

**Risk:** medium
**Mode:** afk
**Type:** backend
**Success criteria:** The renamed `server/rules` (windowed-trade queries + rolling allowance) is now
`@degencage/allowances`, resolving the `server/rules` vs `packages/rules` name collision, with zero
behavior change to its three internal callers. `feedback` is now `@degencage/feedback` (server
entrypoint `.` plus an isomorphic `./constants` subpath for the one `'use client'` consumer), and no
longer ambiently resolves its own session — `recordFeedbackPrompt`/`recordFeedback` now take a
`session: SessionIdentity` parameter, resolved by `app/api/feedback/route.ts` itself.
**Review focus:** `allowances` is scoped to `rolling-allowance.ts` **only** — confirm no chain
windowing logic was pulled in alongside it (that would re-open the `chain -> pricing` direction
question resolved in Phase 5); `feedback`'s session-as-parameter change matches the Phase 1 `chain`
pattern exactly; the rate limiter still throttles correctly through the new parameter shape.
**Commit message:** `refactor: extract @degencage/allowances and @degencage/feedback`

**Scope note:** `@degencage/allowances` contains exactly `rolling-allowance.ts` (`loadWindowedTrades`,
`computeRollingAllowance`, `compareUsd`, `sumTradeUsd`, `AssetTier`) and its test — nothing else.
`server/rules/` has no other files. It does not absorb any of `chain`'s own windowing/reconciliation
logic; keeping the boundary this narrow is what keeps `allowances -> {chain,pricing}` at zero edges,
which is exactly why it can build before both.

**File changes:**

| Action | File | What changes |
|---|---|---|
| create | `packages/allowances/package.json`, `tsconfig.json` | mirrors `packages/rules`; **must** include `scripts.typecheck` (a package without it is silently skipped by `pnpm -r typecheck`); dependencies declared from actual `src/**` imports, not assumed |
| move | `apps/web/src/server/rules/rolling-allowance.ts` (+test) -> `packages/allowances/src/rolling-allowance.ts` | unchanged logic; `DatabaseExecutor`/`getDb` now imported from `@degencage/platform/db` |
| create | `packages/allowances/src/index.ts` | re-exports `loadWindowedTrades`, `computeRollingAllowance`, `compareUsd`, `sumTradeUsd`, `AssetTier`, etc. |
| modify | `apps/web/src/server/chain/reconcile-wallet.ts` | `loadWindowedTrades` now imported from `@degencage/allowances` |
| modify | `apps/web/src/server/swap/intent-lifecycle.ts` | same re-source |
| modify | `apps/web/src/server/dashboard/dashboard-state.ts` | same re-source |
| create | `packages/feedback/package.json`, `tsconfig.json` | `exports`: `.` (server, `feedback.ts`), `./constants` (isomorphic); `scripts.typecheck` required; dependencies declared from actual imports |
| move | `apps/web/src/server/feedback/{feedback.ts,constants.ts}` (+test) -> `packages/feedback/src/{feedback,constants}.ts` | `feedback.ts` imports `recordEvent`/`DatabaseExecutor` from `@degencage/platform`, `assertWithinConstitutionActionRateLimit` from `@degencage/platform/rate-limit` |
| modify | `packages/feedback/src/feedback.ts` | `recordFeedbackPrompt(input, session: SessionIdentity)` / `recordFeedback(input, session: SessionIdentity)` replace the internal `requireSession()` ambient call; `SessionIdentity` becomes a parameter type imported from wherever it's now shared (see Steps) |
| modify | `apps/web/src/app/api/feedback/route.ts` | resolves the session itself, passes identity into `recordFeedbackPrompt`/`recordFeedback` |
| modify | `apps/web/src/app/dashboard/feedback-prompt.tsx` | `'use client'` import of `FEEDBACK_TEXT_MAX_LENGTH` repoints to `@degencage/feedback/constants` |
| modify | `apps/web/src/app/dashboard/page.tsx` | `FEEDBACK_CAPTURE_FLAG` import repoints to `@degencage/platform/flags` (moved there in Phase 1/2) — confirm, not a feedback-package concern |
| modify | `vitest.config.ts` | add `packages/allowances` and `packages/feedback` projects (no `@` alias) |
| modify | `apps/web/next.config.ts` | add both to `transpilePackages` |

**Steps:**

- [ ] Scaffold `packages/allowances`; `git mv` `rolling-allowance.ts` (+test); write `index.ts`
- [ ] Update `reconcile-wallet.ts`, `intent-lifecycle.ts`, `dashboard-state.ts` to import from `@degencage/allowances`
- [ ] Scaffold `packages/feedback` with the two-subpath export map; `git mv` `feedback.ts` +
      `constants.ts` (+ their test)
- [ ] Decide where `SessionIdentity` should live for cross-package parameter typing (options:
      re-export it from `@degencage/platform` as a shared identity shape, or keep `feedback`
      importing the type only — `import type` — from `apps/web`'s frozen `auth/session.ts`; a
      type-only import from an app into a package is still "package imports app" and must be
      avoided, so prefer relocating the `SessionIdentity` **type** itself into `@degencage/platform`
      as a shared interface that `auth/session.ts` then imports back, mirroring the
      `DatabaseExecutor` precedent from Phase 2)
- [ ] Change `recordFeedbackPrompt`/`recordFeedback` signatures to take `session` as a parameter;
      remove the internal `requireSession()`/`resolveSession` call
- [ ] Update `app/api/feedback/route.ts` to resolve the session and pass it through
- [ ] Repoint `feedback-prompt.tsx`'s constants import and `dashboard/page.tsx`'s flag import
- [ ] Add both packages to `vitest.config.ts` projects and `next.config.ts` transpilePackages
- [ ] Run all three gates

**Tests:**

| Action | File | What it covers |
|---|---|---|
| move (with source) | `packages/allowances/src/rolling-allowance.test.ts` | unchanged coverage, new location |
| move (with source) | `packages/feedback/src/feedback.test.ts` | updated to pass an explicit `SessionIdentity` fixture instead of mocking `resolveSession` |
| n/a | `test/architecture-guardrails.test.ts` | now also covers `packages/allowances`, `packages/feedback` |

**Verification:**

- [ ] Confirm `packages/{allowances,feedback}/package.json` each define `scripts.typecheck` and both are in `next.config.ts` `transpilePackages` and the `vitest.config.ts` projects list
- [ ] `pnpm -r typecheck` clean
- [ ] `pnpm test` — 672+ tests pass
- [ ] `pnpm --filter @degencage/web build` succeeds
- [ ] Manual: submit feedback via `/api/feedback` locally, confirm it still records against the
      correct session/user and the rate limiter still throttles after repeated calls

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [ ] Tests for this phase written and passing
- [ ] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `refactor: extract @degencage/allowances and @degencage/feedback`
- [ ] Phase marked complete

---

### Phase 5: `@degencage/chain` + `@degencage/pricing`

**Risk:** high
**Mode:** afk
**Type:** backend
**Success criteria:** Helius integration, swap derivation, tier classification, FIFO lot matching,
and `reconcileWallet` are served from `@degencage/chain`; USD valuation + the `token_prices` cache
from `@degencage/pricing`. Both compile as one-directional (`chain -> pricing` only, no cycle
between them). `swap -> dashboard` is gone — `loadReconciliationState` now lives in `chain` as
`wallet-state.ts`, and `quote-service.ts` (still in `apps/web` at this point) imports it from
`@degencage/chain`.
**Review focus:** the `stablecoin-mints.ts` move leaves exactly one directional edge
(`chain -> pricing` via `priceTrade`) — confirm no residual `pricing -> chain` import survived; all
4 import rewrites plus the test mock at `reconcile-wallet.test.ts:47` landed; `chain`/`pricing`
package.json dependencies were audited against actual `src/**` imports, not assumed.
**Commit message:** `refactor: extract @degencage/chain and @degencage/pricing`

**File changes:**

| Action | File | What changes |
|---|---|---|
| create | `packages/chain/package.json`, `tsconfig.json` | exports `.` (single barrel; no consumer currently needs a subpath split); `scripts.typecheck` required; dependencies declared from actual imports (Helius/Solana web3 libs, drizzle-orm via platform is NOT re-declared — platform's own deps stay platform's) |
| create | `packages/pricing/package.json`, `tsconfig.json` | same, plus `scripts.typecheck` required and its own dependencies declared |
| move | `apps/web/src/server/pricing/stablecoin-mints.ts` -> `packages/pricing/src/stablecoin-mints.ts` | **the confirmed cycle cut.** 15 lines: one frozen `ReadonlySet` of 2 mint addresses + `isStablecoin(mint)`, zero imports, zero I/O. Do this move first, before either package.json is finalized |
| move | `apps/web/src/server/chain/**` (`classify-token.ts`, `lot-matching.ts`, `reconcile-wallet.ts`, `helius-client.ts`, `helius-simulate.ts`, `jupiter-tokens.ts`, `broadcast-transaction.ts`, + tests — **not** `stablecoin-mints.ts`, moved above) -> `packages/chain/src/**` | imports repointed to `@degencage/platform`, `@degencage/allowances`, `@degencage/rules`, `@degencage/pricing` as needed; `classify-token.ts:5` and `reconcile-wallet.ts:29`'s `isStablecoin` imports now come from `@degencage/pricing` |
| create | `packages/chain/src/wallet-state.ts` | `loadReconciliationState`, moved out of (still-in-apps/web) `dashboard/dashboard-state.ts` |
| move | `apps/web/src/server/pricing/**` (`binance-klines.ts`, `birdeye-price.ts`, `price-trade.ts`, + tests, plus `stablecoin-mints.ts` moved above) -> `packages/pricing/src/**` | `price-trade.ts:3`'s `isStablecoin` import becomes a same-package relative import to `./stablecoin-mints`; `priceTrade` still imported by `chain/reconcile-wallet.ts:30` from `@degencage/pricing` (one direction only) |
| modify | `apps/web/src/server/swap/quote-service.ts` | `loadReconciliationState` now imported from `@degencage/chain`, not `../dashboard/dashboard-state`; `LOSS_LIMIT_ENABLED_FLAG` etc. already repointed in Phase 1 |
| modify | `apps/web/src/server/swap/{quote-service,submit-service,assemble-transaction}.ts` | `classifyToken`, `lookupTokenDecimals`, `broadcastSignedTransaction`, `getMultipleAccounts`, `simulateTransaction` now imported from `@degencage/chain` |
| modify | `apps/web/src/server/dashboard/dashboard-state.ts` | `loadReconciliationState` deleted from here |
| modify | `apps/web/src/app/api/wallet/reconcile/route.ts`, `apps/web/src/app/dashboard/page.tsx`, `apps/web/src/app/api/swap/intent/[id]/route.ts` | `reconcileWallet`/`SessionIdentity` imports repointed to `@degencage/chain` where `reconcileWallet` now lives |
| modify | `apps/web/src/server/db/seed.ts` (now in platform) | flag constants already sourced from platform's own registry — no change expected here, confirm |
| modify | `vitest.config.ts` | add `packages/chain`, `packages/pricing` projects |
| modify | `apps/web/next.config.ts` | add both to `transpilePackages` |

**Steps:**

- [ ] `git mv apps/web/src/server/chain/stablecoin-mints.ts` into the pricing tree first (its final
      home is `packages/pricing/src/stablecoin-mints.ts`) — this is the cycle cut, do it before
      scaffolding either package.json so neither is written with the wrong dependency direction
- [ ] Repoint `chain/classify-token.ts:5` and `chain/reconcile-wallet.ts:29`'s `isStablecoin` imports
      to the new pricing location; repoint `chain/reconcile-wallet.test.ts:15`'s `STABLECOIN_MINTS`
      import and the `priceTrade` mock at `:47`
- [ ] Scaffold both packages
- [ ] `git mv` the rest of `server/chain/**` into `packages/chain/src/**`; the rest of
      `server/pricing/**` into `packages/pricing/src/**`
- [ ] Move `loadReconciliationState` out of `dashboard/dashboard-state.ts` into
      `packages/chain/src/wallet-state.ts`
- [ ] Sweep `apps/web/src/server/swap/**` and the three app-layer `reconcileWallet` callers to import
      from `@degencage/chain`/`@degencage/pricing`, driven by `pnpm -r typecheck` failures
- [ ] Add both packages to `vitest.config.ts` and `next.config.ts`
- [ ] Confirm via `test/architecture-guardrails.test.ts` (or a manual `grep -r "from '.*chain" packages/pricing/src` / `grep -r "from '.*pricing" packages/chain/src`) that exactly one directional edge remains
- [ ] Run all three gates

**Tests:**

| Action | File | What it covers |
|---|---|---|
| move (with source) | every `packages/chain/src/*.test.ts`, `packages/pricing/src/*.test.ts` | unchanged coverage, new location and import paths |
| n/a | `test/architecture-guardrails.test.ts` | now also covers `packages/chain`, `packages/pricing`; will fail if the chain<->pricing cycle wasn't actually resolved to one direction |

**Verification:**

- [ ] Confirm `packages/{chain,pricing}/package.json` each define `scripts.typecheck` and both are in `next.config.ts` `transpilePackages` and the `vitest.config.ts` projects list; confirm each package.json only declares deps it actually imports (audit against `src/**`)
- [ ] `pnpm -r typecheck` clean
- [ ] `pnpm test` — 672+ tests pass
- [ ] `pnpm --filter @degencage/web build` succeeds
- [ ] Manual: request a swap quote end-to-end locally (`/trade`), confirm classification, pricing,
      and the loss-limit gate all still evaluate identically
- [ ] Manual: trigger `/api/wallet/reconcile`, confirm reconciliation state still updates correctly

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [ ] Tests for this phase written and passing
- [ ] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `refactor: extract @degencage/chain and @degencage/pricing`
- [ ] Phase marked complete

---

### Phase 6: `@degencage/constitution` + `@degencage/swap`

**Risk:** high
**Mode:** afk
**Type:** backend
**Success criteria:** Draft -> commit -> activate, pending changes, and timelocks are served from
`@degencage/constitution`, with the same session-as-parameter fix applied to
`commitment.ts`/`pending-changes.ts` as `chain` got in Phase 1. The pre-trade gate (build -> price ->
evaluate -> compile -> verify -> broadcast) is served from `@degencage/swap`, with zero remaining
`swap -> dashboard` edge (already cut in Phase 5). **The atomic SIWS sign-in transaction in frozen
`auth/solana-siws.ts` (session supersede + establish inside one `getDb().transaction`) is completely
unaffected — verify explicitly, this is the single highest-value regression to check in this phase.**
**Review focus:** `solana-siws.test.ts`/`session.test.ts` run and pass **unmodified** (a diff
touching either file in this phase is a red flag, since `auth` is frozen); all 5 constitution
functions' callers (3 route handlers, 3 RSC pages, 2 inline Server Actions) resolve session at the
correct point before calling in — cross-check against the exact call sites enumerated in the
research (`cycles-and-di.md` §B, Group 2); confirm the `swap -> dashboard` edge is actually gone
(grep for a residual `dashboard` import in `packages/swap/src`), not just unused.
**Commit message:** `refactor: extract @degencage/constitution and @degencage/swap`

**File changes:**

| Action | File | What changes |
|---|---|---|
| create | `packages/constitution/package.json`, `tsconfig.json` | `scripts.typecheck` required; dependencies declared from actual imports |
| move | `apps/web/src/server/constitution/{commitment.ts,pending-changes.ts}` (+tests) -> `packages/constitution/src/**` | `rate-limit.ts` already moved to platform in Phase 2 — nothing left to move for it here |
| modify | `packages/constitution/src/commitment.ts` | `saveDraftConstitution`, `startCommitment`, `activateConstitution`, `loadCurrentConstitution` take `session: SessionIdentity` as a parameter; internal `requireSession()`/`resolveSession` calls removed |
| modify | `packages/constitution/src/pending-changes.ts` | `requestLimitChange`, `cancelPendingChange`, `loadPendingChangesForCurrentUser` take `session: SessionIdentity` as a parameter; same removal |
| modify | `apps/web/src/app/api/constitution/route.ts`, `.../commit/route.ts`, `.../activate/route.ts` | resolve session, pass identity into the constitution functions |
| modify | `apps/web/src/app/constitution/page.tsx`, `apps/web/src/app/constitution/edit/page.tsx` | same, including the two inline Server Actions (`requestLimitChangeAction`, `cancelPendingChangeAction`) |
| create | `packages/swap/package.json`, `tsconfig.json` | `scripts.typecheck` required; dependencies declared from actual imports |
| move | `apps/web/src/server/swap/**` (`quote-service.ts`, `submit-service.ts`, `assemble-transaction.ts`, `intent-lifecycle.ts`, `jupiter-client.ts`, + tests) -> `packages/swap/src/**` | imports repointed to `@degencage/platform`, `@degencage/chain`, `@degencage/pricing`, `@degencage/allowances` |
| modify | `apps/web/src/app/api/swap/{quote,submit,intent/[id]}/route.ts` | import repoint to `@degencage/swap` |
| modify | `vitest.config.ts` | add `packages/constitution`, `packages/swap` projects |
| modify | `apps/web/next.config.ts` | add both to `transpilePackages` |

**Steps:**

- [ ] Scaffold `packages/constitution`; `git mv` `commitment.ts` + `pending-changes.ts` (+tests)
- [ ] Apply the session-as-parameter fix to all 5 exported functions across the two files (same
      pattern as Phase 1's `reconcileWallet`)
- [ ] Update the 3 route handlers + 3 RSC pages + 2 inline Server Actions to resolve the session and
      pass it through — every one of these callers already sits exactly one level above the ambient
      call (confirmed in research), so no deep threading is required
- [ ] Scaffold `packages/swap`; `git mv` all of `server/swap/**`
- [ ] Sweep remaining imports (driven by `pnpm -r typecheck`)
- [ ] Add both packages to `vitest.config.ts`/`next.config.ts`
- [ ] Run all three gates, with special attention to `auth/solana-siws.test.ts` and
      `auth/session.test.ts` (untouched by this phase, but assert they still pass unmodified —
      confirms the SIWS atomic transaction wasn't disturbed)

**Tests:**

| Action | File | What it covers |
|---|---|---|
| move (with source) | `packages/constitution/src/commitment.test.ts`, `pending-changes.test.ts` | updated to pass explicit `SessionIdentity` fixtures |
| move (with source) | every `packages/swap/src/*.test.ts` | unchanged coverage, new location |
| n/a | `apps/web/src/server/auth/solana-siws.test.ts` | run as-is (not moved, not modified) — regression guard for the atomic sign-in transaction |
| n/a | `test/architecture-guardrails.test.ts` | now also covers `packages/constitution`, `packages/swap` |

**Verification:**

- [ ] Confirm `packages/{constitution,swap}/package.json` each define `scripts.typecheck` and both are in `next.config.ts` `transpilePackages` and the `vitest.config.ts` projects list
- [ ] `pnpm -r typecheck` clean
- [ ] `pnpm test` — 672+ tests pass, including `solana-siws.test.ts` unchanged
- [ ] `pnpm --filter @degencage/web build` succeeds
- [ ] Manual: full constitution draft -> commit -> activate flow locally; a pending limit-increase
      request still shows its 48h timelock; a decrease still applies immediately
- [ ] Manual: full swap quote -> submit flow locally against a devnet/test wallet

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [ ] Tests for this phase written and passing
- [ ] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `refactor: extract @degencage/constitution and @degencage/swap`
- [ ] Phase marked complete

---

### Phase 7: `@degencage/dashboard` + `@degencage/metrics`

**Risk:** medium
**Mode:** afk
**Type:** backend
**Success criteria:** The user-facing read model (`buildDashboardState`, violations feed, and the
`loadRecentTrades`/`TradeRowView` logic pulled out of `app/dashboard/page.tsx`'s inline query) is
served from `@degencage/dashboard`. The operator-facing read model (`buildMetricsSnapshot` + Phase 0
signal functions) is served from `@degencage/metrics`, importing `@degencage/feedback` for
`listRecentFeedback`. `apps/web/src/server/db` no longer has any direct app-layer consumer —
`app/dashboard/page.tsx` now calls a real exported function instead of an inline 21-line query.
**Review focus:** `loadRecentTrades` has real new test coverage (`recent-trades.test.ts`) — it was
previously untested inline in a page component, and extracting it must not leave it untested;
`app/dashboard/page.tsx` has zero remaining direct `getDb`/`schema` imports (thin-entry-point check);
`metrics` only reads from `feedback` and `platform`, never writes, matching its admin-gated
read-model role.
**Commit message:** `refactor: extract @degencage/dashboard and @degencage/metrics`

**File changes:**

| Action | File | What changes |
|---|---|---|
| create | `packages/dashboard/package.json`, `tsconfig.json` | `scripts.typecheck` required; dependencies declared from actual imports |
| move | `apps/web/src/server/dashboard/{dashboard-state.ts,violations-feed.ts}` (+tests) -> `packages/dashboard/src/**` | imports repointed to `@degencage/platform`, `@degencage/allowances` |
| create | `packages/dashboard/src/recent-trades.ts` | `loadRecentTrades()` + `TradeRowView` interface + `TRADE_LIST_LIMIT`, extracted verbatim from `app/dashboard/page.tsx`'s inline 21-line query |
| modify | `apps/web/src/app/dashboard/page.tsx` | inline query replaced by `loadRecentTrades()` call from `@degencage/dashboard`; `getDb`/`schema` direct imports removed; `TokenClassificationQuality` import repoints to `@degencage/platform/db` (was already repointed in Phase 2 if not done yet, confirm here) |
| modify | `apps/web/src/app/api/dashboard/route.ts`, `apps/web/src/app/dashboard/dashboard-panel.tsx` | import repoint to `@degencage/dashboard` |
| create | `packages/metrics/package.json`, `tsconfig.json` | `scripts.typecheck` required; dependencies declared from actual imports |
| move | `apps/web/src/server/metrics/queries.ts` (+test) -> `packages/metrics/src/queries.ts` | imports `@degencage/platform`, `@degencage/feedback` |
| modify | `apps/web/src/app/admin/metrics/page.tsx`, `apps/web/src/app/api/admin/metrics/route.ts` | import repoint to `@degencage/metrics` |
| modify | `vitest.config.ts` | add `packages/dashboard`, `packages/metrics` projects |
| modify | `apps/web/next.config.ts` | add both to `transpilePackages` |

**Steps:**

- [ ] Scaffold `packages/dashboard`; `git mv` `dashboard-state.ts` + `violations-feed.ts` (+tests)
- [ ] Extract `loadRecentTrades`/`TradeRowView`/`TRADE_LIST_LIMIT` out of `app/dashboard/page.tsx`
      into `packages/dashboard/src/recent-trades.ts`; update the page to call it and drop its direct
      `getDb`/`schema` imports (satisfies CLAUDE.md's "keep entry points thin")
- [ ] Scaffold `packages/metrics`; `git mv` `metrics/queries.ts` (+test)
- [ ] Sweep remaining app-layer imports (driven by `pnpm -r typecheck`)
- [ ] Add both packages to `vitest.config.ts`/`next.config.ts`
- [ ] Run all three gates

**Tests:**

| Action | File | What it covers |
|---|---|---|
| move (with source) | `packages/dashboard/src/{dashboard-state,violations-feed}.test.ts` | unchanged coverage, new location |
| create | `packages/dashboard/src/recent-trades.test.ts` | new coverage for the extracted `loadRecentTrades()` — this logic had **zero** test coverage while inline in a page component; extracting it must not leave it untested |
| move (with source) | `packages/metrics/src/queries.test.ts` | unchanged coverage, new location |
| n/a | `test/architecture-guardrails.test.ts` | now also covers `packages/dashboard`, `packages/metrics` — the full 10-package set |

**Verification:**

- [ ] Confirm `packages/{dashboard,metrics}/package.json` each define `scripts.typecheck` and both are in `next.config.ts` `transpilePackages` and the `vitest.config.ts` projects list
- [ ] `pnpm -r typecheck` clean
- [ ] `pnpm test` — 672+ tests pass, plus the new `recent-trades.test.ts`
- [ ] `pnpm --filter @degencage/web build` succeeds
- [ ] Manual: load `/dashboard` locally, confirm the recent-trades list, allowances, and violations
      feed all render identically to before
- [ ] Manual: load `/admin/metrics` (with the admin secret), confirm the metrics snapshot is unchanged

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [ ] Tests for this phase written and passing
- [ ] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `refactor: extract @degencage/dashboard and @degencage/metrics`
- [ ] Phase marked complete

---

### Phase 8: `.ai/` sync

**Risk:** low
**Mode:** afk
**Type:** docs
**Success criteria:** `.ai/index.md` and `.ai/architecture.md` describe the actual post-refactor
package graph (10 packages + frozen `apps/web/src/server/{auth,admin}`), the stale "rate limiter has
three consumers" row is corrected to four (with its new location noted), and every ad-hoc decision
made *during* this refactor (chain<->pricing cut, the feedback/constitution session generalization,
the deferred central-config idea) is recorded in `.ai/decisions/`.
**Review focus:** every claim in `.ai/index.md`/`.ai/architecture.md` matches the actual code (spot
Read a few files, don't trust prose); the rate-limiter row says 4 consumers, not 3; no decision file
still claims "not split further yet."
**Commit message:** `docs(ai): sync knowledge base with the 10-package server extraction`

**Steps:**

- [ ] Invoke the `sync-knowledge` skill (or follow its rules directly) to update `.ai/index.md`'s
      module table: replace the `server/**` single-app rows with one row per new package plus the
      two remaining frozen `apps/web/src/server/{auth,admin}` rows
- [ ] Correct `.ai/index.md`'s "Authenticated write surfaces" rate-limiter row: 4 consumers
      (`constitution/commitment.ts`, `constitution/pending-changes.ts`, `feedback/feedback.ts`,
      `app/api/swap/intent/[id]/route.ts`), now served from `@degencage/platform/rate-limit`
- [ ] Update `.ai/architecture.md`'s data-flow description to reflect the package boundaries and the
      cut edges (`chain` no longer calls `auth`; `constitution`/`feedback` take session as a
      parameter; `swap` no longer touches `dashboard`)
- [ ] Update `.ai/decisions/monorepo-package-shape.md` from "not split further yet" to the actual
      10-package outcome, with the rationale from this plan's `Context` section
- [ ] Create `.ai/decisions/<slug>.md` recording the `chain <-> pricing` cut actually applied in
      Phase 5 (what was found, what was chosen, why)
- [ ] Create `.ai/decisions/<slug>.md` recording the session-as-parameter pattern as the standing
      convention for any future package that needs an identity from frozen `auth` (chain,
      constitution, feedback all now use it)
- [ ] Record the deferred central-config idea (decision #12 from this plan's brief — env vars stay
      read as lazy function-body defaults, no central config object) in
      `.ai/decisions/<slug>.md` as an explicitly-deferred decision, not a silent omission

**Tests:**

No automated tests — justified because this phase is pure documentation with no executable behavior;
`sync-knowledge`'s own review step is the applicable check, not a test suite.

**Verification:**

- [ ] `.ai/index.md` module table matches `git ls-tree` reality (spot-check 3 rows)
- [ ] No `.ai/decisions/*.md` file still claims "not split further" or "three rate-limiter consumers"

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `docs(ai): sync knowledge base with the 10-package server extraction`
- [ ] Phase marked complete

---

### Phase 9: Final Verification

**Mode:** hil

**Overall success criteria:**

- Every one of `apps/web/src/server/**`'s original 13 directories has either become one of the 9 new
  packages or (for `auth`/`admin`) stayed frozen in `apps/web`, unmodified in behavior
- 10 packages total, `@degencage/rules` untouched, `no circular dependencies` (CLAUDE.md) holds —
  verified by `test/architecture-guardrails.test.ts` and a manual dependency-graph read
- All 672+ pre-existing tests plus every test added in Phases 1–7 pass; test count has only grown
- `pnpm -r typecheck` is clean across all packages and `apps/web`
- `next build` succeeds with `output: 'standalone'` unchanged
- Every kill switch is still seeded `false`; no flag key string changed; Phase 6 of the swap plan
  (live broadcast) is still gated exactly as before
- `.ai/` fully reflects the new package graph

**Steps:**

- [ ] Every preceding phase's Steps/Verification/Phase review checkboxes are ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block (scoped to end-to-end review)
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent reviews the entire change end-to-end
- [ ] Any changes made in response to the final code-reviewer review have been reflected back into this plan file
- [ ] All tests pass
- [ ] No CLAUDE.md invariants violated (modular by packages, no circular deps, deliberate public
      APIs, entry points thin, observability intact, kill switches/fail-closed unchanged)
- [ ] Feature tested manually end-to-end: connect wallet -> view dashboard -> request a swap quote ->
      submit (or observe the block, per current flag state) -> author a constitution change -> submit
      feedback -> load admin metrics
- [ ] Overall success criteria met
- [ ] All phase checkboxes above are ticked

## Documentation

This repo has no per-package README convention (`packages/rules` has none) — `.ai/` is the
authoritative documentation surface per CLAUDE.md's Project Knowledge Base section. All documentation
work is therefore concentrated in Phase 8 rather than spread across per-package READMEs.

| Change | Documentation location |
|---|---|
| New 10-package module map | `.ai/index.md` |
| Corrected rate-limiter consumer count | `.ai/index.md` |
| Package boundary / data-flow description | `.ai/architecture.md` |
| 10-package split rationale | `.ai/decisions/monorepo-package-shape.md` |
| `chain <-> pricing` cut | new `.ai/decisions/<slug>.md` |
| Session-as-parameter convention | new `.ai/decisions/<slug>.md` |
| Deferred central-config decision | new `.ai/decisions/<slug>.md` |

## Knowledge Base Impact

| `.ai/` artifact | Action | What it captures |
|---|---|---|
| `index.md` | update | New package rows replacing the `server/**` module rows; corrected rate-limiter row |
| `architecture.md` | update | Package graph, cut edges, frozen `auth`/`admin` note |
| `decisions/monorepo-package-shape.md` | update | Supersede "not split further yet" with the actual 10-package outcome and why |
| `decisions/<chain-pricing-cut>.md` | create | The `chain <-> pricing` edge found during planning and how it was resolved |
| `decisions/<session-as-parameter>.md` | create | The pattern used to sever every package's dependency on frozen `auth`, and where it applies |
| `decisions/<deferred-central-config>.md` | create | Explicit record that env-reading stays as lazy per-call defaults, no central config object, and why |
| `decisions/server-side-rule-evaluation.md` | update (light) | Note the `server/rules` -> `@degencage/allowances` rename, no logic change |

## Tests

| Phase | Logic under test | Test file |
|---|---|---|
| Phase 1 | `reconcileWallet` takes an explicit session | `apps/web/src/server/chain/reconcile-wallet.test.ts` |
| Phase 1 | recursive package purity | `packages/rules/src/index.test.ts` |
| Phase 1 | no package escapes its boundary; no undeclared bare import | `test/architecture-guardrails.test.ts` |
| Phase 2 | (moved, unchanged) db/observability/flags/rate-limit behavior | `packages/platform/src/**/*.test.ts` |
| Phase 3 | — | none (verified via `drizzle-kit generate` + `git diff`, see phase) |
| Phase 4 | rolling allowance / windowed trades (moved, unchanged) | `packages/allowances/src/rolling-allowance.test.ts` |
| Phase 4 | feedback takes an explicit session | `packages/feedback/src/feedback.test.ts` |
| Phase 5 | chain/pricing modules (moved, unchanged) | `packages/chain/src/*.test.ts`, `packages/pricing/src/*.test.ts` |
| Phase 6 | constitution takes an explicit session | `packages/constitution/src/{commitment,pending-changes}.test.ts` |
| Phase 6 | swap modules (moved, unchanged) | `packages/swap/src/*.test.ts` |
| Phase 6 | SIWS atomic transaction unaffected | `apps/web/src/server/auth/solana-siws.test.ts` (run, not modified) |
| Phase 7 | dashboard/violations (moved, unchanged) | `packages/dashboard/src/{dashboard-state,violations-feed}.test.ts` |
| Phase 7 | newly-extracted `loadRecentTrades` | `packages/dashboard/src/recent-trades.test.ts` (new coverage — was untested inline) |
| Phase 7 | metrics (moved, unchanged) | `packages/metrics/src/queries.test.ts` |
| Phase 8 | — | none (docs only) |

## Human Summary

We're pulling the backend out of the Next.js app and into proper pnpm packages, matching what
CLAUDE.md already asks for ("modular by packages, no circular dependencies") — today it's all one
app, held together by relative imports, with a few real circular dependencies hiding under the
surface that would break the moment we tried to split it. Nothing about how the app *behaves*
changes: same routes, same flags, same DB rows, same 672+ tests.

The work happens in a fixed order because some pieces genuinely depend on others: first we cut the
one real cycle (`chain` calling into `auth`) and centralize all the feature-flag name constants in
one place, without creating any packages yet. Then we build a `platform` package holding the
database client, structured logging/events, flags, and the shared rate limiter — everything else
will depend on this. Database migrations get their own dedicated, careful move right after, since
they touch the live database and nothing else should be mixed into that commit. From there we pull
out the rest of the domain in dependency order — allowances and feedback first (they don't need
anything new), then chain and pricing, then constitution and swap, then the two read-models
(dashboard, metrics) last, since they depend on everything else.

Two things came up during planning that weren't in the original decision list: a second hidden cycle
between `chain` and `pricing` that needs a one-line-import fix before those two packages can be
created, and the fact that `feedback` and `constitution` have the exact same "quietly calls into
frozen `auth`" problem `chain` had — so they get the same one-parameter fix, just in their own
phases instead of upfront. `auth` and `admin` themselves are staying exactly where they are, frozen,
because a real auth library is replacing them later and there's no point building packages around
code we're about to throw away.

Every phase ends the same way: all tests still green, both typecheck and the production build clean,
and a manual click-through of whatever surface that phase touched. The last phase is a full
end-to-end pass plus bringing `.ai/`'s documentation back in sync with what actually shipped.
