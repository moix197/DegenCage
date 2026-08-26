# Plan: Phase 0 — Commitment Mechanism

**Created:** 2026-08-26
**Branch:** `phase-0/commitment-mechanism`
**Status:** not started

## Context

DegenCage's Phase 0 bet is narrow: will a trader who connects a Solana wallet, writes down rules for themselves ("a trading constitution"), sits through a 20-minute commitment period, and activates — actually keep those rules when nothing technical stops them from breaking them? Phase 0 does not execute trades, does not touch Jupiter, does not build a smart-contract timelock. It watches the wallet's real on-chain activity after activation and surfaces external violations as pure accountability ("we saw that") — no blocking, no punishment.

This is a greenfield repository — **not yet even a git repository** (`git status` fails; there is no `.git` directory). `.ai/architecture.md` records an agreed target shape (`apps/web` + `packages/rules`, `packages/db` deferred) but no code and no version control exist yet. This plan is the first thing that lands, so Phase 0 now covers initializing git itself, not just creating a worktree from an existing history.

Two things this plan must get right because they are expensive to redo once real users have saved data:

1. **The constitution schema** — `packages/rules`' public API. It must let Phase 2+ add new limit types without a migration, and must version cleanly.
2. **The measurement instrumentation** — Phase 0's actual deliverable is behavioral data proving (or disproving) the roadmap's named killer signal. Every roadmap signal is mapped below to a concrete event type and a concrete query; where a signal is genuinely qualitative, that is stated plainly rather than forced into a fake metric.

This plan resolves 19 pre-settled product/architecture decisions handed down from prior research (wallet auth, chain data) and the `.ai/decisions/` knowledge base. Those decisions are treated as final and are not re-litigated here — see the "Decisions this plan is built on" reference table below.

### Decisions this plan is built on (not re-litigated)

| # | Decision |
|---|---|
| 1 | Loss = realized loss on round-trips opened AND closed after activation. Partial coverage; UI must say so. |
| 2 | `users` + `wallets` (FK), one wallet per user in Phase 0, `wallets.custody ∈ {external, embedded}` from day 1. |
| 3 | Trades = DEX swaps only, from net token balance deltas. Self-transfers and pure receives excluded; selling a received airdrop counts. |
| 4 | Rolling 24h window, not calendar day. Creeping "remaining" UI is a real design item. |
| 5 | One tx = one trade, valued net in→out. Routing hops don't count separately. |
| 6 | Per-asset limits consume the BUY side only. Selling never consumes allowance. Daily total-notional limit is separate and catches churn. |
| 7 | Unclassifiable token → treated as MEMECOIN, stamped `classification: 'unknown'`. |
| 8 | SOL↔LST swaps excluded entirely (curated allowlist), but recorded with `excluded_reason`. |
| 9 | 90-day backfill on connect = private behavioral baseline. Never surfaced as violations. |
| 10 | `@solana/kit` + `@solana/react` + `@solana/kit-plugin-wallet` (Wallet Standard, single-prompt SIWS), behind our own thin wrapper. No `wallet-adapter`. |
| 11 | Open connect, no allowlist/invite/email in Phase 0. |
| 12 | Constitution edits: decrease = immediate, increase = 48h delayed. Minimal mechanism (a pending-change row), not the Phase 3 state machine. |
| 13 | Success bar is qualitative-led (the "I know I can bypass this, but I don't want to" signal) + a week-2 return floor, backed by full instrumentation. |
| 14 | Desktop-only. |
| 15 | Opaque session id in httpOnly cookie + revocable `sessions` row in Postgres. Not a JWT. 30-day sliding expiry. |
| 16 | SIWS signature verification via `@solana/wallet-standard-util` is signature-only — replay/expiry/domain-binding are ours to build. |
| 17 | Violations are never retracted — corrections are new events. Append-only. |
| 18 | Helius `getTransactionsForAddress`, cursored on finalized slot ascending, `reconciled_through` per wallet. |
| 19 | USD pricing: price only the SOL/stablecoin leg. Binance klines for majors (shared cache), Birdeye for long-tail. Exact decimal math, `source` column on priced rows. |

## Risk: high

Touches money-adjacent math (loss/allowance computation), a security-critical auth flow (SIWS replay/expiry/domain binding is entirely our own responsibility), and an external data dependency (Helius free tier) whose availability is assumed but not yet verified against a live key.

## Dependencies & Risks

- **This is not yet a git repository.** Every later phase's "one commit per phase" and branch assumptions depend on Phase 0 initializing git first — see Phase 0 below. No other phase assumes git exists before Phase 0 completes.
- **Helius free-tier assumption is unverified.** Decision 18 rests on `getTransactionsForAddress` being available on the free plan. Phase 4 opens with a live smoke-test call before any pipeline code is written — if it fails, the reconciliation design needs rework, so this must be confirmed early and cheaply, before Phases 5 and 6 build on top of it.
- **`@solana/kit-plugin-wallet` is pre-1.0 (0.18.0)** against `@solana/kit` 8.0.0. All contact with it is isolated to one wrapper module (`apps/web/src/client/wallet/`, `apps/web/src/server/auth/solana-siws.ts`) so a breaking release only requires touching those files.
- **SIWS verification gap**: `verifySignIn()` does signature + exact-field matching only. Nonce replay, expiry, and domain binding are unimplemented by the library and are the highest-severity item in this plan — a mistake here lets someone impersonate a wallet without ever holding its key. Phase 2's tests specifically assert a *replayed* (already-consumed) valid signature is rejected, not just a malformed one — see Phase 2 Tests.
- **Swap-derivation heuristic has known imprecision** (documented in research, not solved): multi-leg txs collapse correctly by design (decision 5), but wrap/unwrap SOL↔wSOL and ATA rent-exempt lamport noise must be explicitly thresholded or they will misfire as spurious trades.
- **No migration tool, test framework, or DB host is decided yet in `.ai/`** — this plan picks Drizzle + drizzle-kit, Vitest, and Neon, and records that choice back to the knowledge base (see Knowledge Base Impact). This is a new decision, not a rediscovery of an existing one.
- **Money math**: all USD/allowance arithmetic uses exact decimal representations (Postgres `NUMERIC`, string/BigInt-based types in TypeScript) — never native floats, enforced end to end through ingestion (Phase 4), pricing (Phase 4/5), and FIFO lot-matching (Phase 6, the most arithmetic-heavy piece in the plan).
- **Order-sensitive**: Phase 0 (git init) before everything. Phase 1 (scaffold) before any feature phase. Phase 2 (wallet) and Phase 3 (constitution) before Phase 4 (evaluation needs an active constitution and a session-bound wallet to exist). Phase 4 → 5 → 6 is a strict dependency chain: each adds one limit type's authoring UI, evaluator case, and ledger columns on top of the previous phase's shared modules (`evaluate.ts`, `reconcile-wallet.ts`, `rolling-allowance.ts`, the constitution-status page) — never duplicated. Phase 8 (edit asymmetry) depends on Phase 3's constitution row and stable limit `id`s. Phase 9 (metrics) depends on every event type from Phases 2–8 already being emitted.
- **Every external-provider integration point (Helius, Binance, Birdeye, Jupiter Tokens API) ships its own feature flag and fails closed** — this is called out per-phase below (Phase 4 for Helius/Binance, Phase 5 for Birdeye/Jupiter tags), not just in the Phase 1 scaffold.

## Phases

### Phase 0: Create worktree

Repository initialization is **already done** — `git init` ran on 2026-08-26, `main` exists,
a root `.gitignore` is in place (it ignores `.claude/`), and the initial commit carries
`CLAUDE.md`, `.ai/`, `plans/`, and `roadmap__small.pdf`. This phase is now only the
worktree step.

**Steps:**

- [ ] Verify the repo is on `main` with a clean tree and at least one commit (`git log --oneline -1`)
- [ ] Confirm branch name `phase-0/commitment-mechanism` with the user
- [ ] Run `git worktree add ../degencage-phase-0-commitment-mechanism -b phase-0/commitment-mechanism main`
- [ ] Verify worktree is active and on the correct branch (`git worktree list`)
- [ ] Confirm the plan and `.ai/` are present inside the worktree — later phases read them from there

---

### Phase 1: Scaffold monorepo, DB, and observability spine

