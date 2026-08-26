# Chain data: detecting trades and valuing them in USD

> **PERISHABLE RESEARCH — verified 2026-08-26. Re-check before relying on it.**
>
> Provider free-tier limits, credit/CU costs, rate limits, and endpoint hostnames rot
> fast. An earlier pass of this research was already wrong twice: it put Pyth's API-key
> requirement at 2026-07-31 (actually 2026-08-26) and understated Birdeye's free
> allowance by ~2.5x. Treat every number below as a starting point to verify, not a fact.
>
> Durable choices — which provider and why — live in `.ai/decisions/` and
> `plans/phase-0-commitment-mechanism.md`. This file holds only the perishable detail
> that would be expensive to re-derive mid-implementation.
>
> **Delete at Phase 0 closeout**, once the working code is the record of which
> endpoints are actually in use.

Research for Phase 0 "external violation detected". Verified against live docs on 2026-08-26.

---

## TL;DR

| Need | Recommendation | Free tier |
| ---- | -------------- | --------- |
| Trade history | **Helius `getTransactionsForAddress`** (RPC method, `transactionDetails: "full"`) | 1M credits/mo, 10 req/s — ~10M txs/mo |
| Swap extraction | **Derive net balance deltas** from `meta.pre/postTokenBalances` + native lamport delta. Do *not* decode DEX instructions. | included |
| Cursor | Per-wallet `reconciled_through_slot`, replayed with `slot: {gt: N}` + `sortOrder: "asc"` + `commitment: "finalized"` | included |
| USD @ occurred_at | **Binance `/api/v3/klines` 1m candles** for SOL/BTC/ETH majors (see §4 correction); **Birdeye `historical_price_unix`** for long-tail mints; price the *known* leg only | Binance: keyless, free, unlimited. Birdeye: 30k CU/mo, 1 rps, **6 CU/call ≈ 5k lookups/mo** |
| Token tier | Curated mint allowlist + Jupiter Tokens v2 `verified` tag as a signal. "Memecoin" is a judgment call. | Jupiter lite-api free |

---

## 1. Fetching swap history

### The reframe that matters

We do **not** need "parsed swaps". We need *what left the wallet and what entered it, and its USD value*. Those are two different problems and only the second is hard.

A Solana transaction's `meta` carries `preBalances`/`postBalances` (lamports, indexed by account key) and `preTokenBalances`/`postTokenBalances` (SPL, with `mint`, `owner`, `uiTokenAmount.amount` as a **string** of base units, and `decimals`). Netting those per-owner gives token-in / token-out / amounts for the wallet, **regardless of which DEX, aggregator, or launchpad routed it**. Jupiter, Raydium, Orca, Meteora, pump.fun, a brand-new AMM launched tomorrow — all identical to this approach.

Instruction decoding, by contrast, is a permanent maintenance treadmill: every new program needs a new parser, and every parser vendor's coverage lags. That treadmill is exactly what killed Helius's own Enhanced Transactions product (see below).

Heuristic to call a tx a "swap": after netting, the wallet has **at least one negative delta and at least one positive delta** across {native SOL, SPL mints}, ignoring the fee-only lamport change. One-sided deltas are deposits/withdrawals/airdrops, not trades.

Known imprecision of this approach, accept and document:
- Multi-leg transactions (A→B→C in one tx) collapse to A→C. For allowance accounting this is arguably *more* correct than counting both legs.
- A tx that both swaps and transfers nets the two together.
- Wrap/unwrap of SOL↔wSOL shows as a delta pair and must be excluded (same economic asset).
- Rent-exempt lamports for opening/closing ATAs perturb the native delta by ~0.00204 SOL. Threshold it.

### Helius `getTransactionsForAddress` — the recommendation

Helius-native RPC method, the documented replacement for Enhanced Transactions for "history and backfill".

