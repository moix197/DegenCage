# Plan: Phase 1 — Jupiter Trading Terminal

**Created:** 2026-08-27
**Branch:** `phase-1-jupiter-terminal`
**Status:** not started

## Context

Phase 0 (commitment mechanism — constitution, timelocks, dashboard, Helius-driven observation of trades that happen elsewhere) is merged on `main`, 421 tests passing. Phase 0 built the **observation** direction only: Helius → derive swaps → price → classify → lot-match → `evaluateTrade` → Postgres/events, read-only, after the fact. It explicitly deferred real on-chain verification of tier classification, lot-matching, and the rolling-loss limit against live chain data to "roadmap Phase 1."

Phase 1 builds the **interception** direction for the first time: a `/trade` terminal where the user picks a swap, the rule engine evaluates it against their real constitution and rolling allowance *before* a signature exists, and — if it violates a limit — the trade is blocked pre-signature ("Nice try. Your SOL allowance is already exhausted."). This is the first time the platform enforces anything; it is also the first transaction-signing code in the repo (`@solana/kit-plugin-wallet` has no signing hook — signing goes through `client.wallet.getState().connected.signer`, feature-detected against `wallet.features`) and the first time the repo calls Jupiter's Swap API rather than just Tokens v2.

Server relay architecture (non-custodial, no private keys ever touch the server): server calls Jupiter `swap/v2/build`, evaluates rules, assembles + compiles the unsigned v0 transaction → browser wallet signs → server re-verifies the signed bytes against what it approved → server broadcasts via Helius. The user can always bypass us and go straight to Jupiter — that remains true and is not something this plan changes or should try to prevent.

## Risk: high

Money moves through this system for the first time. Wrong CU-limit estimation, a missed re-evaluation at submit, or a reservation bug that lets two concurrent quotes both spend the same allowance are all real-fund-loss or discipline-bypass bugs, not cosmetic ones.

## Dependencies & Risks

- **Jupiter `/swap/v2/build` has real documentation gaps** (confirmed via Jupiter's own MCP docs server, not assumption): it does **not** document whether it pre-checks taker balance before returning 200 (contrast with `/order`, which does via `errorCode: 1`); the only documented error shape is `400 { "error": string }`, with `"No routes found"` as the one enumerated message. Insufficient-balance and slippage-exceeded failures must be assumed to surface only at simulation/send time, not at `/build` time. Every phase touching `/build` must code defensively for this, not assume a clean error taxonomy.
- **Free-tier Jupiter API key is 1 RPS / 60 RPM, shared org-wide across `/build` and `/tokens/v2/search`** (same bucket — confirmed in Jupiter docs) — the 500ms debounce + short-TTL quote cache (decision 9) is not a nice-to-have, it's required to avoid self-inflicted 429s the moment both quote-refresh and token-search are in flight together.
- **`lite-api.jup.ag` is being actively retired.** `jupiter-tokens.ts` still points at it. Migrating to `api.jup.ag` (same paths) rides along with introducing `JUPITER_API_KEY` in Phase 2 — deferring it further risks the host disappearing mid-phase.
- **No separate quote-TTL field exists in `/build`'s response.** Expiry must be derived from `blockhashWithMetadata.lastValidBlockHeight` (the aggregator's documented hard expiry for Metis-routed swaps, which is all `/build` uses) converted via ~400ms/slot — there is no wall-clock expiry timestamp Jupiter hands us directly. `trade_intents.expires_at` is *our* computed estimate, not an authoritative value from Jupiter.
- **CU limit is never returned by `/build`** — only CU price. Jupiter's own documented pattern (assemble with `SetComputeUnitLimit(1_400_000)`, simulate with `replaceRecentBlockhash: true`, take `unitsConsumed * 1.2` capped at 1,400,000, rebuild) must be implemented against our own Helius RPC; there is no shortcut.
- **Guarded-state-transition discipline is load-bearing here, not stylistic.** `trade_intents.status` transitions (`quoted → approved/blocked → signed → submitted → confirmed/failed/expired`) must each be a single `UPDATE ... WHERE status = '<prior>' RETURNING *`, never read-then-write — this is literally the pattern documented in `.ai/patterns/guarded-state-transition.md` after a real bug (draft/commit race). A TOCTOU hole here means double-reserved allowance or a signed tx for an already-expired quote.
- **Real funds are not risked until Phase 6.** Phases 2-5 build the full pipeline behind `chain.broadcast` (starts OFF), verified via compile+sign+simulate only. Phase 6 is the first and only phase that flips `chain.broadcast` on and moves real (small, throwaway-wallet) money — do not let scope creep pull live broadcasting earlier.

## Pre-trade evaluation & concurrency mechanisms (resolved during revision)

These are binding design decisions for Phases 2-5, added during revision review — implementers follow them exactly, not re-derive them from first principles.

**Slippage-safe pricing.** `priceTrade`'s `PriceableTrade` takes both legs' base-unit amounts; which amounts `quote-service.ts` passes in depends on the limit being evaluated, not on the raw quote:
- **Acquisitions and daily notional** (`daily_notional_usd`, `asset_tier_acquisition_usd`): price using the **sold leg's exact amount** — for exact-in swaps this is the amount we specify as input, fixed regardless of execution, never an estimate. Never price these off `outAmount` (the aggregator's optimistic estimate for the bought leg) — the acquired token count has no documented upper bound, so pricing off it would understate risk whenever execution is more favorable than quoted.
- **Disposals / round-trip closes** (`rolling_loss_usd`): price the proceeds using **`otherAmountThreshold`** (the guaranteed-minimum output), never `outAmount`. This assumes the worst-case (smallest) proceeds, which maximizes the estimated realized loss — the conservative direction for a floor-type limit, matching decision 4's fail-closed folding rule.
- Reconciliation (Phase 0, unchanged) prices off real on-chain amounts post-execution and is unaffected — this rule is specifically for the pre-trade estimate in `quote-service.ts`, which reconciliation later trues up.
- The `usd_value` written to a `trade_intents` row must be computed by this rule, since Phase 4's reservation sums that same column.

**Compiled-message hash, not signed-transaction hash.** `tx_message_hash` (Phase 2) is computed over the **serialized compiled `TransactionMessage`**, before any signature exists. At submit time (Phase 3), `submit-service.ts` must **extract the message from the signed transaction bytes** (strip the signature(s) the wallet appended) and hash that extracted message — never hash the signed transaction as a whole, since signature bytes vary and would never match. Submit also independently checks the compiled message's fee payer / first required signer equals the session wallet's connected address, as a second check beyond the hash comparison (defense in depth beyond `intent.wallet_id == session.walletId`).

**Blockhash byte encoding.** `blockhashWithMetadata.blockhash` arrives from `/build` as raw bytes (`number[]`), not a base58 string. `assemble-transaction.ts` must base58-encode it before embedding it in the compiled message — using the raw byte array directly produces a garbage blockhash with no obvious error at build time, only a mysterious failure at simulate/send time.

**Simulation vs. real blockhash ordering.** `assemble-transaction.ts` runs two distinct passes, in this order:
1. Build a throwaway message (max CU limit 1,400,000 + all instructions) and simulate with `replaceRecentBlockhash: true`, purely to measure `unitsConsumed`. If this simulation fails for any reason, **block the quote — fail closed, never fall through to a guessed or default CU limit.**
2. Build the real message the user will sign, using `unitsConsumed * 1.2` (capped 1,400,000) as the CU limit, and the **actual blockhash from `/build`'s `blockhashWithMetadata`** (base58-encoded per above) — never the replaced blockhash used only for step 1's simulation.

