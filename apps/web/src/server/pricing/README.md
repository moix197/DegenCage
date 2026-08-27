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
   └─ alt <-> alt ─────────────> getBirdeyeUsdPrice(mint, occurredAt)  birdeye-price.ts
                                   the more liquid leg only
                                   price × amount, exact BigInt decimal math
                                   priceSource: 'birdeye'  |  null on any failure
```

## Public surface

| Export | Owns |
| ------ | ---- |
| `priceTrade(trade)` | leg selection and the exact multiplication; returns `{ usdValue, priceSource }` |
| `getSolUsdPrice(occurredAt)` | the cached SOL/USD minute price; `null` on any failure |
| `getBirdeyeUsdPrice(mint, occurredAt)` | the long-tail fallback price for one mint; `null` on any failure |
| `minuteBucketUtc(date)` | the cache key's time half — floor to the UTC minute |
| `SOL_MINT`, `PRICING_BINANCE_FLAG`, `PRICING_BIRDEYE_FLAG` | the wSOL mint address, and the two kill switches |

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
- **A price arriving as a JSON number is converted to *fixed* notation, never via
  `toString()`.** JavaScript renders anything below `1e-6` as `1.2345e-7`, and
  `BigInt('12345e-7')` **throws** — which, because `reconcileWallet` rethrows, fails the
  entire wallet's reconciliation rather than one trade. Birdeye's long-tail mints are
  routinely sub-$0.000001, so this is the common case on that path, not an edge case.
  `birdeye-price.ts` converts digit-wise with no precision loss and rejects non-finite
  values to `null`. Any future price source that arrives as a number inherits this.
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

**Alt↔alt is covered by Birdeye**, which sits *after* these two branches rather than
replacing them: it is consulted only when neither leg is a stablecoin or SOL, and prices the
more liquid leg. It is a fallback because it is a keyed, paid, long-tail source — the two
branches above remain cheaper and more accurate for the volume they cover. When Birdeye is
also unresolvable (flag off, no key, no price for that mint) the trade stays `usd_value:
null` and correctly poisons any window total it falls in, which is the honest answer rather
than a silent undercount.

`STABLECOIN_MINTS` lives in `server/chain/stablecoin-mints.ts`, not here — pricing and
Phase 5's tier classification both read the same set, so "is this a stablecoin" cannot get
two different answers. Same reasoning as `lst-allowlist.ts`.

The 8-second timeout and the `data-api.binance.vision` host (the public data mirror, no
API key, no account) are both part of keeping this a bounded, unauthenticated read.

## Kill switches

`pricing.birdeye` (`PRICING_BIRDEYE_FLAG`) gates the alt↔alt branch only. Off, or with
`BIRDEYE_API_KEY` unset, those swaps return to `usd_value: null` — the Phase 4 behaviour,
fail-closed, never a guessed price. A missing key is caught inside the request path (it does
not crash reconciliation), but it reports one error per attempted trade: set the key or turn
the flag off, don't leave both.

`pricing.binance` (`PRICING_BINANCE_FLAG`), seeded by `src/server/db/seed.ts`. Off — or with
the flag lookup itself failing — `getSolUsdPrice` returns `null` before touching the cache or
the network, so every SOL-legged trade becomes `usd_value: null`. Reconciliation still runs
and still records trades; they simply arrive unpriced, and any limit whose window contains
one becomes `unevaluable` rather than passing. Stablecoin legs are unaffected: they never
call Binance. Already-priced rows are untouched — the switch stops new pricing, it does not
rewrite history.