Request params (all confirmed from docs):
- `address` (base58)
- `transactionDetails`: `"signatures"` (default) or `"full"` — full returns up to 1,000 txs
- `sortOrder`: `"asc"` | `"desc"` (default desc)
- `limit`: 1–1,000 (default 1,000)
- `paginationToken`: opaque cursor, format `"slot:position"`
- `commitment`: `"finalized"` | `"confirmed"`
- `encoding`: `json` | `jsonParsed` | `base64` | `base58`
- `maxSupportedTransactionVersion: 0` — **required**, or every versioned tx (i.e. every Jupiter route) errors out
- Filters: `blockTime` / `slot` / `signature` with `gte,gt,lte,lt,eq`; `status: succeeded|failed|any`; `tokenAccounts: none|balanceChanged|all`; `tokenTransfer: {with, direction, mint, amount}`

Why it wins:
- **`tokenAccounts: "balanceChanged"` returns `pre/postTokenBalances` inline** — the docs state you can compute token balance changes "without any follow-up call". One request replaces the `getSignaturesForAddress` → N× `getTransaction` fan-out entirely.
- **Server-side `slot` / `blockTime` range filters.** This is the feature that makes the `reconciled_through` cursor cheap: resume is a filter, not a scan.
- **Unlimited mainnet lookback.** (Devnet is 2 weeks. Token-account metadata only after slot 111,491,819 / Dec 2022 — irrelevant for us.)
- `status: "succeeded"` filter — failed txs never spent an allowance, drop them at the edge.
- Cheap: 10 credits per 100 returned full txs, 10-credit minimum. 1M free credits ≈ 10M transactions/month.

### Alternatives, and why they lose

**Helius Enhanced Transactions** (`GET /v0/addresses/{address}/transactions`) — *deprecated, maintenance mode, no new parser types.* It genuinely does give parsed swaps: `type: "SWAP"` with an `events.swap` object carrying `nativeInput`, `nativeOutput`, `tokenInputs[]`, `tokenOutputs[]` (each with `userAccount`, `tokenAccount`, `mint`, `rawTokenAmount`), `nativeFees`, `tokenFees`, `innerSwaps`. Pagination is `before-signature` / `after-signature`, max `limit` 100. Costs **100 credits/call** (10× the modern method for 1/10th the page size = 100× worse) and free tier caps Enhanced APIs at **2 req/s**. Building Phase 0 on a deprecated endpoint whose value-add we can derive ourselves is the wrong trade. Successor is "Parsed Events"; worth a look in Phase 4 but not load-bearing.

**Helius `getTransfersByAddress`** — parsed transfer records (transfer, mint, burn, wrap, unwrap...), 100/page, 10 credits. Does **not** aggregate swap pairs and is **Developer plan ($49/mo) and up — not on free tier.** Disqualified for Phase 0.

**Plain RPC `getSignaturesForAddress` + `getTransaction`** — the portable fallback, keep it as the kill-switch failover path (CLAUDE.md mandates per-integration kill switches). Costs: 1 credit each on Helius. Downsides: max 1,000 signatures/page, descending only, `before`/`until` are *signature*-based (you must already possess the signature to resume — a slot cursor cannot be used directly), no server-side slot filter, and **public/community RPC nodes prune history** so backfill silently returns nothing. N+1 request shape: 1 + N calls per page vs 1.

**QuickNode** — full Solana mainnet archive, DAS API, Metis Jupiter Swap add-on. Multi-chain so cost stacks as add-ons pile up; free trial is weak on rps. Viable paid alternative, not a Phase 0 fit.

**Shyft** — decoded/parsed transactions, GraphQL indexing, generous free RPC. **Fatal for us: parsed transaction history only goes back 3–4 days.** Backfill is the entire point. Disqualified.

**Triton / other** — dedicated-node economics, no free tier worth planning around.

**Birdeye wallet APIs** — exist, but all wallet endpoints are rate-limited to 5 rps / 75 rpm across every package and would burn the 30k CU budget we want reserved for prices.

