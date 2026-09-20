# DegenCage

**A self-imposed trading discipline platform for Solana.**

You write your trading rules while you're calm. DegenCage enforces them when you're not.

Set a *trading constitution* — daily spend limits, per-asset-tier caps, rolling loss limits — and the
platform creates friction when emotional future-you tries to break it: trades routed through us are
**blocked before you sign**, loosening a rule is **timelocked**, and trades you made elsewhere still
show up in your feed. *"We saw that."* Accountability, not punishment.

**Non-custodial.** We never hold your keys and never take custody. You sign every transaction. You
can always bypass us by going to Jupiter directly — that's expected, and it's the point: the cage is
one you chose to walk into.

**No platform fee.** Swaps routed through DegenCage never carry a fee account or `platformFeeBps`.
There is a test asserting it.

---

## How it works

```
 ┌── you, calm ──────────────┐          ┌── you, tilted ─────────────────────┐
 │  author a constitution    │          │  "just one more 5k ape"            │
 │  commit it                │          │                                    │
 │  wait 20 min              │  ─────▶  │  /trade → quote → RULE ENGINE      │
 │  activate                 │          │     ├─ allowed → you sign → chain  │
 └───────────────────────────┘          │     └─ violation → BLOCKED         │
                                        └────────────────────────────────────┘
                                                        │
        traded somewhere else? ────────────────────────▶ reconciliation
        (Helius wallet history)                          "we saw that" feed
```

Three things make the commitment real:

1. **A commitment window.** A new constitution isn't live the second you write it — you commit, then
   wait 20 minutes (measured by the server's clock, not yours) before it activates.
2. **Asymmetric edits.** Tightening a limit applies *instantly*. Loosening one is rate-limited and
   sits behind a **48-hour timelock**. Rule state is append-only — a limit change is history, never
   an in-place overwrite.
3. **Fail closed, everywhere.** If a price feed, chain read, or rule evaluation is unavailable or
   stale, the trade is **blocked**. There is no error path that falls through to "allow".

### Rules you can set today

| Rule | What it caps |
|---|---|
| `daily_notional_usd` | Total USD traded in a rolling window |
| `asset_tier_acquisition_usd` | USD spent *acquiring* a given market-cap tier |
| `rolling_loss_usd` | Realized losses (FIFO lot-matched) in a rolling window |

Asset tiers are resolved by market cap: `STABLE`, `LARGE_CAP`, `MID_CAP`, `SMALL_CAP`, `MICRO_CAP`.
A token we can't classify is treated as `MICRO_CAP` — fail closed, not fail open.

All windows are **rolling**, not calendar days. Money is exact decimal (`BigInt` under the hood),
never floats. A trade we genuinely can't price is `null` — never silently `0`.

---

## Using it

> **Desktop only** today, and you'll need a Solana wallet extension that supports `signTransaction`.
> Wallets that only offer `signAndSendTransaction` are **refused on purpose** — they'd let a
> transaction reach the chain without passing the submit-time gate or the kill switch.

1. **Connect** at `/connect`. One Sign In With Solana signature — no transaction, no approval, no
   spend. On first connect we quietly backfill 90 days of your wallet history as a *baseline*. That
   history is never evaluated and never shows up as violations; it just gives the engine a starting
   position so the realized-loss math is honest.
2. **Author your constitution** at `/constitution`. Pick your limits while you're thinking clearly.
3. **Commit**, then wait out the 20-minute window, then **activate**. Until a constitution is
   active, trading through DegenCage is blocked.
4. **Trade** at `/trade`. Enter an amount and an output token. Before you're ever asked to sign:
   - we fetch one Jupiter quote,
   - price it at its **worst case** for each limit type (not its rosiest),
   - classify the token's tier,
   - run the rule engine.

   If anything violates — or anything is *unevaluable* — you get a block with the reason, and no
   signature prompt. If it passes, you sign the exact message we hashed, and submit re-verifies that
   hash, re-checks the fee payer is you, and re-evaluates against fresh state before anything moves.
5. **Watch yourself** at `/dashboard`. Live remaining allowances, plus the violations feed for trades
   you made on other apps. Your wallet reconciles when you open the app.
6. **Change your mind** at `/constitution/edit`. Tighter, now. Looser, in 48 hours.

---

## Quick start

**Requires** Node >= 22 and pnpm 11.5.2. Database is Postgres (we use [Neon](https://neon.tech)).

```bash
pnpm install
cp .env.example .env      # then fill it in — see below
pnpm db:migrate
pnpm db:seed              # seeds feature flags (idempotent)
pnpm dev                  # http://localhost:3000
```

### Environment

| Variable | | Purpose |
|---|---|---|
| `DATABASE_URL` | required | Direct Neon connection. Used by `db:generate` / `db:migrate` only. |
| `DATABASE_URL_POOLED` | required | Pooled runtime connection. The app throws without it. |
| `SIWS_DOMAIN` | required | Domain the Sign In With Solana message binds to (`localhost:3000` in dev). Config only — never read from a request header. |
| `JUPITER_API_KEY` | required for `/trade` | Quotes (`/swap/v2/build`) and token metadata (`/tokens/v2/search`). Unset ⇒ every quote is blocked. |
| `HELIUS_API_KEY` | required for chain features | Wallet history, simulation, broadcast. Unset ⇒ no reconciliation. |
| `BIRDEYE_API_KEY` | optional | Price fallback for alt↔alt swaps. Unset ⇒ those trades are unpriced. |
| `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` | optional | Error tracking (server / browser). |
| `LOG_LEVEL` | optional | pino level, default `info`. |
| `ADMIN_METRICS_SECRET` | optional | Gates `/admin/*`. **Minimum 32 characters** — anything shorter is treated as unset and every admin surface 404s. |

### Scripts

```bash
pnpm dev          # Next.js dev server
pnpm build        # production build (standalone output)
pnpm test         # vitest run — rule engine + server modules
pnpm typecheck    # tsc --noEmit across the workspace
pnpm db:generate  # drizzle-kit generate (after a schema change)
pnpm db:migrate   # apply migrations
pnpm db:seed      # upsert feature-flag rows
```

---

## Status

Roadmap Phase 0 (commitment mechanism) and Phase 1 (Jupiter terminal) are merged. Concretely:

**Working:** SIWS auth · constitution author → commit → activate · the three limit rules · asset-tier
classification · Helius reconciliation with swap derivation from balance deltas · FIFO realized-loss
matching · the discipline dashboard and violations feed · timelocked constitution edits · pre-trade
enforcement on `/trade` through quote → block-or-sign → verified submit.

**Not yet verified:** no DegenCage-built transaction has ever been broadcast to chain. The
`chain.broadcast` kill switch has never been turned on — with it off (the shipped default), submit
*simulates* the signed transaction and reports "verified, ready to broadcast". The live
broadcast/confirm path has tests and review behind it, not a mainnet signature. Treat it as unproven.

**Not built:** cooldowns and time-of-day windows (named in the vision, not yet in the engine); a real
landing page (`/` is still a health panel); mobile.

### Kill switches

Every feature ships behind a runtime flag in the `feature_flags` table, flippable without a deploy,
read through a single fail-closed path. Three ship **off** deliberately: `trade.terminal`,
`jupiter.swap_build`, and `chain.broadcast` — the only flag that can move real money.

---

## Architecture

```
apps/web          Next.js 15 App Router — UI, route handlers, and all server-side I/O
  src/server/     db · auth (SIWS) · constitution · chain (Helius) · pricing · rules · swap ·
                  dashboard · flags · admin · metrics · feedback
  src/observability   pino logging, Sentry, behavioral events
packages/rules    @degencage/rules — the rule engine. Pure, I/O-free, no dependencies.
                  Constitution schema, evaluateTrade(), exact-decimal USD math.
```

The rule engine is deliberately isolated and side-effect free — there's a test that asserts it. It's
the part that *is* the product, so nothing else gets to reach into it.

**Stack:** Next.js 15 · React 19 · TypeScript · Drizzle ORM on Neon Postgres · `@solana/kit` (no
wallet-adapter) · Jupiter and Helius over hand-rolled clients · Tailwind 4 + shadcn · pino + Sentry ·
vitest.

Every rule evaluation, block, timelock transition, and detected external violation emits a structured
event carrying the inputs that produced it. That audit trail isn't instrumentation bolted on the side
— it's what the behavioral dashboard reads from.

Architecture notes, decision records, and patterns live in [`.ai/`](.ai/index.md) — start at
[`.ai/index.md`](.ai/index.md). Project conventions are in [`CLAUDE.md`](CLAUDE.md).

---

## Contributing

Read [`CLAUDE.md`](CLAUDE.md) first — it's the contract for how code lands here (thin entry points,
reuse before reinvent, observability and kill switches shipped *with* the feature, `.ai/` updated
alongside the code). Then run `pnpm test && pnpm typecheck` before you open anything.

---

**This is not financial advice, and DegenCage is not a safety net.** It's friction you chose. It can
be bypassed by design — by going to Jupiter, by another wallet, by turning it off. It only works if
you want it to.
