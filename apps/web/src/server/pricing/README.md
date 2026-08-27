# `server/pricing` — what a swap was worth in USD

Turns a derived swap into one USD number, or into an honest `null`. Every dollar figure the
product shows — a rolling allowance, a daily notional limit, a violation — traces back to
this module, so its one hard rule is that it would rather say *nothing* than say something
convenient.

Decision that outlives this module lives in `.ai/`:
[usd-pricing-source](../../../../../.ai/decisions/usd-pricing-source.md). This file is the
flow and the invariants.

## The flow

```
priceTrade(trade)                              price-trade.ts
   │
   ├─ either leg is USDC/USDT ──> that leg's amount, $1 exactly, no external call
   │                              priceSource: 'stablecoin'
   │
   ├─ either leg is SOL ───────> getSolUsdPrice(occurredAt)     binance-klines.ts
   │                               minuteBucketUtc(occurredAt)
   │                               SELECT token_prices (mint, minute)   ← hit: done
   │                               GET data-api.binance.vision klines   ← miss
   │                               INSERT … ON CONFLICT DO NOTHING
   │                             price × amount, exact BigInt decimal math
   │                             priceSource: 'binance'  |  null on any failure
   │
   └─ alt <-> alt ─────────────> { usdValue: null, priceSource: null }
```

## Public surface

| Export | Owns |
| ------ | ---- |
| `priceTrade(trade)` | leg selection and the exact multiplication; returns `{ usdValue, priceSource }` |
| `getSolUsdPrice(occurredAt)` | the cached SOL/USD minute price; `null` on any failure |
| `minuteBucketUtc(date)` | the cache key's time half — floor to the UTC minute |
| `SOL_MINT`, `PRICING_BINANCE_FLAG` | the wSOL mint address, and the kill switch |

## Invariants a change must not break

- **Unpriceable is `null`. Never `0`.** This is the module's entire reason to exist. `0`
  flows into `sumTradeUsd` as a real addend and produces a *smaller* total than the truth —
  a limit that reads "within" because part of the day was invisible, or a status page
  showing "$0 spent today" to someone who spent thousands. `null` propagates instead:
  `sumTradeUsd` returns `null` the moment any trade in the window is unpriced, and an
  unknown total is never reported as within limit. Every failure path here — flag off,
  Binance non-200, timeout, thrown request, a minute Binance has no candle for, an alt↔alt
  swap — resolves to `null` for that reason, not by accident.
- **Prices are never guessed or carried forward.** No nearest-minute fallback, no last-known
  price, no interpolation. A trade is priced at *its own* minute or not at all; the
  alternative is a plausible number nobody can audit, in a system whose product is the
  audit trail.
- **The cache is keyed `(mint, minute_bucket_utc)` and is global, not per-wallet.** One row
  serves every user's trades in that minute, so Binance is called at most once per minute
  of history regardless of how many wallets reconcile through it. The insert is
  `ON CONFLICT DO NOTHING`: concurrent reconciliations racing on the same minute is the
  normal case, not an error, and both wrote the same value anyway.
- **Money math is `BigInt` on digit strings, never a float.** `baseUnitsToDecimalString` and
  `multiplyUsd` manipulate digits directly and the result stays a string all the way into
  `numeric(38, 12)`. A single `Number` in this path is a rounding bug in a dollar figure a
  user is held to.
- **`priceTrade` is called outside any database transaction.** It does external HTTP with
  its own timeout; `reconcile-wallet.ts`'s `priceBatch` deliberately runs before the
  row-locked `persistBatch` so no lock is ever held across a network round trip. Calling it
  from inside a transaction reintroduces exactly that.
- **Failures are captured, never swallowed.** Each `null` return is accompanied by a
  `captureError` tagged `failedClosed: true` — a degraded price source has to be visible in
  telemetry, or "everything is unpriced" looks identical to "nobody traded".

## Why leg selection, and what it does not cover

A swap has two sides; pricing the *known* one is exact and needs no price for the other. A
stablecoin leg is $1 with zero external calls; a SOL leg needs one cached minute price. That
covers the overwhelming majority of real Solana swap volume with one external dependency.

**Alt↔alt is deliberately out of scope in Phase 4** and returns `null` — a long-tail token
price needs a different source (Birdeye), which arrives in Phase 5 as a fallback *after*
these two branches, not as a replacement for them. Until then those trades are recorded with
`usd_value: null` and correctly poison any window total they fall in, which is the honest
answer rather than a silent undercount.

The 8-second timeout and the `data-api.binance.vision` host (the public data mirror, no
API key, no account) are both part of keeping this a bounded, unauthenticated read.

## Kill switch

`pricing.binance` (`PRICING_BINANCE_FLAG`), seeded by `src/server/db/seed.ts`. Off — or with
the flag lookup itself failing — `getSolUsdPrice` returns `null` before touching the cache or
the network, so every SOL-legged trade becomes `usd_value: null`. Reconciliation still runs
and still records trades; they simply arrive unpriced, and any limit whose window contains
one becomes `unevaluable` rather than passing. Stablecoin legs are unaffected: they never
call Binance. Already-priced rows are untouched — the switch stops new pricing, it does not
rewrite history.