---

## 2. Free-tier numbers (verified 2026-08-26)

**Helius Free** — 1,000,000 credits/month; **10 RPC req/s**; DAS API 2 req/s; Enhanced APIs 2 req/s; Wallet API and LaserStream WSS (standard methods) included; no LaserStream gRPC; community support.

Credit costs:

| Method | Credits |
| ------ | ------- |
| `getSignaturesForAddress` | 1 |
| `getTransaction` | 1 |
| `getTransactionsForAddress` (signatures) | 10 flat |
| `getTransactionsForAddress` (full) | 10 per 100 txs returned, rounded up, 10 min |
| Enhanced Transactions | 100 |

Budget sanity check for Phase 0: a 500-tx wallet backfilled from scratch = 1 page of 500 full txs = 50 credits. Incremental reconciliation on app open = 10 credits (usually 0 new txs). **1M credits/month is not a constraint at Phase 0 scale** — the binding constraint is 10 req/s, i.e. concurrency, not volume.

**Birdeye Standard (free)** — 30,000 CU/month, **1 rps**. ⚠️ **CORRECTED 2026-08-26** against `docs.birdeye.so/docs/compute-unit-cost`: `/defi/historical_price_unix` = **6 CU** (not 15) ⇒ ~**5,000 point lookups/month**; `/defi/history_price` (range) = **45 CU**; `/defi/ohlcv` = **35 CU**. A range/OHLCV call at 35–45 CU returning hundreds of points is ~10× cheaper per point than the unix endpoint — prefer ranges when backfilling. Free tier *does* include `/defi/history_price`, `/defi/historical_price_unix`, `/defi/ohlcv`, `/defi/ohlcv/base_quote`, `/defi/ohlcv/pair`, `/defi/price_volume/single`, `/defi/token_overview`, `/defi/v3/token/list`. Free tier does **not** include `/defi/multi_price`, `/defi/price_volume/multi`, `/defi/v3/token/meta-data/multiple` — so **no batch price fetches on free**, one mint+timestamp per request at 1 rps. This is the real bottleneck and the reason for the caching design in §4. Next tier is Lite $39/mo (1.5M CU, 15 rps).

**Jupiter Free (Lite)** — **1 req/s, 60 req/min**, sliding 60s window, **API key now required**, limits are per-organization not per-key. `/swap/v2/execute` has its own 50 rps bucket. Rate-limit headers: `x-ratelimit-remaining`, `x-ratelimit-current`, `x-ratelimit-reset`. Legacy portal users keep old limits free **until 2026-06-30** — that date has passed, so assume billing/keys are live. Base URL `lite-api.jup.ag`.

**Pyth** — all endpoints 10 requests per 10 seconds per IP (TradingView endpoint 90/10s). ⚠️ **CORRECTED 2026-08-26**: the API-key cutover is **2026-08-26 16:00 UTC**, not 2026-07-31. From that moment every Hermes/Benchmarks request needs `Authorization: Bearer $PYTH_API_KEY`. A key is **free** — sign up for a Pyth Terminal account and copy it from the billing page. The 10 req/10s limit is unchanged. So Pyth stays free, but is now a signup + secret to manage. Given that, Binance klines (keyless) is the better majors source; keep Pyth as the cross-check.

**CoinGecko Demo** — 10,000 calls/month, 100 calls/min, 50+ endpoints, 60s freshness.

---

## 3. Cursoring, idempotency, forks

Matches `.ai/decisions/event-time-vs-observation-time.md` (`reconciled_through`, resumable, idempotent, "backfill = move the cursor back and re-run").

### Recommended cursor: a finalized **slot**, not a signature

Store per wallet: `reconciled_through_slot BIGINT`, plus `reconciled_at TIMESTAMPTZ` (an `observed_at`), plus `reconciliation_state` ∈ {never, in_progress, current, failed}.

Reconcile loop:

```
filter: { slot: { gt: reconciled_through_slot } }
sortOrder: "asc"
commitment: "finalized"
status: "succeeded"
transactionDetails: "full"
tokenAccounts: "balanceChanged"
maxSupportedTransactionVersion: 0
limit: 1000
```

then follow `paginationToken` until it is null; advance `reconciled_through_slot` to the **last fully-persisted page's slot**, in the same transaction that inserts that page's trades.

Why a slot beats a signature cursor:
- A slot is an absolute, orderable, server-filterable position. A signature is only meaningful as "the one I saw"; if that tx gets dropped from the ledger view you cannot resume.
- "Move the cursor back and re-run" — the decision doc's stated backfill mechanism — is a single `UPDATE ... SET reconciled_through_slot = X`. With signature cursors you'd have to look up which signature corresponds to a date.
- Range filters make resume O(new txs), not O(history).

Keep `paginationToken` only as an **intra-run** cursor. Do not persist it across runs; it encodes `slot:position` which is fine in principle, but re-deriving from the durable slot is simpler and immune to format changes.

### Ordering

`sortOrder: "asc"` with a `slot.gt` filter is the only combination that is safe to interrupt. With `desc` (the default), a crash mid-pagination leaves a *hole* in the middle of history that the cursor cannot express. Ascending means "everything below the cursor is complete" is always true.

Within a slot, order by `transactionIndex` (returned in the response). Slot alone is not a total order.

**Store the slot AND the signature** on each trade row: slot for ordering and cursoring, signature as the natural key.

### Forks / reorgs