**Single-live-intent concurrency guarantee.** A `SELECT` (any live intent?) followed by an `INSERT` is not sufficient — two concurrent `/api/swap/quote` calls for the same wallet can both read "none live" before either writes. Phase 4 introduces two layers, per `.ai/patterns/guarded-state-transition.md`'s "lock + SQL guard are belt-and-braces" guidance:
- A **partial unique index**, `uniqueIndex('trade_intents_wallet_live_idx').on(table.walletId).where(sql\`status in ('quoted','approved')\`)` — the first partial index in this codebase (drizzle-orm 0.44.5 supports `.where()` chained after `.on()`; no other schema table uses one yet, so there's no copy-paste precedent to follow). It's a hard DB-level backstop: at most one row occupying the wallet's **quote slot**, full stop. `signed`/`submitted` are deliberately excluded from the predicate — a post-review fix (see `.ai/decisions/live-intent-reservation-vs-quote-slot.md`): the index protects only against two concurrent unsigned quotes racing, not against a `signed`/`submitted` intent, which must be free to coexist with a fresh quote once the wallet has moved on from it.
- Inside `getDb().transaction()`, lock the wallet row first (`SELECT ... FROM wallets WHERE id = $1 FOR UPDATE`, the same lock-the-parent-row convention already used in `reconcile-wallet.ts`), then expire the prior live intent (guarded `UPDATE`), then insert the new one — all under one lock, so two concurrent requests serialize instead of racing.
- **Postgres partial-index predicates must be immutable** — `expires_at > now()` cannot appear in the index predicate, only `status`. This is exactly why time-based expiry cannot be handled by read-side filtering alone (see the reaper below): a row whose wall-clock expiry has passed but whose `status` hasn't been flipped yet still counts as the wallet's one live row against the unique index, and would block a new insert even though it should logically be gone.

**Active expiry reaping.** Unlike `challenge-reaper.ts` / `login-attempt-reaper.ts` (which `DELETE` rows, invoked inline on their own write path), `trade_intents` must stay append-only (decision 2, and CLAUDE.md's "rule state is append-only" spirit) — so the equivalent here is a guarded `UPDATE ... SET status = 'expired' WHERE wallet_id = $1 AND status IN (<live>) AND expires_at <= now() RETURNING id`, never a delete. `intent-lifecycle.ts` exposes this as `reapExpiredIntents(walletId, executor)`, called inline (matching the existing reaper convention — no scheduled-job infrastructure exists in this repo) from two places: the top of `quote-service.ts` (before the unconditional expire-prior-intent step) and from wherever the live-intent allowance sum is read (so a dashboard or other view never displays a reservation from an intent the user silently abandoned).

**Submit idempotency.** A double-submit of the same intent (retry, double-click, network replay) must not double-fire state transitions or events. `submit-service.ts`'s guarded `UPDATE ... WHERE status = 'approved' ... RETURNING *` naturally returns zero rows on a second call (status is no longer `'approved'`) — per the pattern doc, **zero rows is not automatically an error**: re-read the intent; if its status is already `signed`/`submitted`/`confirmed` *and* the presented signed bytes hash to the same `tx_message_hash`, return the original success response (idempotent no-op, no new event recorded); otherwise reject. `trade.intent_signed`/`trade.intent_submitted` events are recorded only on the branch where the guarded `UPDATE` actually returned a row — never on the idempotent-replay branch. (Solana itself is signature-idempotent for identical rebroadcast bytes — this rule is about our own state/events, not the chain.)

**Quote cache key includes the wallet.** The short-TTL server quote cache (decision 9) must key on `(walletId, inputMint, outputMint, amount, slippageBps)` — never on the mint pair and amount alone. `taker` is a request parameter baked into the assembled instructions (ATA derivation, transfer authority); a cache keyed without it would serve one user's assembled transaction — including their own address — to a different user's session.

**ALT resolution is a real external call.** Resolving `addressesByLookupTableAddress` (Phase 2) is an additional Helius RPC round trip, not a local computation. It reuses the existing `chain.helius` flag (not a new one — same dependency), the same timeout/`captureError({failedClosed:true})` treatment as every other Helius call, and throws (blocks the quote) on failure like the rest of that integration. A single quote request now makes up to four sequential external calls (`/build`, decimals lookup, ALT resolution, CU simulation) — this is the real latency budget the 500ms debounce is designed around, not a single round trip.

**`/trade` preconditions.** Before a quote can even be requested, `/api/swap/quote` (and the `/trade` page's own gate) must check, in addition to `trade.terminal`/`jupiter.swap_build`:
- No `constitutions` row for the user, or `status !== 'active'` (i.e. `draft` or `committing`) → block trading entirely with a message directing the user to finish activating a constitution first. Evaluating trades against a non-binding document is meaningless, and a `committing` constitution is mid-timelock by design (Phase 0) — trading against it would let the user act before their own commitment takes effect.
- `loadReconciliationState(walletId) !== 'current'` (reusing the existing helper and the dashboard's exact `409 not_reconciled` convention) → block. Evaluating against an incomplete trade history under-counts the rolling allowance and could approve a trade that would have been blocked with full history.
- A read-only wallet (`connected.signer === null`, feature-detected in Phase 3) may still view quotes and verdicts — that's a legitimate observation use — but the Approve control is disabled with a "connect a signing wallet" message; this is a Phase 3 UI concern, not a Phase 2 block, since Phase 2 never signs anything regardless.

## Decisions this plan is built on (not re-litigated)

1. Server relay: `/api/swap/quote` (build + evaluate + assemble/compile) → wallet `signTransaction` → `/api/swap/submit` (re-verify + broadcast).
2. New append-only `trade_intents` table, guarded state transitions per `.ai/patterns/guarded-state-transition.md`.
3. Allowance consumed = persisted `trades` UNION live intents (approved/signed/submitted, unexpired, signature not yet in `trades`); requesting a new quote expires the wallet's prior live intent.
4. Fold rule: any `violation` → BLOCK; any `unevaluable` from a dependency failure → BLOCK; `rolling_loss_usd` at the gate never returns structurally-unevaluable for the trade's own unknown loss.
5. New `/trade` page; dashboard stays read-only, links to it.
6. Inline block verdict rendered with the quote; submit disabled client-side, hard-blocked server-side regardless.
7. New intent-keyed event types (see Phase 2); `rule.decision_recorded` untouched.
8. Kill switches: `trade.terminal`, `jupiter.swap_build`, `chain.broadcast`. No flag may disable rule enforcement while trading is live.
9. Free Jupiter API key, server-only, 500ms debounce + short-TTL server quote cache; `jupiter-tokens.ts` migrates off `lite-api.jup.ag` in the same change.
10. No platform fee.
11. Re-evaluate at submit: intent still `approved`, not expired, signed-bytes hash matches, re-run `evaluateTrade`, then broadcast.
12. Theme fix (`.dark` on `<html>`, drop inline body style) precedes new shadcn primitives.
13. Account switch invalidates the old wallet's live intents; submit also rejects `intent.wallet_id != session wallet`.
14. Staged verification: dry-run (compile+sign+simulate, never broadcast) first, then live tiny swaps.
15. Blocked attempts never consume allowance; no extra SIWS signature per trade; pre-trade `occurredAt` = server clock at build time; unpriceable quote → block; fail-closed classification defaults to `MICRO_CAP`.

---

## Phases

### Phase 0: Create worktree

**Steps:**

- [ ] Confirm branch name `phase-1-jupiter-terminal` and base ref `main` with the user
- [ ] Run `git worktree add ../phase-1-jupiter-terminal -b phase-1-jupiter-terminal main`
- [ ] Verify worktree is active and on the correct branch (`git worktree list`)

---

### Phase 1: Theme fix + shadcn primitives for the trade form

**Risk:** low
**Mode:** afk
**Type:** frontend
**Success criteria:** Existing pages (dashboard, feedback) render shadcn's dark palette correctly instead of the current light-on-dark-background bug; `input`, `label`, `field`, `select`, `dialog`, `skeleton`, `tooltip`, `sonner` primitives are installed under `apps/web/src/components/ui/` and compile/import cleanly, ready for Phase 2's swap form.
**Commit message:** `fix(web): apply dark theme tokens to html root, add shadcn primitives for trade form`

**Allowed-exception justification:** this is the plan's one permitted "pure infrastructure prerequisite" phase (plan-sequential format spec). It has no user-facing surface of its own — nothing here is a shippable slice — but Phase 2 cannot legibly build a swap form on a codebase where shadcn renders its light palette on a hardcoded dark body, and none of `input`/`select`/`dialog`/`form` exist yet. Folding this into Phase 2 would blow that phase's file count past reason for an unrelated concern (CSS/theming vs. trade domain logic).

**File changes:**

| Action | File | What changes |
|---|---|---|
| modify | `apps/web/src/app/layout.tsx` | Add `dark` class alongside existing `cn('font-sans', geist.variable)` on `<html>`; remove the hardcoded inline dark `style` object on `<body>`; replace with Tailwind `bg-background text-foreground` classes so shadcn's own CSS variables (not an inline override) drive the palette |
| verify | `apps/web/src/app/globals.css` | Confirm shadcn's `.dark` CSS variable block exists (added by the original `shadcn init`) and actually applies now that `<html>` carries the class; adjust only if missing/incomplete |
| create | `apps/web/src/components/ui/input.tsx`, `label.tsx`, `field.tsx`, `select.tsx`, `dialog.tsx`, `skeleton.tsx`, `tooltip.tsx`, `sonner.tsx` | Vendored shadcn primitives via `pnpm dlx shadcn@latest add` (`base-nova` ships no `form.tsx` — `field` is the real equivalent and composes directly with `react-hook-form`), not hand-written |
| modify | `apps/web/package.json` | New deps pulled in by the above (expect `react-hook-form`, a resolver such as `@hookform/resolvers` + `zod` for `form.tsx`, `sonner` for toasts, `@base-ui/react` primitives per this project's shadcn style `base-nova`) — declare explicitly, don't let the CLI silently add unpinned ranges |

**Steps:**

- [x] From `apps/web`, run `pnpm dlx shadcn@latest add input label field select dialog skeleton tooltip sonner`
- [x] Fix `layout.tsx` per the file-changes row above
- [x] Confirm `.dark` tokens in `globals.css` actually change the rendered palette (no leftover inline overrides elsewhere)
- [x] Run `pnpm typecheck` and `pnpm test` workspace-wide to confirm nothing regresses

**Tests:**

No automated tests — justified because: `layout.tsx`'s change is presentational-only markup (swap a hardcoded inline style for a Tailwind token class) on a server component with no branching logic, and the new `components/ui/*` files are vendored copies with no bespoke business logic. Correctness is only observable visually; there is no testable decision here to extract.

**Verification:**

- [x] `pnpm typecheck` passes
- [x] `pnpm test` passes (no regressions)
- [ ] Manual: load `/dashboard` and `/feedback` (or wherever currently reachable) in a browser, confirm dark theme now renders shadcn's dark palette instead of light-on-dark — _deferred: rolled into Phase 2's manual verification pass, when the app is run locally_
- [x] Manual: confirm each new primitive file imports without type errors (a throwaway local import is enough — no permanent smoke-test route needed)

**Phase review:**

- [ ] All Steps and Verification checkboxes ticked
- [x] Reviewer handoff prompt emitted
- [x] Code-reviewer agent has verified this phase
- [x] Review follow-ups reflected back into this plan file
- [x] Documentation updated (see Documentation section)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `fix(web): apply dark theme tokens to html root, add shadcn primitives for trade form`
- [x] Phase marked complete

---

### Phase 2: `/trade` — live quote + rule verdict (read-only, nothing signs)

**Risk:** high
**Mode:** afk
**Type:** mixed
**Success criteria:** An authenticated user behind the `trade.terminal` flag visits `/trade`, picks input/output tokens and an amount, and — after a 500ms debounce — sees a real Jupiter quote (price, DEX route, price-impact, minimum received) alongside the *live* rule-engine verdict for that exact trade, computed against their real constitution and current rolling allowance. If any limit would be violated, an inline alert shows the reason, the current allowance state, and a link to `/constitution/edit`. The submit button is present but disabled — nothing signs yet. This is the first phase where a user can see themselves get blocked before ever touching their wallet to sign.
**Commit message:** `feat(web): add /trade quote + pre-trade rule verdict`

**File changes:**

| Action | File | What changes |
|---|---|---|
| create | `apps/web/src/server/db/migrations/00xx_*.sql` | Generated via `pnpm db:generate` after the schema change below — do not hand-write |
| modify | `apps/web/src/server/db/schema.ts` | New `trade_intents` table: `id uuid pk`, `wallet_id uuid fk`, `constitution_id uuid fk`, `status text` (`quoted\|approved\|blocked\|signed\|submitted\|confirmed\|failed\|expired`), `input_mint text`, `output_mint text`, `in_amount text`, `out_amount text`, `usd_value numeric(38,12) null`, `acquired_tier text null`, `evaluations jsonb`, `quote_response jsonb`, `tx_message_hash text null`, `signature text null`, `expires_at timestamptz`, `created_at timestamptz default now()`. Index on `(wallet_id, status)` for the live-intent lookup Phase 4 needs |
| create | `apps/web/src/server/swap/jupiter-client.ts` | `x-api-key`-authenticated client for `GET api.jup.ag/swap/v2/build`; follows the existing external-client pattern (module-level `JUPITER_SWAP_BUILD_FLAG`, `BASE_URL`, `REQUEST_TIMEOUT_MS`, `AbortController`, `isFeatureEnabled()` first, `captureError(..., {failedClosed:true})`, no retries) — **must throw on failure**, never resolve permissively, since this sits pre-trade |
| modify | `apps/web/src/server/chain/jupiter-tokens.ts` | Migrate `JUPITER_BASE_URL` from `lite-api.jup.ag` to `api.jup.ag` (paths unchanged); add the `x-api-key` header using the same `JUPITER_API_KEY` env var the new swap client uses; extend `lookupTokenMcaps` or add a sibling lookup for mint `decimals` (needed by `priceTrade`) — confirm the exact response field at implementation time against the live Tokens v2 schema |
| create | `apps/web/src/server/chain/helius-simulate.ts` | Thin wrapper exposing `simulateTransaction(message, {replaceRecentBlockhash: true})` against the Helius RPC endpoint, reusing whatever RPC client config `helius-client.ts` already holds |
| create | `apps/web/src/server/swap/assemble-transaction.ts` | Given a `/build` response: resolve ALT accounts via our own Helius RPC (reuses `chain.helius` flag, same timeout/fail-closed treatment as the rest of that integration — see the mechanisms section above), base58-encode `blockhashWithMetadata.blockhash` (arrives as raw `number[]`, never use it un-encoded), simulate a throwaway message with `SetComputeUnitLimit(1_400_000)` and `replaceRecentBlockhash: true` to measure `unitsConsumed` (simulation failure → block, never fall through to a guessed CU limit), rebuild the real v0 message using `unitsConsumed * 1.2` (capped 1,400,000) and the **actual** (not replaced) blockhash from `/build`, compile, hash the compiled **message** — no signature exists yet, this is not a signed-transaction hash |
| create | `apps/web/src/server/swap/quote-service.ts` | Checks preconditions first (constitution exists and `status === 'active'`; `loadReconciliationState(walletId) === 'current'`, same `409` shape the dashboard already uses — see preconditions rule above) → `/build` call → price the quote via `priceTrade` using the slippage-safe leg rule above (sold-leg amount for acquisitions/notional, `otherAmountThreshold` for disposals — never the optimistic `outAmount`) → classify acquired tier via `classifyToken` → `loadWindowedTrades` → `evaluateTrade` → fold verdict per decision 4 → assemble/compile via the module above → derive `expires_at` from `blockhashWithMetadata.lastValidBlockHeight` (~400ms/slot) → write `trade_intents` row (`quoted` or `blocked`) → `recordEvent` for `trade.intent_created` and `rule.pre_trade_decision`, in the same transaction as the intent write |
| create | `apps/web/src/app/api/swap/quote/route.ts` | `POST`, `runtime='nodejs'`, `dynamic='force-dynamic'`, mints `correlationId`, flag-gates `trade.terminal` + `jupiter.swap_build`, `resolveSession()` (401 if none — never trust a body-supplied wallet), validates body (mints are base58 pubkeys, amount is a positive base-unit integer string), surfaces `quote-service`'s precondition failures as `409 {error: 'constitution_not_active'|'not_reconciled', correlationId}`, otherwise calls `quote-service`, returns `{intentId, quote, evaluations, verdict, expiresAt, correlationId}`, `{error, correlationId}` on failure, fail-closed 503 |
| create | `apps/web/src/app/trade/page.tsx` | Server component: `dynamic='force-dynamic'`, `runtime='nodejs'`, `Promise.all([resolveSession(), isFeatureEnabled('trade.terminal')])`, three render branches (flag-off / no-session / content) |
| create | `apps/web/src/app/trade/trade-panel.tsx` | Client component: token/amount inputs (new `input`/`select`/`label` primitives), 500ms-debounced fetch to `/api/swap/quote`, renders quote details + inline block alert (new `alert` — already exists — plus `skeleton` while loading), disabled submit button |
| modify | `apps/web/src/server/flags/feature-flags.ts` callers | Add `TRADE_TERMINAL_FLAG = 'trade.terminal'` export beside the terminal feature, `JUPITER_SWAP_BUILD_FLAG = 'jupiter.swap_build'` beside the swap client |
| modify | `apps/web/src/server/db/seed.ts` | Append both new flags to `SEED_FLAGS`, both `enabled: false` (ships dark per decision 8) |
| modify | `apps/web/src/app/dashboard/**` (wherever the dashboard nav/links live) | Add a link to `/trade` |

**Steps:**

- [x] Add `trade_intents` to `schema.ts`, run `pnpm db:generate`, review the generated SQL, run `pnpm db:migrate` locally
- [ ] Register `JUPITER_API_KEY` in env config/README; obtain a Free-tier key from developers.jup.ag/portal for local/dev use — _registered in `.env.example` + README; **key not yet obtained — human step, blocks the manual checks below**_
- [x] Implement `jupiter-client.ts` against `GET api.jup.ag/swap/v2/build` (no `platformFeeBps`/`feeAccount` per decision 10); code the error path defensively per the documented gap — only `400 {error: string}` is guaranteed, treat anything else (including a 200 that later fails simulation) as a possible balance/liquidity failure surfacing late
- [x] Migrate `jupiter-tokens.ts` to `api.jup.ag` + `x-api-key`; extend it (or add a sibling) for mint decimals
- [x] Implement `helius-simulate.ts`
- [x] Implement `assemble-transaction.ts` following Jupiter's documented CU-limit-via-simulation pattern exactly (1.2x buffer, 1,400,000 cap); base58-encode the blockhash; simulate-then-real-blockhash ordering; fail closed on simulation failure — all per the mechanisms section above
- [x] Implement `quote-service.ts`'s precondition checks (constitution `active`, reconciliation `current`) before any Jupiter call is made
- [x] Implement `quote-service.ts`'s pricing calls to `priceTrade` using the sold-leg-for-acquisitions / `otherAmountThreshold`-for-disposals rule — never pass the optimistic `outAmount` for a disposal's proceeds
- [x] Wire `loadWindowedTrades` + `evaluateTrade` + the fold rule (decision 4) — a dependency failure (Helius down, pricing unresolvable, Jupiter `/build` throwing) must fold to `unevaluable` → BLOCK, never fall through to allow
- [x] Implement the in-memory short-TTL quote cache keyed on `(walletId, inputMint, outputMint, amount, slippageBps)` — never omit `walletId`, since the cached response contains the requesting wallet's assembled instructions — to stay under the shared 1 RPS Free-tier bucket
- [x] Implement `/api/swap/quote/route.ts`
- [x] Add both feature flags + seed entries
- [x] Build `/trade/page.tsx` + `trade-panel.tsx` using Phase 1's new primitives
- [x] Link `/trade` from the dashboard

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `apps/web/src/server/swap/assemble-transaction.test.ts` | CU-limit computation (1.2x buffer, 1,400,000 cap), instruction ordering, ALT resolution (flag-off/timeout → throws), blockhash base58-encoding correctness, simulation failure blocks rather than defaulting to a guessed CU limit, real (not replaced) blockhash lands in the final compiled message |
| create | `apps/web/src/server/swap/quote-service.test.ts` | Fold-rule cases: clean allow, single violation → block, `unevaluable`-from-dependency-failure → block, `rolling_loss_usd` never structurally-unevaluable for the trade's own unknown loss; intent row written with correct status; events recorded in the same transaction; precondition cases: no constitution → block, `status='draft'`/`'committing'` → block, `status='active'` → proceeds, `reconciliationState !== 'current'` → block; pricing cases: an acquisition prices off the sold (spent) leg regardless of `outAmount`, a disposal prices realized loss off `otherAmountThreshold` not `outAmount` |
| create | `apps/web/src/server/swap/jupiter-client.test.ts` | Flag-off → throws; timeout/abort → throws; non-200 → throws with the `{error}` body surfaced |
| create | `apps/web/src/app/api/swap/quote/route.test.ts` | Flag-gate 503s, unauthenticated 401, invalid body 400, `409` for inactive constitution and for not-reconciled, happy path 200 shape, dependency-failure fail-closed 503 — direct handler invocation per the existing `admin/login/route.test.ts` pattern, `vi.mock` for `resolveSession`/`isFeatureEnabled`/`quote-service` |

**Verification:**

- [x] `pnpm test` passes
- [x] `pnpm typecheck` passes
- [ ] Manual: with `trade.terminal` + `jupiter.swap_build` flipped on locally, connect a real wallet, request a quote for a pair with headroom → see quote + "allowed" verdict — _pending: needs a Jupiter API key + real wallet_
- [ ] Manual: request a quote that exceeds a configured limit → see the inline block alert with the correct reason and a working link to `/constitution/edit` — _pending: needs a Jupiter API key + real wallet_
- [ ] Manual: flip `chain.helius` off (or simulate Helius failure) → confirm the quote route fails closed to blocked/503, never a false "allow" — _pending: needs a Jupiter API key + real wallet_

**Kill switch / flag / instrumentation:**

- Flags: `trade.terminal` (route gate), `jupiter.swap_build` (quote/build calls) — both seeded `enabled: false`
- Events: `trade.intent_created`, `rule.pre_trade_decision` — both carry `evaluations` and enough inputs to reconstruct the decision
- Fail-closed: any dependency failure (Jupiter, Helius simulate, pricing, classification) blocks, never allows

**Phase review:**

- [ ] All Steps and Verification checkboxes ticked
- [x] Reviewer handoff prompt emitted
- [x] Code-reviewer agent has verified this phase
- [x] Review follow-ups reflected back into this plan file
- [x] Tests written and passing
- [x] Documentation updated
- [ ] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat(web): add /trade quote + pre-trade rule verdict`
- [ ] Phase marked complete

---

### Phase 3: Sign → verify → dry-run submit (broadcast wired but off)

**Risk:** high
**Mode:** hil
**Type:** mixed
**Success criteria:** From an allowed quote on `/trade`, the user clicks Approve, the wallet is prompted to sign the exact compiled v0 transaction from Phase 2 (the connected account's features are read: `signTransaction` is used, and `signAndSendTransaction` is detected and **refused** with its own message — it broadcasts from inside the wallet, bypassing `/api/swap/submit`'s verification and the `chain.broadcast` kill switch; see `.ai/decisions/swap-signing-and-submit.md`), the client posts the signed bytes to `/api/swap/submit`, and the server: verifies the intent is still `approved`/unexpired, hashes the signed bytes and confirms they match `tx_message_hash`, re-runs `evaluateTrade` (still allow?), records the signature, and — because `chain.broadcast` is seeded off — simulates via Helius instead of broadcasting, returning a "verified, ready to broadcast" result. This is the full mechanical pipeline exercised end to end for the first time, deliberately short of moving real funds (decision 14 — that's Phase 6).
**Commit message:** `feat(web): wire swap signing + submit verification, broadcast gated off`

**File changes:**

| Action | File | What changes |
|---|---|---|
| create | `apps/web/src/client/wallet/use-swap-signing.ts` | New signing hook, living in the deliberate wallet-lib containment boundary per `wallet-standard-ui-dependency.md`: reads `client.wallet.getState().connected.signer`, feature-detects `wallet.features`, signs the compiled message from `/api/swap/quote`, re-reads the connected address *after* the prompt and compares to what was quoted (per the account-switch pattern already used in `use-wallet-session.ts:208-232`) before submitting |
| modify | `apps/web/src/app/trade/trade-panel.tsx` | Wire the Approve button to `use-swap-signing`, call `/api/swap/submit` with signed bytes, render submitted/confirmed/failed/blocked states |
| create | `apps/web/src/server/swap/submit-service.ts` | Guarded transition `quoted/approved → signed` (per `.ai/patterns/guarded-state-transition.md`, `UPDATE ... WHERE status = 'approved' AND NOT expired RETURNING *`); **extracts the message from the signed transaction bytes** (strips the wallet's appended signature) and hashes *that* against `tx_message_hash` — never hashes the signed transaction as a whole; independently checks the compiled message's fee payer equals the session wallet's address; re-runs `evaluateTrade` against fresh state; transitions to `submitted`, records `trade.intent_signed` + `trade.intent_submitted` events **only on the branch where the guarded `UPDATE` actually returned a row** — a zero-row result is re-read and, if the intent is already `signed`/`submitted`/`confirmed` with a matching signature, treated as an idempotent replay (original response returned, no new events) rather than an error |
| create | `apps/web/src/server/chain/broadcast-transaction.ts` | `chain.broadcast`-gated Helius `sendTransaction` wrapper; when the flag is off, calls `simulateTransaction` instead and returns a `dryRun: true` result — same call site either way, so Phase 6 only has to flip the flag, not touch code |
| create | `apps/web/src/app/api/swap/submit/route.ts` | `POST`, same route conventions as Phase 2; rejects if `intent.wallet_id != session.walletId` (decision 13 defence-in-depth); on any verification failure, no broadcast, transition to `failed`, record `trade.intent_failed` |
| modify | `apps/web/src/server/flags/feature-flags.ts` callers, `apps/web/src/server/db/seed.ts` | Add `CHAIN_BROADCAST_FLAG = 'chain.broadcast'`, seeded `enabled: false` |

**Steps:**

- [x] Implement `use-swap-signing.ts` with explicit feature detection; never assume `signAndSendTransaction` exists
- [x] Wire trade-panel's Approve flow, including a clear "you're about to sign a real mainnet transaction" affordance (no devnet exists — decision context)
- [x] Implement `submit-service.ts`'s guarded transitions exactly per the pattern doc — no read-then-write; extract the message from signed bytes before hashing (never hash the signed tx as a whole); check fee payer == session wallet independently of the hash comparison; handle the zero-rows-returned case as an idempotent-replay check, not an automatic error
- [x] Implement `broadcast-transaction.ts` with the flag-gated simulate/send branch
- [x] Implement `/api/swap/submit/route.ts`
- [x] Add `chain.broadcast` flag + seed entry (off)

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `apps/web/src/server/swap/submit-service.test.ts` | Guarded transition rejects a non-`approved` or expired intent (zero rows returned → distinguished from a genuine reject); hash mismatch → reject, no state change; re-evaluation catching a since-changed allowance → reject; hash is computed on the message extracted from signed bytes and matches for a validly-signed tx (not the whole signed tx); fee-payer mismatch rejected even when the hash matches; **double-submitting the same intent + signature is idempotent** — second call returns the original result, does not re-fire `trade.intent_signed`/`trade.intent_submitted`, does not re-transition an already-terminal status |
| create | `apps/web/src/server/chain/broadcast-transaction.test.ts` | Flag off → simulate path only, no send call; flag on → send path (mocked) |
| create | `apps/web/src/app/api/swap/submit/route.test.ts` | Wallet-mismatch rejection, happy dry-run path, expired-intent rejection |
| create | `apps/web/src/client/wallet/use-swap-signing.test.ts` | Feature-detection branches (`signTransaction` vs `signAndSendTransaction` vs neither present → error state); post-signature address mismatch aborts submission |

**Verification:**

- [x] `pnpm test` passes
- [x] `pnpm typecheck` passes
- [ ] Manual (real wallet, mainnet, `chain.broadcast` still off): approve a quote, sign, confirm submit returns a dry-run-verified result with no funds moved, confirm the intent row reaches `submitted` with `signature` recorded but nothing broadcast — _**NOT VERIFIED**: no funded/signing wallet available; orchestrator declined the manual pass. Automated tests + code review are the only proof for this phase._
- [ ] Manual: attempt to submit an intent belonging to a different wallet (e.g. after account switch) → confirm server-side 403, not just a client-side block — _**NOT VERIFIED**: no funded/signing wallet available; orchestrator declined the manual pass. Automated tests + code review are the only proof for this phase._

**Kill switch / flag / instrumentation:**

- Flag: `chain.broadcast`, seeded `enabled: false`
- Events: `trade.intent_signed`, `trade.intent_submitted`, `trade.intent_failed`
- Fail-closed: any submit-time re-evaluation failure blocks broadcast entirely, not just warns

**Phase review:**

- [ ] All Steps and Verification checkboxes ticked
- [x] Reviewer handoff prompt emitted
- [x] Code-reviewer agent has verified this phase
- [x] Review follow-ups reflected back into this plan file
- [x] Tests written and passing
- [x] Documentation updated
- [ ] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat(web): wire swap signing + submit verification, broadcast gated off`
- [ ] Phase marked complete

---

### Phase 4: Intent lifecycle — reservation, expiry, account-switch invalidation

**Risk:** medium
**Mode:** afk
**Type:** backend
**Success criteria:** Requesting a second quote while a prior one is still live (`approved`/`signed`/`submitted`, unexpired) correctly reserves the first quote's notional against the rolling allowance — a second concurrent quote attempt that would push the wallet over a limit is blocked even though no `trades` row exists yet for the first one. Requesting a new quote atomically expires the wallet's prior live intent (guarded transition) and releases its reservation. Switching the connected wallet account invalidates all live intents for the old wallet and `/trade` shows a reset notice instead of a stale quote.
**Commit message:** `feat(web): reserve allowance against live trade intents with a DB-level concurrency guarantee`

_Note added during revision:_ the single-live-intent invariant is enforced at the **database level** (a partial unique index plus a wallet-row lock), not just by application-code filtering — two concurrent quote requests for the same wallet can never both end up with a live row, and an abandoned (never-revisited) quote is actively reaped rather than silently lingering.

**File changes:**

| Action | File | What changes |
|---|---|---|
| create | `apps/web/src/server/db/migrations/00xx_*.sql` | Partial unique index migration, generated via `pnpm db:generate` after the schema change below |
| modify | `apps/web/src/server/db/schema.ts` | Add a partial unique index on `trade_intents.wallet_id`, restricted to the **quote-slot** statuses (`quoted`/`approved`) via a `sql` predicate on `.where(...)` — the first partial index in this codebase; the predicate can only reference `status` (Postgres requires partial-index predicates to be immutable, so `expires_at > now()` cannot appear here) — see the concurrency-guarantee rule above for the exact expression. A separate, wider status set (`quoted`/`approved`/`signed`/`submitted`) governs allowance *reservation*, not this index — see `.ai/decisions/live-intent-reservation-vs-quote-slot.md` |
| create | `apps/web/src/server/swap/intent-lifecycle.ts` | `reapExpiredIntents(walletId, executor)` — guarded `UPDATE ... SET status='expired' WHERE wallet_id=$1 AND status IN (live) AND expires_at <= now() RETURNING id`; deliberately append-only (`UPDATE`, not the `DELETE` pattern `challenge-reaper.ts`/`login-attempt-reaper.ts` use), since intents must stay in the audit trail. `expireAndReserveLiveIntent(walletId, insertFn, executor)` — wraps a wallet-row lock (`SELECT ... FROM wallets WHERE id=$1 FOR UPDATE`, the same convention `reconcile-wallet.ts` already uses), a guarded unconditional expire of the prior live intent, and the caller's insert, all in one `getDb().transaction()`. `loadLiveIntentUsd(walletId, windowHours, asOf, executor)` — calls `reapExpiredIntents` first, then sums remaining live intents' `usd_value` via `addUsd`/`sumTradeUsd` from `packages/rules/src/evaluate.ts` (reused, not reimplemented) |
| modify | `apps/web/src/server/swap/quote-service.ts` | Move the `trade_intents` insert (built in Phase 2) inside `expireAndReserveLiveIntent`'s locked transaction; fold `loadLiveIntentUsd`'s sum into the `windowedHistory` passed to `evaluateTrade` (UNION of persisted trades + live intents, excluding any intent whose signature already landed in `trades`); record `trade.intent_expired` when a prior intent is actually expired this way |
| modify | `apps/web/src/client/wallet/account-switch.ts` (or its server-side counterpart in `session.ts`) | On confirmed account switch, expire the old wallet's **quote-slot** intent unconditionally (not just time-expired ones) — reuse the guarded expire helper, called from wherever session revocation already happens. A `signed`/`submitted` intent is deliberately left alone: it keeps reserving allowance against the old wallet until Phase 5 reconciliation resolves it — see `.ai/decisions/live-intent-reservation-vs-quote-slot.md` |
| modify | `apps/web/src/app/trade/trade-panel.tsx` | Render a reset notice when the account-switch watcher fires mid-session (reuses the existing `wallet-account-watch.ts` subscription) |

**Steps:**

- [x] Add the partial unique index to `schema.ts`, generate + review + apply the migration
- [x] Implement `reapExpiredIntents` (guarded `UPDATE`, not delete) in `intent-lifecycle.ts`
- [x] Implement `expireAndReserveLiveIntent`, wrapping the wallet-row-lock + guarded-expire + insert in one transaction, per the concurrency-guarantee rule in the mechanisms section above
- [x] Implement `loadLiveIntentUsd`, calling the reaper first and summing via `addUsd`/`sumTradeUsd` (not new decimal arithmetic)
- [x] Wire live-intent reservation into the allowance calculation used by `quote-service.ts`
- [x] Move Phase 2's plain intent insert into `expireAndReserveLiveIntent`'s locked transaction
- [x] Wire expire-on-account-switch into the existing revoke path (expire the old wallet's quote-slot intent unconditionally, not just time-expired ones; a `signed`/`submitted` intent survives the switch and keeps reserving allowance until Phase 5)
- [x] Surface the reset notice in `trade-panel.tsx`

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `apps/web/src/server/swap/intent-lifecycle.test.ts` | `reapExpiredIntents` only expires the target wallet's time-expired live intents, leaves others untouched, is a no-op on already-terminal rows; `expireAndReserveLiveIntent` under simulated concurrent calls — two overlapping attempts never both leave a live row (serialized by the wallet lock), and the partial unique index rejects an insert made without going through the lock; `loadLiveIntentUsd` excludes intents whose signature is already in `trades` (no double count) and uses `addUsd`/`sumTradeUsd`, not ad hoc arithmetic |
| modify | `apps/web/src/server/swap/quote-service.test.ts` | New case: second quote request reflects reduced headroom from the first live intent; requesting the second expires the first; an abandoned (time-expired but never revisited) intent is reaped before the sum is taken, not left stale |
| modify | `apps/web/src/client/wallet/account-switch.test.ts` | New case: switch triggers unconditional intent expiry alongside existing session revocation |

**Verification:**

- [x] `pnpm test` passes
- [x] `pnpm typecheck` passes
- [ ] Manual: request quote A near a limit's headroom, then request quote B before approving A → confirm B correctly sees A's reservation, and A is now `expired` in the DB — _**NOT VERIFIED**: no funded/signing wallet; orchestrator declined the manual pass. Automated tests + code review (incl. mutation check) are the only proof._
- [ ] Manual: switch the connected wallet account mid-quote → confirm `/trade` shows the reset notice and the old intent is `expired` — _**NOT VERIFIED**: no funded/signing wallet; orchestrator declined the manual pass. Automated tests + code review (incl. mutation check) are the only proof._

**Kill switch / flag / instrumentation:**

- No new flag — this phase hardens behavior gated by `trade.terminal` from Phase 2; reuses `chain.broadcast`'s existing gate for anything downstream
- Events: `trade.intent_expired`

**Phase review:**

- [ ] All Steps and Verification checkboxes ticked
- [x] Reviewer handoff prompt emitted
- [x] Code-reviewer agent has verified this phase
- [x] Review follow-ups reflected back into this plan file
- [x] Tests written and passing
- [x] Documentation updated
- [ ] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat(web): reserve allowance against live trade intents, expire on new quote and account switch`
- [ ] Phase marked complete

---

### Phase 5: Reconcile intent → trade row

**Risk:** medium
**Mode:** afk
**Type:** backend
**Success criteria:** Once a submitted intent's signature lands on chain and the existing Helius-driven `reconcileWallet` job (built in Phase 0) picks it up, the resulting `trades` row is linked back to the `trade_intents` row that produced it (not treated as an anonymous external trade), and the intent transitions to `confirmed` or `failed` accordingly. `/trade` reflects that status flip back to the user, and the dashboard shows the trade tagged with its origin (routed through us vs. observed elsewhere) instead of looking identical to an external one.
**Commit message:** `feat(web): link reconciled trades back to their originating trade intent`

**File changes:**

| Action | File | What changes |
|---|---|---|
| create | `apps/web/src/server/db/migrations/00xx_*.sql` | Add nullable `trade_intent_id uuid` FK on `trades`, generated via `pnpm db:generate` |
| modify | `apps/web/src/server/db/schema.ts` | Add the `trade_intent_id` column + index |
| modify | `apps/web/src/server/chain/reconcile-wallet.ts` | When inserting a new `trades` row, look up a matching `trade_intents` row by `(wallet_id, signature)`; if found, set `trade_intent_id` and, in the same transaction, guarded-transition the intent to `confirmed`; if the transaction failed on chain, transition to `failed` instead. Existing dedup (`ON CONFLICT (wallet_id, signature) DO NOTHING RETURNING`) is unaffected — this only adds the linkage on the insert path |
| modify | `apps/web/src/app/trade/trade-panel.tsx` (or the page, via polling) | Show intent status progression (submitted → confirmed/failed) reusing the existing 15s poll pattern from `dashboard-panel.tsx` |

**Steps:**

- [x] Add `trade_intent_id` column + migration
- [x] Extend `reconcile-wallet.ts`'s insert path to look up and link the originating intent, guarded-transitioning it
- [x] Record `trade.intent_confirmed` / `trade.intent_failed` from the reconcile path
- [x] Add status polling to the trade page
- [x] **Required:** a blockhash-expiry-driven `submitted → failed` sweep (guarded `UPDATE`, same append-only convention as `reapExpiredIntents`) for a `submitted` intent whose transaction never lands on chain at all — rationale: without this, a broadcast that silently never confirms keeps reserving allowance forever, since reconciliation only ever resolves a signature that *did* land (see `.ai/decisions/live-intent-reservation-vs-quote-slot.md`)

**Tests:**

| Action | File | What it covers |
|---|---|---|
| modify | `apps/web/src/server/chain/reconcile-wallet.test.ts` | New cases: a reconciled trade whose signature matches a live intent gets linked + intent confirmed; a signature with no matching intent (external trade) is unaffected; a failed on-chain transaction confirms the intent as `failed` |

**Verification:**

- [x] `pnpm test` passes
- [x] `pnpm typecheck` passes
- [ ] Manual: after Phase 3's dry-run submit completes for a real signature (if one was actually sent — otherwise defer this specific check to Phase 6), confirm the reconcile job links it and the terminal shows the status flip — _**NOT VERIFIED**: no real signature was ever broadcast (Phase 3 left broadcast gated off), so there is nothing on chain to reconcile. Deferred to Phase 6 as the phase itself anticipated. Automated tests + code review are the only proof._

**Kill switch / flag / instrumentation:**

- No new flag — rides on `chain.helius_reconcile` (existing) and `trade.terminal`
- Events: `trade.intent_confirmed`, `trade.intent_failed` (from the reconcile path, distinct from Phase 3's submit-time `trade.intent_failed` on verification failure — same event type, different `payload.stage`)

**Review follow-ups (post-review additions):**

Initial review of `770ccb0` returned **red**; re-review after fixes returned **green**. Landed beyond the original plan:

- `GET /api/swap/intent/[id]` (new route) — drives resolution for the polled intent, since `reconcileWallet()` was otherwise unreachable from `/trade` and the required sweep would never have fired for a user who stays on the terminal. Baseline-incomplete wallets skip the attempt; the rest is bounded by an 8s deadline emitting `trade.intent_poll_resolve_timed_out`.
- `resolveIntentOutcome()` — separates landed-but-excluded-from-accounting (`lst_swap` / `wrap_unwrap` / `missing_block_time` → `confirmed`) from genuine on-chain failure (`no_net_change` / `pure_receive` / `pure_send` → `failed`). No new intent status was introduced.
- The sweep covers stranded `signed` intents too, not just `submitted` (a crash between `transitionToSigned` and `transitionFromSigned` otherwise reserved allowance permanently).
- Dashboard trades are badged "Routed through us" / "Observed elsewhere" off `trade_intent_id`.

**Accepted gap (documented in `.ai/decisions/live-intent-reservation-vs-quote-slot.md`):** a transaction landing *after* its intent was swept to `failed` cannot relink, so it renders as "Observed elsewhere" — a self-routed trade misreported as external. Allowance is unaffected (counted once, no double-spend). Widening `RECONCILABLE_INTENT_STATUSES` to include `failed` was rejected as riskier than the gap.

**Open, deferred by the orchestrator:** `/trade`'s terminal-failure copy is a hedge ("either it never landed on chain, or it landed without completing the swap") because the poll response carries no `reason` field to distinguish the two cases.

**Phase review:**

- [ ] All Steps and Verification checkboxes ticked
- [x] Reviewer handoff prompt emitted
- [x] Code-reviewer agent has verified this phase
- [x] Review follow-ups reflected back into this plan file
- [x] Tests written and passing
- [x] Documentation updated
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat(web): link reconciled trades back to their originating trade intent`
- [x] Phase marked complete

---

### Phase 6: Dry-run pass, then one live tiny swap

**Risk:** high (real funds)
**Mode:** hil
**Type:** security
**Success criteria:** A structured dry-run pass (chain.broadcast still off) exercises representative cases — stable→SOL, SOL→an asset in each tier, and a deliberately-over-limit case — confirming compile+sign+simulate succeeds for the allowed cases and the blocked case is stopped pre-signature. Then, and only then, `chain.broadcast` is flipped on for one real $1-5 swap from a throwaway wallet, end to end: quote → sign → submit → broadcast → confirm on chain → Phase 5's reconciliation links it → tier classification, lot-matching, and rolling-loss all reflect the real trade correctly. This closes the on-chain verification gap Phase 0 explicitly deferred to this phase.
**Commit message:** `test(web): record dry-run + live swap verification results for Phase 1`

**File changes:**

| Action | File | What changes |
|---|---|---|
| create | `apps/web/scripts/dry-run-swap-checklist.md` (or equivalent lightweight checklist artifact) | The concrete case list run manually this phase, with pass/fail recorded, so the verification is reproducible and auditable rather than tribal knowledge |
| modify | any file where a real bug surfaces during dry-run/live testing | Fixes discovered by exercising real chain data for the first time (CU estimation off in practice, decimals lookup wrong for an obscure mint, etc.) — expect this list to be non-empty; each fix gets its own focused diff, not a grab-bag |

**Steps:**

- [ ] Run the dry-run pass across the representative cases with `chain.broadcast` off; record results
- [ ] Fix anything broken by real Jupiter/chain data (expected — this is the first time `/build`'s actual response shape, real ALT accounts, and real CU consumption are exercised, not mocks)
- [ ] Flip `chain.broadcast` on (config change, not a code change) for a single throwaway wallet
- [ ] Execute one real $1-5 swap through `/trade` end to end
- [ ] Confirm reconciliation (Phase 5) links it, tier classification is correct for the traded asset, lot-matching updates correctly, and — if the constitution being tested has a loss limit enabled — a subsequent rolling-loss evaluation reflects it
- [ ] Flip `chain.broadcast` back off afterward unless the user explicitly wants it left on

**Tests:**

No automated tests beyond what Phases 2-5 already cover — justified because: this phase's purpose *is* the manual verification step (real wallet, real chain, real money) that automated tests cannot substitute for; any bug found here gets fixed with its own targeted unit/integration test in the relevant module from Phases 2-5, not a new test file specific to this phase.

**Verification:**

- [ ] All dry-run cases pass (allowed cases simulate cleanly; blocked case never reaches signing)
- [ ] Live tiny swap completes and is correctly reconciled, classified, and lot-matched
- [ ] `pnpm test` still passes after any fixes made during this phase

**Kill switch / flag / instrumentation:** `chain.broadcast` is the control surface exercised directly by this phase — its whole purpose is proving that flag is safe to flip.

**Phase review:**

- [ ] All Steps and Verification checkboxes ticked
- [ ] Reviewer handoff prompt emitted
- [ ] Code-reviewer agent has verified this phase
- [ ] Review follow-ups reflected back into this plan file
- [ ] Documentation updated
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `test(web): record dry-run + live swap verification results for Phase 1`
- [ ] Phase marked complete

---

### Phase 7: Final Verification

**Mode:** hil

**Overall success criteria:**

- A user can visit `/trade`, request a quote, see an accurate live rule verdict, get blocked pre-signature when over a limit, and — when allowed — sign, submit, and have a real swap broadcast, confirmed, and correctly reconciled back into their trade history with the right tier/classification/loss-limit accounting.
- No route trusts client-supplied wallet identity over `resolveSession()`.
- No path falls through to "allow" on a dependency failure anywhere in the quote or submit pipeline.
- Every kill switch (`trade.terminal`, `jupiter.swap_build`, `chain.broadcast`) is flippable at runtime with no deploy and defaults to the state specified in its phase — confirmed by construction, since `isFeatureEnabled` reads the `feature_flags` table (existing Phase 0 infra), never an env var or compiled constant.

**Steps:**

- [ ] Every preceding phase's Steps/Verification/Phase review checkboxes are ticked in this plan file
- [ ] Reviewer handoff prompt emitted, scoped to the entire Phase 1 change end-to-end
- [ ] Code-reviewer agent reviews the entire change end-to-end — explicit focus: guarded-state-transition correctness on every `trade_intents` transition, fail-closed behavior on every external dependency (Jupiter build, Helius simulate/broadcast, pricing, classification), no float money-math, allowance reservation correctly UNIONs persisted trades and live intents with no double count, account-switch invalidation actually reaches the server side (not just client display)
- [ ] Any changes from the final review reflected back into this plan file
- [ ] `pnpm test` passes workspace-wide
- [ ] `pnpm typecheck` passes workspace-wide
- [ ] No CLAUDE.md invariants violated (packages/rules stays zero-I/O; every kill switch/flag/instrumentation present per feature; rule state append-only)
- [ ] Feature tested manually end-to-end on a real wallet: golden path, blocked-attempt path, account-switch mid-quote, Helius-outage fail-closed check, expired-quote resubmission attempt
- [ ] Overall success criteria met
- [ ] All phase checkboxes above are ticked

## Documentation

| Change | Documentation location |
|---|---|
| `/trade` route + server relay architecture | `apps/web/src/app/trade/README.md` (new, if this project's convention is per-route READMEs — otherwise fold into `apps/web/README.md`) |
| `trade_intents` table + guarded transitions | `.ai/decisions/` (see Knowledge Base Impact) |
| `jupiter-client.ts` / swap build integration | `apps/web/src/server/swap/README.md` (new) |
| `jupiter-tokens.ts` base URL migration | `apps/web/src/server/chain/README.md` (existing, update) |
| New feature flags | wherever flags are enumerated today (`.ai/decisions/feature-flags-and-kill-switches.md`) |

## Knowledge Base Impact

| `.ai/` artifact | Action | What it captures |
|---|---|---|
| `decisions/trade-intent-server-relay.md` | create | The server-relay architecture: `/api/swap/quote` builds+evaluates+assembles, wallet signs, `/api/swap/submit` re-verifies+broadcasts; why the server (not the client) assembles the unsigned tx; why re-evaluation happens again at submit time; the compiled-message-hash verification (never hash the signed tx); the single-live-intent DB-level guarantee (partial unique index + wallet-row lock) and why a read-then-write check isn't sufficient; the append-only expiry reaper vs. the existing delete-based reapers; submit idempotency |
| `decisions/pre-trade-slippage-pricing.md` | create | Why acquisitions/notional price off the deterministic sold leg while disposals price off `otherAmountThreshold`, not the optimistic quote — the worst-case-per-limit-type rule and why a single blanket rule (e.g. always using `otherAmountThreshold`) would be wrong for acquisitions |
| `decisions/pre-trade-fail-closed-folding.md` | create | The fold rule (any violation → block; dependency-failure `unevaluable` → block; `rolling_loss_usd` never structurally-unevaluable for the trade's own unknown loss) and why — this is the rule that keeps loss-limit users from being bricked |
| `decisions/no-platform-fee.md` | create | Why `platformFeeBps`/`feeAccount` are never set; what would need to change if this is revisited |
| `decisions/jupiter-swap-v2-build.md` | create | `/build`'s one-shot quote+instructions shape, mainnet-only constraint, the documented error-shape gaps (no confirmed balance pre-check, only `400 {error}` documented), CU-limit-via-simulation requirement, and the `blockhashWithMetadata.lastValidBlockHeight`-derived expiry (no separate quote TTL exists) |
| `decisions/chain-data-source.md` | update | Add: Helius RPC is now also used for pre-trade `simulateTransaction` (CU estimation, dry-run verification) and ALT (address lookup table) resolution, not just post-trade `getTransactionsForAddress` — both reuse the existing `chain.helius` flag and fail-closed treatment |
| `decisions/asset-tier-by-market-cap.md` | update | Add: pre-trade classification now also calls `classifyToken()` live (not just during reconciliation), same fail-closed `MICRO_CAP` default applies |
| `decisions/feature-flags-and-kill-switches.md` | update | Add `trade.terminal`, `jupiter.swap_build`, `chain.broadcast` to the flag inventory |
| `decisions/observability-stack.md` | update | Add the new intent-keyed event family (`trade.intent_created`, `rule.pre_trade_decision`, `trade.intent_signed`, `trade.intent_submitted`, `trade.intent_confirmed`, `trade.intent_failed`, `trade.intent_expired`) and its relationship to the existing `rule.decision_recorded` (deliberately not merged — see fold-rule doc) |
| `decisions/ui-framework.md` | update | Note the theme fix (`.dark` on `<html>`) and the new primitives added in Phase 1 |
| `architecture.md` | update | The pre-trade interception path is now built, not just the target-shape diagram — update the data-flow description to reflect `/trade` as the first real enforcement surface |
| `index.md` | update | Add rows for all newly created `.ai/decisions/` docs and the new `apps/web/src/server/swap/` module |

## Tests

| Phase | Logic under test | Test file |
|---|---|---|
| Phase 1 | (none — presentational only) | — |
| Phase 2 | CU-limit computation, instruction assembly | `apps/web/src/server/swap/assemble-transaction.test.ts` |
| Phase 2 | Fold rule, intent write, event recording | `apps/web/src/server/swap/quote-service.test.ts` |
| Phase 2 | Jupiter build client fail-closed behavior | `apps/web/src/server/swap/jupiter-client.test.ts` |
| Phase 2 | Quote route gating/errors/happy path | `apps/web/src/app/api/swap/quote/route.test.ts` |
| Phase 3 | Guarded submit transitions, hash/re-evaluation checks | `apps/web/src/server/swap/submit-service.test.ts` |
| Phase 3 | Broadcast flag-gated simulate/send branching | `apps/web/src/server/chain/broadcast-transaction.test.ts` |
| Phase 3 | Submit route gating/errors | `apps/web/src/app/api/swap/submit/route.test.ts` |
| Phase 3 | Wallet signing feature detection, post-sign address check | `apps/web/src/client/wallet/use-swap-signing.test.ts` |
| Phase 4 | Intent expiry, live-intent allowance sum, no double-count | `apps/web/src/server/swap/intent-lifecycle.test.ts` |
| Phase 4 | Reservation reflected in a second quote; account-switch expiry | `apps/web/src/server/swap/quote-service.test.ts` (extended), `apps/web/src/client/wallet/account-switch.test.ts` (extended) |
| Phase 5 | Reconcile linking a trade back to its intent | `apps/web/src/server/chain/reconcile-wallet.test.ts` (extended) |
| Phase 6 | (manual verification phase — no new test files; bugs found get tests in their owning module) | — |

## Human Summary

Phase 0 built a system that watches trades happen and scores them after the fact. Phase 1 builds the part that actually gets in the way: a `/trade` page where you pick a swap, and before your wallet ever sees a signature request, the same rule engine that scores your history checks this trade too — and blocks it if it would blow a limit.

The phases build up in a deliberately safe order. First (Phase 1) a small housekeeping fix so the new form doesn't render on a broken theme. Then (Phase 2) the quote-and-verdict experience — you can see yourself get blocked, but nothing can be signed yet. Then (Phase 3) real wallet signing gets wired in, but the actual broadcast-to-the-network step stays behind a kill switch that starts off, so the full pipeline runs against real mainnet data without risking real money. Phase 4 closes a subtle gap: if you request two quotes back to back, the first one has to actually reserve your allowance so you can't double-spend it by racing yourself. Phase 5 makes sure a trade you make through us gets correctly linked back to the intent that created it, instead of looking like a random external trade. Only in Phase 6 does the broadcast switch actually get flipped — first for a rehearsal (simulate everything, send nothing), then for one real, small, throwaway-wallet swap that proves the whole thing works against real chain data, closing the verification gap Phase 0 deliberately left open for this exact phase.

The two real risk areas are the money math (allowance reservation must never let a user double-spend their own limit by racing two quotes) and the trust boundary (the server must always be the one deciding what's signed and what's broadcast — the client is never trusted to report its own success). Both get their own dedicated phase and their own kill switch rather than being folded into the "happy path" work.