**Risk:** medium
**Mode:** afk
**Type:** config
**Success criteria:** Running `pnpm install && pnpm dev` serves `/` on `apps/web`, which performs a live pooled-Postgres round trip (reads a seeded `feature_flags` row) and renders "DB: connected, flags loaded: N". `pnpm test` runs and passes across `packages/rules` (one placeholder pure function + test) and `apps/web` (logger wrapper test). A drizzle-kit migration has been generated and applied creating the `feature_flags` table.
**Commit message:** `chore: scaffold pnpm monorepo, Postgres, and observability spine`

This is the plan's one allowed infra-only phase (per format spec exception: "pure infrastructure prerequisites with zero user-facing surface"). It is justified because every later phase needs a working DB connection, a logger, and a feature-flag check to ship "kill switches with the feature" as CLAUDE.md requires — building that once here avoids repeating it in every phase. It is kept as thin as possible: no `users`/`wallets`/`sessions` tables yet (those are Phase 2's vertical slice), and the DB round-trip it demonstrates is a real, QA-visible outcome, not just "files exist." (`.gitignore` already exists from Phase 0 — this phase does not recreate it.)

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `pnpm-workspace.yaml`, root `package.json`, `tsconfig.base.json` | pnpm workspace with `apps/*`, `packages/*`; shared strict TS config |
| create | `apps/web/` (Next.js App Router skeleton) | `next.config.ts` with `output: 'standalone'`; Node runtime default; `src/app/page.tsx` renders DB/flag status |
| create | `apps/web/src/server/db/client.ts` | Neon serverless driver, pooled connection, env-var config only (no `@vercel/postgres`) |
| create | `apps/web/src/server/db/schema.ts` | drizzle schema: `feature_flags` table only (`key text pk`, `enabled boolean`, `scope jsonb`, `updated_at`) |
| create | `apps/web/drizzle.config.ts` + generated migration under `apps/web/src/server/db/migrations/` | drizzle-kit config + initial migration |
| create | `apps/web/src/server/flags/feature-flags.ts` | `isFeatureEnabled(key, ctx?: { userId?: string })` reading `feature_flags`, fail-closed default (unknown key → disabled) |
| create | `apps/web/src/observability/logger.ts` | pino JSON-to-stdout wrapper; every call site imports this, never `pino` directly |
| create | `apps/web/src/observability/error-tracking.ts` | thin wrapper around `@sentry/nextjs` `captureException`; call sites never import `@sentry/nextjs` directly |
| create | `packages/rules/package.json`, `packages/rules/src/index.ts` | empty package, one placeholder pure export, zero deps on `next/*`/DB/fetch |
| create | `vitest.config.ts` (root, shared) | test runner wired for both `apps/web` and `packages/rules` |
| create | `.env.example` | `DATABASE_URL`, `SENTRY_DSN`, placeholders for later env vars (documented as they're introduced in later phases) |

**Steps:**

- [x] Init pnpm workspace, root configs, shared `tsconfig.base.json` (strict mode on)
- [x] Scaffold `apps/web` with Next.js App Router, set `output: 'standalone'`, confirm route handlers default to Node runtime
- [x] Provision a Neon Postgres project (or confirm the user already has one), wire `DATABASE_URL` through `apps/web/src/server/db/client.ts` using Neon's serverless driver (pooled, not direct connection)
- [x] Choose and install Drizzle ORM + drizzle-kit; write the `feature_flags` schema; generate and apply the first migration
- [x] Implement `isFeatureEnabled()` fail-closed helper; seed one `feature_flags` row via a seed script for the home page to read
- [x] Implement the pino logger wrapper and the Sentry error-tracking wrapper as the only two observability entry points
- [x] Scaffold `packages/rules` with one placeholder pure function (e.g. `identityDecision()`) and a passing test, proving the package has zero DB/fetch/`next/*` imports
- [x] Wire root `pnpm test` to run Vitest across both workspaces
- [x] Home page (`apps/web/src/app/page.tsx`) reads the seeded flag through the DB client and renders connection + flag status
- [x] Add `.env.example` documenting `DATABASE_URL` and `SENTRY_DSN`

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/rules/src/index.test.ts` | placeholder pure function returns expected output with no I/O |
| create | `apps/web/src/observability/logger.test.ts` | logger wrapper emits structured JSON with expected fields, doesn't throw on circular-safe input |
| create | `apps/web/src/server/flags/feature-flags.test.ts` | `isFeatureEnabled` fails closed for unknown keys; respects seeded row |

**Verification:**

- [x] `pnpm test` passes for both workspaces
- [x] `pnpm dev` → `/` shows "DB: connected" and the seeded flag value
- [x] `pnpm build` succeeds with `output: 'standalone'`

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [x] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [x] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions have been reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `chore: scaffold pnpm monorepo, Postgres, and observability spine`
- [x] Phase marked complete

---

### Phase 2: Connect wallet with verified SIWS

**Risk:** ultra-high
**Mode:** afk
**Type:** security
**Success criteria:** A user visiting `/connect` can click "Connect Wallet", approve a single Phantom/Solflare prompt, and land on a page showing "Connected as `<address>`". A revoked or expired session forces re-auth. Switching the active account in the wallet extension without disconnecting forces re-auth rather than silently trading under the wrong identity.
**Commit message:** `feat: wallet connect via verified SIWS`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `apps/web/src/server/db/schema.ts` | add `users`, `wallets` (`custody` enum: `external`\|`embedded`), `sessions` (`id_hash`, `wallet_address`, `created_at`, `expires_at`, `revoked_at`, `last_seen_at`), `siws_challenges` (nonce, stored `SolanaSignInInput`, `consumed_at`, `expires_at`), `events` (append-only: `id`, `occurred_at`, `observed_at`, `event_type`, `correlation_id`, `user_id` nullable, `payload jsonb`) |
| create | `apps/web/src/observability/events.ts` | `recordEvent({ eventType, occurredAt, correlationId, userId?, payload })` — the one write path into `events`; callers never `INSERT INTO events` directly. **Rejects any caller-supplied `observed_at`** — always stamped `now()` server-side, and `occurredAt` must trace back to a chain timestamp or a server-generated one, never a raw client value |
| create | `apps/web/src/server/auth/solana-siws.ts` | thin wrapper: builds `SolanaSignInInput` (domain from `SIWS_DOMAIN` env var, 32-byte nonce, 5-min `expirationTime`), persists it, and verifies `SolanaSignInOutput` via `@solana/wallet-standard-util`'s `verifySignIn` **plus** our own nonce-consumed check, expiry check, and domain equality check |
| create | `apps/web/src/server/auth/session.ts` | issues session (random 32-byte id, stores SHA-256 hash), sets httpOnly/Secure/SameSite=Lax cookie, `resolveSession(cookie)` helper used by every authenticated route — this is the **only** legitimate source of "which wallet is this request for"; no later phase's route may accept a wallet id/address from the request body instead |
| create | `apps/web/src/app/api/auth/nonce/route.ts` | `POST` — behind `auth.wallet_connect` feature flag, fail closed if disabled |
| create | `apps/web/src/app/api/auth/verify/route.ts` | `POST` — verifies, upserts `users`/`wallets`, creates session, records `auth.session_created` |
| create | `apps/web/src/client/wallet/wallet-provider.tsx` | `'use client'` wrapper around `@solana/kit` client + `ClientProvider`, built once at module/`useMemo` scope, `<Suspense>` ancestor for the async `.use()` plugin chain |
| create | `apps/web/src/client/wallet/use-wallet-session.ts` | polls `useConnectedWallet()` address against the session's bound address every render; mismatch → tear down session, force re-auth |
| create | `apps/web/src/app/connect/page.tsx` | Connect button using `useSignIn`; renders "Connected as `<address>`" once session established |

**Steps:**

- [x] Add `SIWS_DOMAIN` to `.env.example`; never derive domain from request headers
- [x] Migration: `users`, `wallets`, `sessions`, `siws_challenges`, `events` tables
- [x] Implement `recordEvent()` — the single write path for the behavioral event log (per `observability-stack.md`: same Postgres, `jsonb` payload, distinct from pino/Sentry)
- [x] Implement nonce issuance: build `SolanaSignInInput`, persist keyed by nonce, 5-min TTL, `consumed_at NULL`
- [x] Implement verification: `verifySignIn()` for signature+field match, then explicitly check (a) nonce exists and `consumed_at IS NULL`, (b) `now()` within `[issuedAt, expirationTime]`, (c) stored `domain` equals `SIWS_DOMAIN` — reject and fail closed on any single failure, mark nonce consumed only on success, in the same transaction as the session insert (so a crash between "mark consumed" and "create session" can't leave a consumed-but-unauthenticated state)
- [x] Upsert `users`/`wallets` (custody = `external`), create `sessions` row, set cookie, `recordEvent('auth.session_created', ...)`
- [x] Implement fallback path for wallets without `solana:signIn` (`connect()` + `signMessage()` + manual `verifyMessageSignature`), with a visible error state for wallets that reject arbitrary signing (e.g. some Ledger firmware) instead of hanging
- [x] Client: wallet provider wrapper, connect page, account-switch watcher that force-clears session on mismatch
- [x] Gate `/api/auth/nonce` behind `isFeatureEnabled('auth.wallet_connect')`; seed that flag enabled
- [x] Never re-prompt SIWS on reload — cookie is authoritative; wallet's own reconnect state is cosmetic only

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `apps/web/src/server/auth/solana-siws.test.ts` | using a locally generated Ed25519 keypair (no real wallet needed): (1) valid sign-in verifies and marks the nonce consumed; (2) **replay** — resubmitting the exact same, still-valid `{address, publicKey, signedMessage, signature}` a second time is rejected because the nonce is already consumed, not just because a "duplicate" is detected some other way; (3) an unconsumed but **expired** nonce (`now() > expirationTime`) is rejected even with a perfectly valid signature; (4) a valid signature against the **wrong `domain`** is rejected; (5) a **tampered** `signedMessage` byte is rejected |
| create | `apps/web/src/server/auth/session.test.ts` | session created with correct cookie flags/expiry; revoked session fails `resolveSession`; expired session fails `resolveSession` |
| create | `apps/web/src/observability/events.test.ts` | `recordEvent` persists `occurred_at`/`observed_at`/`correlation_id`/payload correctly; a caller-supplied `observed_at` is ignored/overwritten, never trusted |

**Verification:**

- [x] `pnpm test` passes, including all five negative cases in the SIWS test above
- [x] Manual: connect a real Phantom (or Solflare) wallet in a browser, confirm single-prompt flow, reload page without re-prompting, confirm switching the wallet's active account forces re-auth — connect + reload verified; **account-switch re-auth NOT achieved**, accepted as a known limitation (Jupiter exhibits the same behavior): see `.ai/decisions/wallet-account-switch-desync.md`
- [x] Manual: flip `auth.wallet_connect` flag off, confirm connect attempts fail closed with a clear message

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [x] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [x] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase (flag as security-critical review)
- [x] Any changes made in response to code-reviewer suggestions have been reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat: wallet connect via verified SIWS`
- [x] Phase marked complete

---

### Phase 3: Author, commit, and activate a trading constitution

**Risk:** medium
**Mode:** afk
**Type:** backend
**Success criteria:** A connected user can add a daily total-notional limit on a constitution form, click "Commit", see a server-authoritative 20-minute countdown that survives reload, and once elapsed, click "Activate" to lock it in. Attempting to activate before 20 minutes have elapsed (including via a replayed/forged request) is rejected server-side.
**Commit message:** `feat: author, commit, and activate a trading constitution`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `apps/web/src/server/db/schema.ts` | `constitutions` table: `id`, `user_id`, `wallet_id`, `status` (`draft`\|`committing`\|`active`), `document jsonb` (the `Constitution` object), `schema_version`, `commitment_started_at`, `activated_at`, `created_at` |
| create | `packages/rules/src/constitution.ts` | **the full constitution schema** — see design decision below; exported types, `CONSTITUTION_SCHEMA_VERSION`, `migrateConstitution()`. All three `LimitRule` variants are defined here now, even though only `daily_notional_usd` is exposed in the authoring UI and evaluated end-to-end until Phases 5 and 6 land — this is a types-and-jsonb-shape decision (cheap, made once) kept deliberately separate from evaluator/UI rollout (behavior, delivered incrementally) |
| create | `packages/rules/src/constitution.test.ts` | parses/validates a well-formed constitution (all three limit types); rejects malformed ones; migrates a hypothetical older shape |
| create | `apps/web/src/server/constitution/commitment.ts` | `startCommitment()` sets `status='committing'`, `commitment_started_at=now()`; `activateConstitution()` checks `now() >= commitment_started_at + 20min` server-side, sets `status='active'`, `activated_at=now()`, else rejects. Wallet/user resolved from `resolveSession()`, never from the request body |
| create | `apps/web/src/app/api/constitution/route.ts` | `POST` (create/update draft), gated by `isFeatureEnabled('constitution.author')` |
| create | `apps/web/src/app/api/constitution/commit/route.ts` | `POST` — starts commitment, records `constitution.commitment_started` |
| create | `apps/web/src/app/api/constitution/activate/route.ts` | `POST` — validates elapsed time server-side, records `constitution.activated` (or `constitution.activation_rejected_early` on a forged attempt) |
| create | `apps/web/src/app/constitution/page.tsx` | limit-builder form — **only the `daily_notional_usd` limit type is offered here**; commit button; server-driven countdown (poll or server timestamp diff, never a client-only timer); activate button enabled only when server confirms elapsed |

**The constitution schema (the plan's key decision #1 — accepted as-is, unchanged from the prior draft):**

`packages/rules/src/constitution.ts` defines the schema as a versioned, discriminated-union document:

```ts
export const CONSTITUTION_SCHEMA_VERSION = 1 as const;
export type AssetTier = 'STABLE' | 'SOL' | 'BTC' | 'ETH' | 'ALT' | 'MEMECOIN';
export type LimitId = string; // stable uuid, survives edits

export type LimitRule =
  | { id: LimitId; type: 'daily_notional_usd'; maxUsd: string; windowHours: number }
  | { id: LimitId; type: 'asset_tier_acquisition_usd'; tier: AssetTier; maxUsd: string; windowHours: number }
  | { id: LimitId; type: 'rolling_loss_usd'; maxUsd: string; windowHours: number };

export interface Constitution {
  schemaVersion: typeof CONSTITUTION_SCHEMA_VERSION;
  limits: LimitRule[];
}
```

Stored as `constitutions.document jsonb` (matches `single-source-of-truth-database.md`'s "jsonb for the constitution"), with `schema_version` duplicated as a relational column for indexable/queryable filtering. `windowHours` is a plain number, not a `24` literal, even though every Phase 0 limit uses 24 — this is what lets a later phase introduce a 7-day limit with zero migration. New limit types are new members of the `LimitRule` union plus a new `case` in `packages/rules`' evaluator — the `constitutions` table and its jsonb column need no `ALTER TABLE` for that. A breaking reshape of an *existing* field (not just adding a new type) is the only thing that requires bumping `CONSTITUTION_SCHEMA_VERSION` and adding a case to `migrateConstitution(raw): Constitution`, which upgrades old stored documents in place, in code, on read. Each `LimitRule` carries a stable `id` (not derived from its position in the array) specifically so Phase 8's pending-change mechanism can say "this id's `maxUsd` is increasing" even as the surrounding array is edited.

**Steps:**

- [x] Migration: `constitutions` table
- [x] Define `Constitution`/`LimitRule`/`AssetTier` types and `migrateConstitution()` in `packages/rules` (pure, no I/O) — all three limit types, full schema
- [x] Draft/save endpoint validates the document shape against the type before writing (reject malformed limits, e.g. non-positive `maxUsd`); UI itself only offers `daily_notional_usd` for now, but the server-side validator accepts any well-formed `LimitRule`, anticipating Phases 5/6 adding UI for the other two without a server change
- [x] `startCommitment()` / `activateConstitution()` — both server-timestamp-driven, both idempotent (re-clicking "Activate" before elapsed time re-checks rather than erroring ungracefully), wallet resolved from session
- [x] Record `constitution.drafted`, `constitution.commitment_started`, `constitution.activated` events (and `constitution.activation_rejected_early` if a client attempts early activation — this is itself a useful signal, not just a guard)
- [x] Constitution page: daily-notional limit input, countdown computed from server `commitment_started_at` (poll every few seconds; never trust a client-side `setInterval` as the source of truth for whether 20 minutes have passed)
- [x] Gate authoring behind `isFeatureEnabled('constitution.author')`

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/rules/src/constitution.test.ts` | schema validation for all three limit types, rejection of malformed limits, `migrateConstitution` upgrade path |
| create | `apps/web/src/server/constitution/commitment.test.ts` | activation before 20 min elapsed is rejected regardless of client-claimed time; activation after elapsed succeeds; re-activation of an already-active constitution is a no-op/rejected; wallet is always taken from session, a forged `wallet_id` in the request body is ignored |

**Verification:**

- [x] `pnpm test` passes
- [x] Manual: author a daily-notional constitution, commit, confirm activate is disabled and rejected server-side if attempted early (e.g. via direct API call), confirm it succeeds after 20 minutes — authoring, commit, server-driven countdown and **early rejection all confirmed against the DB** (`constitution.activation_rejected_early`, `elapsedMs: 97977` vs `requiredMs: 1200000`); **post-elapsed activation NOT yet manually confirmed** (unit-tested only)

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [x] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [x] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions have been reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat: author, commit, and activate a trading constitution`
- [x] Phase marked complete

---

### Phase 4: Reconcile chain history and enforce the daily notional limit, end to end

**Risk:** high
**Mode:** afk
**Type:** backend
**Success criteria:** On opening the app, a connected wallet's transaction history reconciles from Helius (90-day baseline on first connect, incremental thereafter) into a page showing today's rolling total notional traded against the user's daily limit, and a bare trade list (signature, direction, USD value or "unvalued"). Baseline trades are visibly marked private/baseline and never count toward the live total. Excluded swaps (LST↔SOL, self-transfers) are listed with their exclusion reason. Re-running reconciliation, including two overlapping runs for the same wallet, never double-counts a trade.

**Acid test applied explicitly:** after this phase, a user or QA can connect a wallet with real trade history, activate a daily-notional constitution, make a real swap, reopen the app, and *see* "today's notional: $X of $Y" update along with a plain trade row — this is the thinnest slice that is still genuinely end-to-end (chain → money math → rule decision → screen), deliberately limited to one limit type so the ingestion pipeline's correctness can be verified before Phases 5 and 6 add tier classification and FIFO loss-matching on top of it.

**Commit message:** `feat: reconcile chain history and enforce the daily notional limit end to end`

**Verification-first step**: before writing pipeline code, make one live `getTransactionsForAddress` call against a real Helius free-tier API key for a real wallet address, confirm it returns `pre`/`postTokenBalances` as expected on the free plan. Decision 18's entire design rests on this; if it fails, stop and re-scope this phase before continuing.

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `apps/web/src/server/db/schema.ts` | extend `wallets` with `reconciled_through_slot`, `reconciliation_state` (`never`\|`in_progress`\|`current`\|`failed`); new `trades` table (`id`, `wallet_id`, `signature` unique, `slot`, `transaction_index`, `occurred_at`, `observed_at`, `sold_mint`, `bought_mint`, `sold_amount_base_units`, `bought_amount_base_units`, `usd_value` nullable `NUMERIC(38,12)`, `price_source`, `is_baseline`, `excluded_reason` nullable) — columns for tier/loss (`acquired_tier`, `is_acquisition`, `is_round_trip_close`, `realized_loss_usd`) are added by Phases 5 and 6, not here, to keep this migration scoped to what this phase evaluates |
| create | `apps/web/src/server/chain/helius-client.ts` | `getTransactionsForAddress` wrapper: `commitment: 'finalized'`, `sortOrder: 'asc'`, `tokenAccounts: 'balanceChanged'`, `maxSupportedTransactionVersion: 0`, follows `paginationToken`; behind `isFeatureEnabled('chain.helius')`, fails closed (raises, does not fall through to "no trades") if the flag is off or the call errors |
| create | `apps/web/src/server/chain/lst-allowlist.ts` | small curated SOL/LST mint list (jitoSOL, mSOL, etc.) — shared module, imported by both this phase's swap-exclusion logic and Phase 5's fuller tier classification, so the list is defined once |
| create | `apps/web/src/server/chain/derive-swaps.ts` | nets `pre/postTokenBalances` + native lamport delta per owner into candidate swaps; excludes self-transfers/pure receives (decision 3), thresholds ATA rent-exempt noise, excludes SOL↔wSOL wrap/unwrap and any swap matching `lst-allowlist.ts` (decision 8), tagging `excluded_reason` |
| create | `apps/web/src/server/pricing/binance-klines.ts` | fetch/cache 1-min OHLCV from `data-api.binance.vision` into a new `token_prices` table (`mint`, `minute_bucket_utc`, `usd_price NUMERIC(38,12)`, `source`, `fetched_at`, PK `(mint, minute_bucket_utc)`) for SOL and stablecoins, shared across all users; behind `isFeatureEnabled('pricing.binance')` |
| create | `apps/web/src/server/pricing/price-trade.ts` | leg-selection: price the known SOL/stablecoin leg; a trade with neither leg priceable is `usd_value: null` (fail closed — never `$0`, never silently included as zero in the notional sum) — long-tail alt↔alt fallback (Birdeye) is added in Phase 5, not here |
| create | `apps/web/src/server/rules/rolling-allowance.ts` | generic "sum `usd_value` of trades in the last N hours, compare to a limit" helper, parameterized so Phases 5/6 can reuse it for per-tier and loss windows rather than reimplementing the windowed-sum logic |
| create | `packages/rules/src/evaluate.ts` | pure `evaluateTrade(constitution, windowedHistory, trade): Decision`, implementing only the `daily_notional_usd` case for now; any other `LimitRule.type` present in a constitution returns `verdict: 'unevaluable'` for that limit (fail-closed, not silently allowed) until Phases 5/6 add their cases to this same file |
| create | `packages/rules/src/evaluate.test.ts` | unit tests for `daily_notional_usd`, no I/O |
| create | `apps/web/src/server/chain/reconcile-wallet.ts` | orchestrates: pull → derive → price → evaluate (daily notional only) → persist page + advance `reconciled_through_slot` in one DB transaction with a row lock (`SELECT ... FOR UPDATE`) on the wallet, `INSERT ... ON CONFLICT (signature) DO NOTHING`; wallet resolved from `resolveSession()`, never a client-supplied id |
| create | `apps/web/src/app/api/wallet/reconcile/route.ts` | triggered on app open (not scheduled — consistent with `hosting-and-growth-path.md`'s Phase 0 no-cron approach); gated by `isFeatureEnabled('chain.helius_reconcile')` |
| create | `apps/web/src/app/constitution-status/page.tsx` | "today's notional: $X of $Y", bare trade list with tier-free trade rows (signature, direction, USD or "unvalued"), baseline-vs-live indicator, excluded trades shown with reason. Phases 5–7 extend this same page rather than building new ones |

**Steps:**

- [ ] Live smoke-test Helius call (see Verification-first step above) before writing any pipeline code
- [ ] Migrations: `trades`, `token_prices`, `wallets` extensions
- [ ] Implement Helius client wrapper with exact query shape from decision 18, behind its own kill switch, fail closed on error
- [ ] Implement swap derivation heuristic (net deltas → candidate swap; ≥1 negative + ≥1 positive delta, excluding fee-only noise, self-transfers, pure receives, and LST swaps via `lst-allowlist.ts`)
- [ ] Implement Binance klines majors pricing (shared cache, own kill switch) and the leg-selection logic for the SOL/stablecoin leg; unresolvable → `null`, never `0`
- [ ] Implement `evaluateTrade()` in `packages/rules` with the `daily_notional_usd` case and the `unevaluable` fallback for not-yet-implemented types
- [ ] Implement `reconcile-wallet.ts`: single DB transaction per page, `reconciled_through_slot` advanced only to the highest slot actually persisted, row-locked on the wallet for the duration — write a test that fires two concurrent `reconcileWallet()` calls for the same wallet and asserts only one proceeds at a time and no trade is duplicated
- [ ] First connect triggers a 90-day backfill tagged `is_baseline=true`; record `wallet.backfill_started`/`wallet.backfill_completed`; subsequent opens do incremental reconciliation from the cursor, tagged `is_baseline=false`; baseline trades are never passed to `evaluateTrade()` at all
- [ ] Record `wallet.reconciliation_started`/`completed`/`failed`, `trade.excluded`, and `rule.decision_recorded` (for every live trade, allow or violation) events
- [ ] `constitution-status` page renders the daily total vs limit and the trade list; distinguish `reconciliation_state='never'` from a wallet with zero trades (survivorship-bias constraint)
- [ ] Gate the whole reconciliation call behind its feature flags; fail closed (show "not yet reconciled," never a false "clean" or a false "$0 spent today") if any flag is off or a call errors

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `apps/web/src/server/chain/derive-swaps.test.ts` | correctly derives swaps from fixture balance deltas; excludes self-transfers/pure receives/SOL↔wSOL/LST swaps; thresholds rent-exempt noise |
| create | `apps/web/src/server/pricing/price-trade.test.ts` | stable leg priced with zero external calls; SOL leg priced via cached klines; unresolvable → `null`, never `0` |
| create | `apps/web/src/server/rules/rolling-allowance.test.ts` | windowed sum recomputes correctly as trades age out of the 24h window |
| create | `packages/rules/src/evaluate.test.ts` | `daily_notional_usd` allow and violation cases; a constitution containing an `asset_tier_acquisition_usd` or `rolling_loss_usd` rule (not yet implemented) returns `unevaluable` for that limit rather than silently allowing |
| create | `apps/web/src/server/chain/reconcile-wallet.test.ts` | re-running reconciliation over the same range does not double-insert (unique `signature` constraint honored); cursor only advances to a fully-persisted page; a mid-run failure leaves `reconciliation_state='failed'`, not a false `current`; **two concurrent reconciliation calls for the same wallet serialize via the row lock and produce no duplicate trades**; wallet is always resolved from session, never from a request parameter |

**Verification:**

- [ ] Live Helius smoke test succeeds on the free tier (documented result, not just "it worked")
- [ ] `pnpm test` passes
- [ ] Manual: connect a real wallet with known trade history, activate a daily-notional constitution, confirm the status page populates correctly, baseline trades are visibly marked private, re-opening the app doesn't duplicate rows

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions have been reflected back into this plan file
- [ ] Tests for this phase written and passing
- [ ] Documentation updated
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `feat: reconcile chain history and enforce the daily notional limit end to end`
- [ ] Phase marked complete

---

### Phase 5: Thicken with asset-tier classification and per-tier acquisition limits

**Risk:** high
**Mode:** afk
**Type:** backend
**Success criteria:** A user can add a per-asset-tier acquisition limit (e.g. "$100/24h into MEMECOIN") alongside their daily total. Each trade on the status page now shows a tier badge, and buying into a tier past its limit is flagged as a violation while selling out of that tier never is. An unclassifiable token is visibly tagged "counted as memecoin."

**Acid test applied explicitly:** this is not a re-run of Phase 4's layer — it adds a second, independently authorable limit type with its own visible enforcement (tier badges + per-tier violations), which a user can exercise without touching anything from Phase 6.

**Commit message:** `feat: asset-tier classification and per-tier acquisition limits`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `apps/web/src/server/db/schema.ts` | add `trades.acquired_tier`, `trades.is_acquisition` columns |
| create | `apps/web/src/server/chain/classify-token.ts` | curated allowlists (stables, SOL/wSOL, BTC/ETH wrappers) + `lst-allowlist.ts` (reused from Phase 4, not duplicated) + Jupiter Tokens v2 `tag=verified` lookup, behind `isFeatureEnabled('classification.jupiter_tags')`; unclassifiable or flag-off → `MEMECOIN` + `classification: 'unknown'` (decision 7's fail-closed default doubles as the kill-switch fallback) |
| create | `apps/web/src/server/pricing/birdeye-price.ts` | long-tail mint pricing via `historical_price_unix`/`history_price`, behind `isFeatureEnabled('pricing.birdeye')` |
| modify | `apps/web/src/server/pricing/price-trade.ts` | add alt↔alt fallback: price the more liquid leg via Birdeye when neither leg is SOL/stablecoin |
| modify | `packages/rules/src/evaluate.ts` | add the `asset_tier_acquisition_usd` case, reusing the existing `Decision`/`LimitEvaluation` types and `rolling-allowance.ts` windowing helper from Phase 4 |
| modify | `apps/web/src/server/chain/reconcile-wallet.ts` | resolve tier via `classify-token.ts` before calling `evaluateTrade`; pass `acquiredTier`/`isAcquisition` through |
| modify | `apps/web/src/app/constitution/page.tsx` | add the per-asset-tier limit as a second authoring option |
| modify | `apps/web/src/app/constitution-status/page.tsx` | add tier badges to each trade row and a per-tier remaining-allowance line |

**Steps:**

- [ ] Migration: `trades` tier columns
- [ ] Implement `classify-token.ts` reusing `lst-allowlist.ts`; unknown mint → `MEMECOIN` + `classification: 'unknown'`; flag-off → same fail-closed fallback
- [ ] Implement Birdeye long-tail pricing behind its own kill switch; extend `price-trade.ts`'s leg-selection to fall back to it only when neither leg is SOL/stablecoin
- [ ] Add `asset_tier_acquisition_usd` to `evaluateTrade()`: sums `usd_value` only where `isAcquisition && acquiredTier === rule.tier`; disposals never consume this allowance (decision 6)
- [ ] Wire classification into `reconcile-wallet.ts`, in the same transaction/order as Phase 4's pipeline
- [ ] Extend constitution authoring UI and status page

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `apps/web/src/server/chain/classify-token.test.ts` | curated lists resolve correctly; unknown mint → MEMECOIN + `unknown`; flag-off → same fallback; LST list reused correctly from `lst-allowlist.ts` (no divergence between exclusion and classification lists) |
| modify | `apps/web/src/server/pricing/price-trade.test.ts` | alt↔alt fallback prices the more liquid leg via Birdeye; still `null` if Birdeye is also unresolvable/flag-off |
| modify | `packages/rules/src/evaluate.test.ts` | `asset_tier_acquisition_usd`: buying into a tier past its limit violates; selling out of that tier never consumes the allowance regardless of amount; a trade can violate the tier limit and still be within the daily-notional limit (independent evaluations) |

**Verification:**

- [ ] `pnpm test` passes
- [ ] Manual: activate a constitution with a tight per-asset-tier limit, execute a small real swap into that tier on-chain, confirm it's flagged with correct reasoning; confirm selling out of an over-limit tier is never itself flagged

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions have been reflected back into this plan file
- [ ] Tests for this phase written and passing
- [ ] Documentation updated
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `feat: asset-tier classification and per-tier acquisition limits`
- [ ] Phase marked complete

---

### Phase 6: Thicken with FIFO lot-matching and the rolling loss limit

**Risk:** ultra-high
**Mode:** afk
**Type:** backend
**Success criteria:** A user can add a rolling-loss limit. The status page shows remaining loss allowance and an explicit disclaimer that it only covers positions opened and closed after activation (decision 1's partial coverage, stated plainly, not implied as full P&L). A round-trip opened before activation and closed after never counts against the loss limit; one opened and closed after activation does.

**Acid test applied explicitly:** isolated on purpose, as the coordinator's review flagged — FIFO lot-matching is the single most arithmetically complex and highest-risk-of-silent-bug piece in this plan (decimal precision, partial-fill matching, activation-boundary logic). Keeping it out of Phase 4's basic ingestion and Phase 5's classification means a bug here is caught by tests scoped to exactly this file, not buried in a larger phase's diff. The visible output — a third independently authorable and enforced limit type — satisfies the acid test on its own.

**Commit message:** `feat: FIFO lot-matching and the rolling loss limit`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `apps/web/src/server/db/schema.ts` | new `position_lots` table (`id`, `wallet_id`, `mint`, `opened_at`, `opened_after_activation`, `remaining_base_units`, `cost_basis_usd NUMERIC(38,12)`); add `trades.is_round_trip_close`, `trades.realized_loss_usd` nullable `NUMERIC(38,12)` |
| create | `apps/web/src/server/chain/lot-matching.ts` | FIFO cost-basis matching per mint, in USD; BigInt base units for token amounts, `NUMERIC`/decimal-string USD throughout, no floats at any step; flags `opened_after_activation` per lot and only computes `realized_loss_usd` for closes where the matched opening lot(s) were opened after activation (decision 1) — partially-covered closes (opened pre-activation) are excluded from the loss sum entirely, not partially counted |
| modify | `packages/rules/src/evaluate.ts` | add the `rolling_loss_usd` case: sums `realized_loss_usd` (negative values only) where `is_round_trip_close`, reusing `rolling-allowance.ts` |
| modify | `apps/web/src/server/chain/reconcile-wallet.ts` | run `lot-matching.ts` after classification, before evaluation, in the same transaction, in strict `occurred_at` order (lot matching is inherently order-dependent) |
| modify | `apps/web/src/app/constitution/page.tsx` | add the rolling-loss limit as a third authoring option, with UI copy about partial coverage shown at authoring time, not just on the results page |
| modify | `apps/web/src/app/constitution-status/page.tsx` | add loss-allowance-remaining line + the partial-coverage disclaimer |

**Steps:**

- [ ] Migration: `position_lots`, `trades` loss columns
- [ ] Implement FIFO lot-matching: on each acquisition, open/append a lot; on each disposal, consume the oldest lot(s) first, compute realized P&L per matched unit; tag `opened_after_activation` on the lot at creation time from the wallet's active constitution's `activated_at`
- [ ] Enforce decision 1 precisely: a close is loss-limit-eligible only if **every** lot it consumes was opened after activation; if a close consumes a mix of pre- and post-activation lots, exclude it entirely from the loss sum (documented as the "partial coverage" behavior, not split/prorated — simpler and honestly conservative)
- [ ] Add `rolling_loss_usd` to `evaluateTrade()`
- [ ] Wire lot-matching into `reconcile-wallet.ts`, strictly ordered
- [ ] Extend authoring UI and status page with the loss limit and its disclaimer copy
- [ ] Kill switch: `rules.loss_limit_enabled`, independent of the tier/notional flags, so loss evaluation can be disabled on its own if the matching logic needs to be paused without affecting the other two limit types

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `apps/web/src/server/chain/lot-matching.test.ts` | simple full round-trip opened+closed post-activation → eligible, correct realized loss; round-trip opened pre-activation, closed post-activation → excluded entirely (decision 1); a close spanning multiple lots where some are pre-activation and some post-activation → excluded (mixed-lot conservative rule); partial disposal (sells less than the open lot) leaves a correctly-sized remaining lot; all amounts computed via BigInt/decimal-string math with an assertion that no `Number` with a fractional token amount is ever used |
| modify | `packages/rules/src/evaluate.test.ts` | `rolling_loss_usd`: a losing round-trip within the window violates; a winning round-trip never counts against the limit; a trade that isn't a close at all doesn't affect the loss sum |

**Verification:**

- [ ] `pnpm test` passes
- [ ] Manual: activate a loss-limit constitution, execute a real small round-trip at a loss on-chain, confirm it's counted; confirm a pre-existing position closed at a loss is *not* counted and the UI explains why

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase (flag the decimal-math and activation-boundary logic for extra scrutiny)
- [ ] Any changes made in response to code-reviewer suggestions have been reflected back into this plan file
- [ ] Tests for this phase written and passing
- [ ] Documentation updated
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `feat: FIFO lot-matching and the rolling loss limit`
- [ ] Phase marked complete

---

### Phase 7: Discipline dashboard — live-updating allowances and the "we saw that" feed

**Risk:** medium
**Mode:** afk
**Type:** frontend
**Success criteria:** The status page from Phases 4–6 becomes the real dashboard: all three limits' remaining allowances now visibly tick down/recover as the rolling 24h window moves (not just on page load), explicit copy states the window resets continuously rather than at midnight, and a chronological violations feed is framed as accountability, not punishment ("we saw that you exceeded your MEMECOIN limit by $20") — with zero blocking language anywhere. Baseline-period activity is clearly labeled pre-commitment and never appears in the feed.
**Commit message:** `feat: live-updating discipline dashboard and violation feed`

By this point all three limit types exist and are individually verified (Phases 4–6); this phase's job is specifically the product-quality experience layer — live refresh and the historical feed — not new rule logic, so it reuses `rolling-allowance.ts` and existing `rule.decision_recorded` events rather than introducing new server computation.

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `apps/web/src/app/constitution-status/page.tsx` (renamed to `apps/web/src/app/dashboard/page.tsx`) | client-side polling against the existing allowance API so figures visibly move without a manual reload; explicit "resets continuously — not at midnight" copy |
| create | `apps/web/src/app/api/dashboard/route.ts` | serves current allowance state (via existing `rolling-allowance.ts`) + recent decisions, gated by `isFeatureEnabled('dashboard.discipline_view')` |
| create | `apps/web/src/server/dashboard/violations-feed.ts` | queries `rule.decision_recorded` events with `verdict='violation'`, explicitly filtering out anything sourced from `is_baseline=true` trades |

**Steps:**

- [ ] Rename/promote the Phase 4–6 status page into `dashboard/page.tsx`; no server logic changes, just the new route and polling behavior
- [ ] Implement `violations-feed.ts`, reusing existing event data — no new event types needed
- [ ] Implement the live-updating client polling (or a short-interval recompute) against the server-authoritative allowance figures — never a client-only countdown
- [ ] Record `dashboard.viewed` event (also serves Phase 9's return-visit metric)
- [ ] Copy review pass: confirm no blocking/punitive language anywhere on this screen

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `apps/web/src/server/dashboard/violations-feed.test.ts` | returns violations in chronological order; baseline-sourced trades never appear, even if they would have evaluated to a violation |

No additional automated tests for the page component's polling behavior itself — justified because the remaining-allowance computation is already covered by `rolling-allowance.test.ts` (Phase 4) and this phase adds no new server-side math, only a refresh cadence and copy; the manual verification below covers what a unit test can't meaningfully assert (visual live-update, copy tone).

**Verification:**

- [ ] `pnpm test` passes
- [ ] Manual: confirm the remaining-allowance figures visibly change as old trades age out of the rolling window without any new activity, without a manual reload; confirm baseline trades never appear in the feed; confirm copy review

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions have been reflected back into this plan file
- [ ] Tests for this phase written and passing
- [ ] Documentation updated
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `feat: live-updating discipline dashboard and violation feed`
- [ ] Phase marked complete

---

### Phase 8: Constitution edits — instant decrease, 48h delayed increase

**Risk:** medium
**Mode:** afk
**Type:** backend
**Success criteria:** From the active constitution, a user can decrease any limit (of any of the three types) and see it apply immediately. Increasing a limit instead schedules the change, visibly labeled with the exact time it takes effect, and it is not applied until that time passes — even if the user reloads, closes the tab, or the change is checked well past its due time.
**Commit message:** `feat: asymmetric constitution edits — instant decrease, 48h delayed increase`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `apps/web/src/server/db/schema.ts` | `constitution_pending_changes` table: `id`, `constitution_id`, `limit_id`, `field`, `old_value`, `new_value`, `effective_at`, `applied_at` nullable, `created_at` |
| create | `apps/web/src/server/constitution/pending-changes.ts` | `requestLimitChange()`: decreases apply immediately + `recordEvent('constitution.limit_decreased', ...)`; increases insert a pending row with `effective_at = now() + 48h` + `recordEvent('constitution.limit_increase_requested', ...)`; `applyDuePendingChanges()`: applied lazily on next reconciliation/app-open pass (no cron/worker in Phase 0, consistent with the app-open reconciliation pattern), applies any row where `effective_at <= now() AND applied_at IS NULL`, records `constitution.limit_increase_applied` |
| modify | `apps/web/src/app/api/wallet/reconcile/route.ts` | calls `applyDuePendingChanges()` alongside chain reconciliation on app open |
| create | `apps/web/src/app/constitution/edit/page.tsx` | edit UI showing pending increases with their exact effective timestamp |

**Steps:**

- [ ] Migration: `constitution_pending_changes`
- [ ] Implement decrease-is-immediate path: mutate `constitutions.document`, bump nothing else, record event
- [ ] Implement increase-is-delayed path: insert pending row referencing the limit's stable `id` (from Phase 3's schema design), record event; do not mutate `constitutions.document` yet
- [ ] Implement `applyDuePendingChanges()`, called on app open (piggybacking on the existing reconciliation entry point rather than introducing a scheduler)
- [ ] Edit UI shows current limits, in-flight pending increases with countdown-to-effective, and allows cancelling a pending increase before it applies (`constitution.limit_increase_cancelled` event)

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `apps/web/src/server/constitution/pending-changes.test.ts` | decrease applies immediately and is reflected in `constitutions.document`; increase does not apply before `effective_at` even if `applyDuePendingChanges` is called repeatedly; increase applies once `effective_at` has passed; a cancelled pending change never applies |

**Verification:**

- [ ] `pnpm test` passes
- [ ] Manual: request a limit decrease, confirm immediate effect; request a limit increase, confirm it's pending and not yet in effect; simulate passing 48h (test harness clock or a shortened test-only threshold) and confirm it applies on next app open

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions have been reflected back into this plan file
- [ ] Tests for this phase written and passing
- [ ] Documentation updated
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `feat: asymmetric constitution edits — instant decrease, 48h delayed increase`
- [ ] Phase marked complete

---

### Phase 9: Internal metrics view — measuring the Phase 0 bet

**Risk:** low
**Mode:** afk
**Type:** backend
**Success criteria:** A founder/PM hitting an internal-only route (protected by a shared-secret header, no full RBAC yet) sees, computed live from the event log: onboarding completion rate, average limits set per activated constitution, commitment-to-activation conversion, return-visit frequency and the week-2 return floor, rules-kept percentage, external violation frequency trend (post-activation vs the private baseline), and decrease-requests as a proxy for "wants stricter rules." A free-text feedback capture is wired in for the qualitative killer-signal quote, explicitly labeled as not auto-computed.
**Commit message:** `feat: internal metrics view for Phase 0 success signals`

This phase is the plan's second key decision made concrete: the event set defined across Phases 2–8 is exactly what each roadmap signal needs — if any query below couldn't be written, that would mean an earlier phase's event set was wrong. None were found missing.

**Signal → event type → query mapping:**

| Roadmap signal | Event type(s) | Query |
|---|---|---|
| Onboarding completion | `auth.session_created`, `constitution.activated` | `count(distinct user_id where constitution.activated) / count(distinct user_id where auth.session_created)`, by day cohort |
| Limits set | `constitution.activated` payload (`document.limits`) | avg/distribution of `limits.length` and limit types across activated constitutions |
| Activation (commitment follow-through) | `constitution.commitment_started`, `constitution.activated`, `constitution.activation_rejected_early` | `count(activated) / count(commitment_started)`, plus early-activation-attempt rate as a bypass-desire signal |
| Return visits / week-2 floor | `dashboard.viewed` (or `wallet.reconciliation_started` as app-open proxy) | distinct calendar days with an event per user; % of users with ≥1 event in days 8–14 after `constitution.activated` |
| Rules kept % | `rule.decision_recorded` | `count(verdict='allowed') / count(*)`, grouped by user, `occurred_at`-based, live (non-baseline) trades only |
| External violation frequency | `rule.decision_recorded` (`verdict='violation'`) vs baseline-period trades (`is_baseline=true`, evaluated ad hoc for this comparison only, never surfaced to the user) | violations/week post-activation compared against the counterfactual violation rate the same constitution would have produced against the 90-day pre-activation baseline |
| Requests for stricter rules | `constitution.limit_decreased` | count of voluntary decreases per user over time — a proxy signal only |
| The killer signal ("I know I can bypass this, but I don't want to") | `feedback.prompt_shown`, `feedback.submitted` (free text) | **not computable from telemetry alone** — this is captured qualitatively via a lightweight in-app feedback prompt and reviewed manually; the plan states this explicitly rather than forcing a fake proxy metric |

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `apps/web/src/server/metrics/queries.ts` | one function per row in the table above, each a plain SQL query over `events`/`trades`/`constitutions` |
| create | `apps/web/src/app/api/admin/metrics/route.ts` | protected by `ADMIN_METRICS_SECRET` env-var header check (deliberately minimal — no RBAC system exists in Phase 0, per decision 11's "no accounts/roles" scope); missing/wrong secret returns 404, not 403, so the route's existence isn't confirmed to an unauthenticated caller |
| create | `apps/web/src/app/admin/metrics/page.tsx` | renders the computed signals |
| create | `apps/web/src/server/feedback/feedback.ts` | `recordFeedbackPrompt()`/`recordFeedback()` writing `feedback.prompt_shown`/`feedback.submitted`; submitted text is length-capped and stored as-is (no interpretation), never trusted as anything but opaque user text |
| create | `apps/web/src/app/api/feedback/route.ts` | free-text submission endpoint, shown to users post-activation or after a violation is surfaced |

**Steps:**

- [ ] Implement each query in `metrics/queries.ts` directly against the event log (no precomputed/incremented counters, per the derive-not-increment invariant)
- [ ] Implement the baseline-vs-post-activation violation comparison by running `evaluateTrade` against baseline trades ad hoc, purely for this internal metric — explicitly not stored as `rule.decision_recorded` events and never shown to the user (decision 9)
- [ ] Implement the admin route's shared-secret gate; fail closed (404, not a 403 that confirms the route exists) on missing/wrong secret
- [ ] Implement the feedback prompt + submission, surfaced at a natural moment (post-activation, or after a violation is shown), with an explicit max length on submitted text
- [ ] Render the metrics page

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `apps/web/src/server/metrics/queries.test.ts` | each query against a seeded fixture event set produces the expected number (one test per row in the mapping table) |
| create | `apps/web/src/app/api/admin/metrics/route.test.ts` | missing/wrong secret → 404; correct secret → 200 with expected shape |

**Verification:**

- [ ] `pnpm test` passes
- [ ] Manual: seed a fixture dataset spanning baseline + post-activation trades across 2+ users, hit `/admin/metrics` with the correct secret, sanity-check every number against hand-computed expectations

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions have been reflected back into this plan file
- [ ] Tests for this phase written and passing
- [ ] Documentation updated
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `feat: internal metrics view for Phase 0 success signals`
- [ ] Phase marked complete

---

### Phase 10: Final Verification

**Mode:** hil

**Overall success criteria:**

- A new user can: initialize/clone into a real git-tracked repo (Phase 0) → connect a wallet via a single-prompt SIWS flow → author a constitution with all three limit types → sit through a real (or test-shortened) 20-minute commitment period → activate → have their wallet's 90-day history silently backfilled as a private baseline → see live post-activation trades reconciled, classified, priced, lot-matched, and evaluated against all three limits on each app open → see a discipline dashboard with correctly-rolling 24h allowances and a non-punitive violations feed → decrease a limit immediately or request an increase that only lands 48h later → and all of this is measurable end-to-end from `/admin/metrics`.

**Steps:**

- [ ] Every preceding phase's Steps/Verification/Phase review checkboxes are ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block (scoped to end-to-end review)
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent reviews the entire change end-to-end, with explicit attention to: SIWS replay/expiry/domain-binding correctness, money-math precision (no floats anywhere in allowance/loss/lot-matching calculations), fail-closed behavior on every external dependency (Helius, Binance, Birdeye, Jupiter tags), that baseline trades are unreachable from any user-facing violation surface, and that no route trusts a client-supplied wallet/user identifier over the session
- [ ] Any changes made in response to the final code-reviewer review have been reflected back into this plan file
- [ ] All tests pass (`pnpm test` across the whole workspace)
- [ ] No CLAUDE.md invariants violated (spot-check: `packages/rules` still has zero I/O imports; every `rule.decision_recorded` includes allows, not just violations; every kill switch introduced in Phases 2–9 is actually flippable without a deploy)
- [ ] Feature tested manually end-to-end on a real Solana wallet with real (small, low-stakes) swaps, covering: golden path, an early-activation bypass attempt, a wallet-account-switch mid-session, a Helius outage (kill switch flipped off) resulting in a fail-closed "not reconciled" state rather than a false-clean dashboard, a mixed pre/post-activation round-trip correctly excluded from the loss limit
- [ ] Overall success criteria met
- [ ] All phase checkboxes above are ticked

## Documentation

| Change | Documentation location |
|---|---|
| Git/worktree setup | root `README.md` (created in Phase 0) — how to clone, init, and set up a worktree for future plans |
| Monorepo scaffold, DB, observability spine | `apps/web/README.md` (new) — dev setup, env vars, `pnpm dev`/`pnpm test`/`pnpm build` |
| `packages/rules` public API (constitution schema, `evaluateTrade`) | `packages/rules/README.md` (new) — types, versioning/migration approach, worked examples per limit type, and the "types defined upfront, evaluator rolled out incrementally" pattern |
| SIWS wrapper and session model | `apps/web/src/server/auth/README.md` (new) — nonce/verify flow, what `verifySignIn` does vs. what we implement, cookie/session lifecycle |
| Chain reconciliation pipeline | `apps/web/src/server/chain/README.md` (new) — Helius query shape, swap-derivation heuristic and its known imprecisions, cursor/idempotency guarantees, FIFO lot-matching semantics |
| Pricing pipeline | `apps/web/src/server/pricing/README.md` (new) — leg-selection logic, source precedence, `token_prices` cache semantics |
| Constitution edit asymmetry | `apps/web/src/server/constitution/README.md` (new) — decrease-immediate/increase-delayed mechanism, relationship to the Phase 3 timelock (explicitly not the same as Phase 3's future state machine) |
| Metrics/instrumentation | `apps/web/src/server/metrics/README.md` (new) — signal→event→query mapping (mirrors the table in Phase 9), qualitative-signal caveat |

## Knowledge Base Impact

| `.ai/` artifact | Action | What it captures |
|---|---|---|
| `decisions/migration-and-test-tooling.md` | create | New decision (gap identified in current `.ai/`): Drizzle ORM + drizzle-kit for schema/migrations, Vitest for testing, Neon as the Postgres host with its serverless pooled driver — none of these were previously recorded, and this plan is the first code to land, so it's the natural place to fix them |
| `decisions/feature-flags-and-kill-switches.md` | create | New decision: DB-backed `feature_flags` table (global/per-feature/per-user/per-integration scope via `jsonb`), fail-closed default, checked via one `isFeatureEnabled()` helper — CLAUDE.md mandates runtime-flippable flags but never specified the storage mechanism |
| `decisions/constitution-schema.md` | create | The versioned discriminated-union `LimitRule` schema, why `windowHours` is a number not a literal, why each limit carries a stable `id`, why the type union is defined in full upfront while the evaluator/authoring UI roll out one limit type per phase, and the `migrateConstitution` upgrade path — this is the plan's key decision #1 |
| `decisions/phase-0-measurement.md` | create | The full signal→event→query mapping from Phase 9, including the explicit statement that the killer signal and "requests for stricter rules" are qualitative/proxy signals, not fully computable — this is the plan's key decision #2 |
| `index.md` | update | Add rows for `apps/web/src/server/{auth,chain,pricing,constitution,metrics,observability,flags,rules,dashboard}` and `packages/rules` now that they exist, pointing at their READMEs |
| `architecture.md` | update | Mark the previously-agreed target shape as now built for Phase 0's scope; note `packages/db` was deliberately *not* introduced (queries still live in `apps/web/src/server/db`, per the "only when a second consumer needs them" bar) |

_(The `single-source-of-truth-database.md` internal contradiction flagged during research has already been corrected at the source outside this plan — no further action needed here.)_

## Tests

| Phase | Logic under test | Test file |
|---|---|---|
| Phase 1 | Placeholder pure function | `packages/rules/src/index.test.ts` |
| Phase 1 | Logger wrapper structured output | `apps/web/src/observability/logger.test.ts` |
| Phase 1 | Fail-closed feature flag lookup | `apps/web/src/server/flags/feature-flags.test.ts` |
| Phase 2 | SIWS verification, replay/expiry/domain rejection | `apps/web/src/server/auth/solana-siws.test.ts` |
| Phase 2 | Session issuance/revocation/expiry | `apps/web/src/server/auth/session.test.ts` |
| Phase 2 | Append-only event recording, timestamp integrity | `apps/web/src/observability/events.test.ts` |
| Phase 3 | Constitution schema validation + migration | `packages/rules/src/constitution.test.ts` |
| Phase 3 | Server-authoritative 20-min commitment gate, session-only wallet resolution | `apps/web/src/server/constitution/commitment.test.ts` |
| Phase 4 | Swap derivation from balance deltas, exclusions | `apps/web/src/server/chain/derive-swaps.test.ts` |
| Phase 4 | Leg-selection USD pricing, fail-closed on unresolvable | `apps/web/src/server/pricing/price-trade.test.ts` |
| Phase 4 | Windowed-sum allowance helper | `apps/web/src/server/rules/rolling-allowance.test.ts` |
| Phase 4 | Daily-notional evaluation + `unevaluable` fallback | `packages/rules/src/evaluate.test.ts` |
| Phase 4 | Idempotent + concurrency-safe reconciliation | `apps/web/src/server/chain/reconcile-wallet.test.ts` |
| Phase 5 | Token classification + LST exclusion consistency | `apps/web/src/server/chain/classify-token.test.ts` |
| Phase 5 | Alt↔alt Birdeye fallback pricing | `apps/web/src/server/pricing/price-trade.test.ts` (extended) |
| Phase 5 | Per-tier acquisition-only evaluation | `packages/rules/src/evaluate.test.ts` (extended) |
| Phase 6 | FIFO lot-matching, decision-1 partial coverage, decimal safety | `apps/web/src/server/chain/lot-matching.test.ts` |
| Phase 6 | Rolling-loss evaluation | `packages/rules/src/evaluate.test.ts` (extended) |
| Phase 7 | Violation feed ordering, baseline exclusion | `apps/web/src/server/dashboard/violations-feed.test.ts` |
| Phase 8 | Immediate decrease / delayed increase / cancellation | `apps/web/src/server/constitution/pending-changes.test.ts` |
| Phase 9 | Each metrics query against fixture data | `apps/web/src/server/metrics/queries.test.ts` |
| Phase 9 | Admin route secret gating | `apps/web/src/app/api/admin/metrics/route.test.ts` |

## Human Summary

DegenCage's Phase 0 is a bet on whether people will police themselves. This plan builds exactly enough software to test that: connect a wallet, write down trading rules, sit through a real 20-minute cooldown before those rules go live, then let the app watch the wallet's actual on-chain activity and gently point out when a rule got broken — with no ability to actually stop a trade.

The phases build up in order: initialize the repo itself, since it didn't exist yet (Phase 0); get the basic project running (Phase 1); get wallet login working securely (Phase 2, the highest-stakes security work in the plan since we own our own replay/expiry protection); let people write and activate a first, simple rule (Phase 3); then get real chain data flowing end-to-end for that one rule before adding anything else (Phase 4) — deliberately thin, so the hardest infrastructure (Helius, pricing, idempotent reconciliation) gets proven correct on its own before more complexity lands on top. Phase 5 adds a second rule type (per-asset-tier limits) once classification exists; Phase 6 isolates the single trickiest piece of math in the whole plan — matching buys to sells to compute real losses — into its own phase so a bug there is caught by tests aimed exactly at it. Phase 7 turns the by-then-functional status page into the real product experience (live-updating numbers, a "we saw that" feed). Phase 8 lets people loosen or tighten their rules with an intentional asymmetry — tightening is instant, loosening takes 48 hours. Phase 9 builds a private internal page that tells us, in numbers, whether any of this actually changed anyone's behavior.

The two hardest design calls: the shape of a "constitution" (kept flexible enough that new rule types never require a database change — types defined once in full, behavior rolled out one limit type per phase), and making sure every single roadmap success signal has a real, working number behind it. Two of those signals — the "I don't want to bypass this" quote and "wants stricter rules" — are honestly qualitative, and the plan says so instead of faking a metric for them.

Biggest open risks: we're relying on Helius's free tier having a feature we haven't tested live yet (Phase 4 checks that first, before building anything on top of it), and the FIFO loss-matching math in Phase 6 is the single place in the plan where a subtle bug could quietly misreport real money — hence its own isolated phase and extra-scrutiny review pass.
