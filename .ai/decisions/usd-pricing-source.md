# USD pricing: majors from Binance klines, unpriceable is `null`

**Decision:** A swap's USD value is obtained by pricing **one known leg**, not both
(`apps/web/src/server/pricing/price-trade.ts`). A USDC/USDT leg is worth its own face amount
with zero external calls; a SOL leg is valued at the close of the 1-minute Binance kline
(`data-api.binance.vision`, `SOLUSDT`) containing the trade's `occurred_at`. A swap with
neither leg — alt↔alt — is `usd_value: null`.

Fetched prices land in a shared `token_prices` table keyed `(mint, minute_bucket_utc)`, so
one row serves every wallet whose trade fell in that minute.

**Why:** Both legs of a swap are the same dollar amount by definition, so pricing the
liquid, unambiguous side is strictly more accurate than pricing the illiquid side and
cheaper than pricing both. Binance is a free, keyless, historical, minute-resolution source
for exactly the majors that appear on one side of nearly every Solana retail trade — which
is the whole reason a paid long-tail price API is not needed to ship the first enforceable
limit.

The cache key is `(mint, minute)` rather than per-trade because price is a property of a
moment in time, not of a user. Two hundred wallets reconciling the same minute hit Binance
once.

The `null` rule is the important half. `usd_value: 0` for an unpriceable trade would silently
enter the notional sum as free money, and the user would be shown a **false "$0 spent
today"** — the exact failure a commitment product cannot have. `null` propagates: any
unpriced trade in a window makes the window's total `null`, which the rule engine reports as
`unevaluable` and the UI renders as "unknown", never as "within limit"
(`sumTradeUsd` in `packages/rules/src/evaluate.ts`).

**Rejected:**

- **`usd_value: 0` (or skipping the row) when a price is unavailable** — turns a gap in our
  data into a favorable reading of the user's behavior. Fail closed instead.
- **Carrying forward the last known price / interpolating** — invents a number that then
  becomes an audit-trail fact indistinguishable from a real one.
- **A paid long-tail price API (Birdeye) for everything** — Phase 4 exists to prove the
  ingestion pipeline is correct; adding a second priced dependency to do it buys risk, not
  signal. Phase 5 added Birdeye (`pricing/birdeye-price.ts`, flag `pricing.birdeye`) as the
  **alt↔alt fallback only**: it is consulted when neither leg is a stablecoin or SOL, never
  in place of the face-value or Binance paths.
- **An on-chain / DEX-quote price at the trade's slot** — most accurate in principle, but
  needs the long-tail infrastructure this phase is avoiding, for majors that Binance already
  prices exactly.

**Constraints it creates:**

- USD amounts are exact decimal strings computed with `BigInt`, never floats — in pricing,
  in the rolling sum, and in the rule engine. `usd_value` is `NUMERIC(38,12)`.
- **A price crossing the JSON-number boundary must be converted to fixed notation, not via
  `toString()`.** JavaScript renders numbers below `1e-6` in exponential form
  (`1.2345e-7`), and `BigInt('12345e-7')` throws — which, because `reconcileWallet` rethrows,
  fails the *entire wallet's* reconciliation rather than one trade. Long-tail mints priced
  through Birdeye are routinely sub-$0.000001, so this is the common case there, not an edge
  case. `birdeye-price.ts` converts to a plain decimal string with no precision loss and
  rejects non-finite values to `null`. Any future price source arriving as a JSON number
  inherits this requirement.
- Stablecoins are pinned to exactly $1. A depeg is knowingly not modeled.
- SOL/USDT is treated as SOL/USD.
- Behind its own kill switch (`pricing.binance`); disabled, timed out, or an unresolvable
  minute all resolve to `null` — the same fail-closed path, never a guess.
- `token_prices` rows are immutable facts about a past minute, written with
  `ON CONFLICT DO NOTHING`. Nothing in the system updates one.