- Query **`commitment: "finalized"` only.** `confirmed` can be rolled back; a violation recorded from a rolled-back tx would be unretractable reputational damage in a product whose entire value is accurate accountability.
- Do not advance the cursor to chain head. Advance only to the highest slot actually returned by a finalized query.
- Even so, hold the cursor a small lag behind head (e.g. don't advance past `head - N` slots) if we ever move to `confirmed`. Under `finalized` this is belt-and-braces.
- Solana's finalized commitment means practical reorg risk is ~zero; the risk we are actually managing is *our own* partial writes, which is what §"Idempotency" covers.

### Idempotency (DB-enforced, per `single-source-of-truth-database.md`)

- `UNIQUE (signature)` on the trades table — or `UNIQUE (wallet_id, signature)` if we ever record both sides of a wallet-to-wallet tx. The re-run of an interrupted page then becomes `INSERT ... ON CONFLICT DO NOTHING`, which is the whole idempotency story.
- Insert page rows **and** advance the cursor in **one** Postgres transaction. Never two.
- Take a row lock (`SELECT ... FOR UPDATE`) on the wallet row for the duration, so the Phase 4 worker and a concurrent app-open reconciliation cannot interleave. CLAUDE.md places idempotency in the DB, not app code — this is that placement.
- `occurred_at` = `blockTime` from the response (chain truth). `observed_at` = `now()` server-side at insert. Never conflate; never accept either from a client.

### Gotchas worth writing down

- `blockTime` is **nullable** on old/edge transactions. Have a fallback (slot → approximate time) or mark the row `occurred_at_estimated`.
- `blockTime` is a validator-reported estimate, not monotonic with slot at second granularity. For "$200/day" windows, bucket by day in UTC from `occurred_at` and accept ±seconds at the boundary. Decide and document the timezone — a "day" that means UTC will surprise a user in UTC-8 at 4pm.
- `uiTokenAmount.uiAmount` is a **float** — never use it. Use `uiTokenAmount.amount` (string of base units) + `decimals`.
- u64 amounts exceed `Number.MAX_SAFE_INTEGER`. Use `BigInt` end-to-end, and be careful that `JSON.parse` on the RPC response will silently lose precision on any numeric (non-string) large int.
- `maxSupportedTransactionVersion: 0` must be set or every ALT-using tx (all Jupiter routes) fails.
- A wallet with zero history and a wallet never reconciled must be **distinguishable** — the decision doc's survivorship-bias constraint depends on it. Hence `reconciliation_state`, not a nullable cursor.

---

## 4. USD valuation at `occurred_at`

This is the hard part and the one most likely to blow the free-tier budget.

### The leg-selection trick (do this first)

For a swap you need **one** side priced, not both — the two sides are equal by definition of the trade. So:

1. If either leg is **USDC / USDT** (a stable) → USD value = that leg's amount. **Zero API calls.** Peg risk is immaterial at our tolerance.
2. Else if either leg is **native SOL / wSOL** → USD value = SOL amount × SOL price at `occurred_at`. **One price series**, shared across every SOL-paired trade in the system.
3. Else (alt→alt, genuinely rare in retail flow) → price the more liquid leg via Birdeye `historical_price_unix`.

The overwhelming majority of retail Solana swaps route through SOL or a stable. This collapses "price thousands of memecoins historically" into "know the SOL price per minute", which is one cacheable time series.

### Sources

**Binance `GET /api/v3/klines`** — ⚠️ **ADDED 2026-08-26, this supersedes Pyth as the primary majors source.** Keyless, no signup, no quota. `?symbol=SOLUSDT&interval=1m&startTime={ms}&limit=1000` returns 1,000 one-minute OHLCV candles per call at IP weight 2 (budget 6,000 weight/min). Verified live returning 2025 data, so 90-day lookback is trivial. **90 days of 1m SOL = 129,600 candles = 130 calls, once, for the whole system.** Use `https://data-api.binance.vision` (the public market-data mirror, verified working) rather than `api.binance.com`, which returns HTTP 451 from US-hosted IPs. Fallbacks with the same shape: Coinbase Exchange `/products/{id}/candles?granularity=60` (keyless, 300 candles/call, 10 rps), Binance.US, Kraken, OKX.

**Pyth Benchmarks** — `GET /v1/updates/price/{timestamp}` (multiple feeds at a timestamp) and `/v1/updates/price/{timestamp}/{interval}`. Free but **API-key-gated as of 2026-08-26 16:00 UTC** (free key via Pyth Terminal), 10 req/10s per IP. Oracle provenance and a confidence interval are nice-to-have, not required, for a $200/day allowance. Demote to cross-check; Binance klines is the primary.

**Birdeye** `GET /defi/historical_price_unix?address={mint}&unixtime={ts}` — arbitrary SPL mints including brand-new memecoins, derived from DEX trades. **Best (only realistic free) source for step 3.** 15 CU, 1 rps, ~2,000 calls/month on free. `/defi/history_price` (range) and `/defi/ohlcv` also on free tier — prefer a *range* fetch when backfilling many trades of the same mint, it is the same 15 CU for many points.

**Jupiter Price API v3** (`lite-api.jup.ag/price/v3`) — last-swapped price, **current only. No historical endpoint.** Useful for live pre-trade quoting in Phase 1; **cannot backfill**. Do not build valuation on it.

**CoinGecko Demo** — 10k calls/mo. Historical on free is **daily granularity** (hourly requires paid), and coverage is listed assets only, so long-tail memecoins are absent. A daily close is not an acceptable price for a memecoin that moved 400% intraday. Not suitable as primary; acceptable as a sanity cross-check on majors.

**Switchboard** — on-demand oracle, pull-based; historical query story is weaker than Pyth Benchmarks and it adds a second oracle integration for no extra coverage. Skip.

### Caching (this is what makes free tier survivable)

Add a `token_prices` table: `(mint, minute_bucket_utc) → usd_price NUMERIC, source TEXT, fetched_at TIMESTAMPTZ`, `PRIMARY KEY (mint, minute_bucket_utc)`.

- Round `occurred_at` down to a minute bucket. Every trade in that minute on that mint = 1 lookup, forever.
- Historical prices are **immutable** — once written, never refetch, never expire. This is unlike almost every other cache and is what makes the 2,000/month Birdeye budget workable.
- Prefill the SOL series continuously (1 row/minute from Pyth = 1,440 rows/day, well within 10 req/10s if batched over an interval endpoint). Then most swaps resolve with **zero** external calls at reconciliation time.
- Miss on a bucket → widen to nearest neighbour within ±N minutes before spending a request.

### Precision / money math

- **No floats. Anywhere.** Not for token amounts, not for prices, not for allowances.
- Token amounts: `BigInt` base units + `decimals` from the mint. Store both, plus the mint. Never store a pre-divided decimal.
- Prices and USD: Postgres `NUMERIC` (arbitrary precision). Choose a scale — `NUMERIC(38, 12)` handles a memecoin at 1e-9 USD and a whole-BTC notional without either overflowing or underflowing to zero.
- Round **once, at the end**, when comparing to a limit; round **half-up**; and round the *derived USD total*, not the intermediate token math. Rounding intermediates lets a user shave the limit across many small trades.
- Allowance comparisons in integer cents to make them exactly reproducible.
- Store the **price used and its source** on the trade row. Rule evaluation must be reproducible and defensible — "we said you violated your $200 limit" needs to survive the user recomputing it. This also means a later price-source change never retroactively rewrites history.
- Per CLAUDE.md **fail closed**: if no price can be resolved for a trade, the trade is `unvalued`, not `$0`. An `unvalued` trade must block (in Phase 1's routed path) and must flag the wallet as not-fully-reconciled rather than silently reading as clean — the same survivorship-bias failure mode as an unreconciled wallet.

---

## 5. Asset tiers (BTC / ETH / SOL / alts / memecoins)

**There is no API that returns "this is a memecoin".** Tier assignment is a product judgment we own. Design accordingly rather than shopping for a source that does not exist.

### What is mechanically decidable

- **SOL** — native mint `So11111111111111111111111111111111111111112` (wSOL). Deterministic.
- **Stables** — small fixed mint list (USDC, USDT, PYUSD, USDS...). Deterministic.
- **BTC / ETH on Solana** — **wrapped, and there are competing wrappers**: cbBTC, WBTC (Wormhole/Portal), zBTC, tBTC; WETH via Wormhole, and others. No registry says "these mints are Bitcoin." **Requires a curated mint allowlist**, versioned in the repo, reviewed when a new wrapper gains liquidity. This is unavoidable and is genuinely small (a dozen mints).
- **LSTs** — Jupiter Tokens API v2 tag `lst` (free, `lite-api.jup.ag/tokens/v2/tag?query=lst`), sourced from Sanctum. Mechanically available; whether jitoSOL counts as "SOL" for a `$200/day SOL` limit is a **product** decision, not a data one.
- **Verified vs unverified** — Jupiter Tokens v2 `tag=verified` (community list + Sanctum LSTs). Free. Supported tags: `lst`, `verified`, `stocks` (only `lst`/`verified` on the basic API). Also queryable by mint. Birdeye `/defi/v3/token/list` is a free-tier alternative.

### What is not

`verified` is **not** `not-a-memecoin`. BONK and WIF are verified *and* memecoins. Verification means "the community vouched this is the token it claims to be", i.e. it screens *scams*, not *seriousness*. Conflating the two will produce a rule engine that lets a user dump their limit into WIF while blocking a legitimate new infrastructure token.

### Recommended scheme

```
tier(mint) =
  STABLE     if mint ∈ curated stable list
  SOL        if mint == wSOL  (+ lst tag, if product says LSTs are SOL)
  BTC        if mint ∈ curated BTC-wrapper list
  ETH        if mint ∈ curated ETH-wrapper list
  ALT        if mint has Jupiter `verified` tag
  MEMECOIN   otherwise
```

`MEMECOIN` as the **default / residual** tier is the right default because it is the *strictest* bucket — an unknown token is treated as maximally risky. Fail closed, per CLAUDE.md.

Optional strengthening signals, all available free, all heuristic:
- Launchpad provenance (pump.fun / Bonk.fun mint authority or creation program) → strong memecoin signal.
- Token age (first-seen slot).
- Market cap / liquidity from Birdeye `/defi/token_overview` (free tier, but CU-expensive — cache per mint, refresh rarely).

**Critical, and it follows directly from `event-time-vs-observation-time.md`: persist the resolved tier on the trade row at reconciliation time**, alongside the tier-list version used. Tier lists will change (new wrappers, tokens graduating from unverified). If tiers are resolved at read time, every past rule evaluation silently rewrites itself whenever the list changes — the exact mutable-derived-state failure the decision doc rules out. Derive-never-increment applies to classification too.

Expose the tier list as **data, not code** (a versioned JSON in `packages/rules`), so `packages/rules` stays pure and I/O-free per `architecture.md`. The rules package receives the classification as an input; it never fetches it.

---

## 6. Phase 1 marker: "ours" vs "elsewhere"

**Not to be designed now.** Phase 0 executes no trades, so every detected swap is by definition external. Noting the option so Phase 1 does not have to retrofit it.

The cleanest available marker is Jupiter's **`trackingAccount`**: an arbitrary public key passed at swap-build time, which lands in the transaction's account keys as a read-only account. Reconciliation then checks `accountKeys.includes(OUR_TRACKING_PUBKEY)` — a pure local check, no extra call, and **it does not require taking a fee**, which matters because Phase 0/1 is not monetized. Jupiter also exposes `https://stats.jup.ag/tracking-account/{pubkey}/{YYYY-MM-DD}/{HH}` for the swaps attributed to it.

Adjacent options if we do monetize: `platformFeeBps` on the quote + `feeAccount` on the swap build (as of Jan 2025 the old Referral Program setup is no longer required — any valid token account for the swap pair mint works; for ExactIn the fee account's mint may be input or output mint, for ExactOut only the input mint). A Memo instruction is a third option but costs an extra instruction and CU for no advantage over `trackingAccount`.

**One caveat worth flagging now**, because it is a product problem and not a technical one: a user can route through Jupiter's own UI and produce a transaction indistinguishable from one we would have built minus the marker. CLAUDE.md already accepts this ("They can always bypass us by going to Jupiter directly — that is fine and expected"). The marker gives us *attribution of our own flow*, not *proof of evasion*. The tier of certainty differs and the copy should not overclaim.

---

## References

1. https://www.helius.dev/docs/rpc/gettransactionsforaddress — params, filters, pagination, credit cost, `pre/postTokenBalances` inline
2. https://www.helius.dev/docs/billing/plans and https://www.helius.dev/docs/billing/credits — 1M credits/mo, 10 req/s, per-method costs
3. https://docs.birdeye.so/docs/data-accessibility-by-packages and https://docs.birdeye.so/docs/pricing — free-tier endpoint list, 30k CU/mo, 1 rps
4. https://docs.pyth.network/price-feeds/core/use-historical-price-data and .../rate-limits — Benchmarks endpoints, 10 req/10s, 2026-07-31 API key requirement
5. https://developers.jup.ag/docs/portal/rate-limits — Lite tier 1 rps / 60 rpm, API key required
6. https://www.helius.dev/docs/enhanced-transactions/overview — deprecation notice, successor guidance
7. https://developers.jup.ag/docs/swap/v1/add-fees-to-swap — `platformFeeBps`, `feeAccount`, `trackingAccount`
8. https://dev.jup.ag/docs/tokens/v2 — `verified` / `lst` / `stocks` tags
9. https://docs.shyft.to/solana-apis/transactions/transaction-apis — parsed txs, 3–4 day history limit
10. https://medium.com/@birdeye-data/cu-revision-for-price-history-api-and-token-overview-api-bc5bd5af1f01 — Price History 15 CU
