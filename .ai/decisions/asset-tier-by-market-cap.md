# Asset tiers are graded by market cap, not by asset identity

**Decision:** `AssetTier` is `STABLE | LARGE_CAP | MID_CAP | SMALL_CAP | MICRO_CAP`
(`packages/rules/src/constitution.ts`). `STABLE` resolves from a curated mint set with no
external call; the four cap tiers come from Jupiter Tokens v2's `mcap` field, bucketed at
$1B / $100M / $10M by one exported threshold constant in
`apps/web/src/server/chain/classify-token.ts`. Anything unlisted, missing `mcap`, or
resolved while the kill switch is off becomes `MICRO_CAP` with
`classification: 'unknown'` — both persisted on the trade row.

This **supersedes** the original identity-based tiers
(`STABLE | SOL | BTC | ETH | ALT | MEMECOIN`) shipped with the constitution schema.

**Why:** The question a tier limit answers is *"how much am I gambling?"*, and market cap
answers it where an identity label does not. The original design classified `ALT` vs
`MEMECOIN` by Jupiter's `verified` tag — but that tag is a listing-quality signal, not a
risk signal: BONK (~$268M mcap) and a three-day-old pump.fun mint are both "verified", so a
user who wrote "$100/24h into MEMECOIN" would have gotten no enforcement on precisely the
trades they were caging themselves against. Buying a low cap is the same bet whether or not
it has a dog on it.

Cap buckets are also orderable, which identity labels are not — a future "no more than $X
below $Y mcap" rule is a threshold change, not a new tier vocabulary.

**Rejected:**

- **Keep identity tiers, classify `ALT`/`MEMECOIN` by Jupiter's `verified` tag** — the
  original plan. Fails on the only case that matters (see above).
- **Hybrid: keep `SOL`/`BTC`/`ETH` named, split only `ALT` by cap** — majors are already
  large caps by definition, so the named tiers earn nothing but a second classification
  path that can disagree with the first. `SOL`↔LST swaps are excluded upstream anyway
  ([chain-data-source](chain-data-source.md)), so SOL needs no special tier.
- **FDV instead of mcap** — inflates young tokens with large locked allocations into higher
  tiers, which is backwards: the unlocked float is what the user is actually trading.

**Constraints it creates:**

- **A tier is a point-in-time judgement and is stamped, never recomputed.** `mcap` is live,
  so `trades.acquired_tier` and `trades.classification` are written once at classification
  time. A token that later moons must not retroactively rewrite past violations — the
  append-only rule that governs violations governs their inputs too.
- **The 90-day backfill classifies historical trades at *today's* mcap.** Backfilled trades
  are baseline-only and never surfaced as violations, so this is tolerable, but a backfilled
  tier badge is not a contemporaneous judgement and the UI must not present it as one.
- **`classification` is not cosmetic.** `MICRO_CAP` + `'unknown'` (fail-closed default) and
  `MICRO_CAP` + `'known'` (a genuine sub-$10M read) are different facts; the status page
  shows "counted as micro cap" only for the former. Collapsing them would make the audit
  trail unable to distinguish a real classification from a provider outage.
- **Classification never throws into the reconcile pipeline.** Timeout, client error,
  unlisted mint, `mcap: null`, and `classification.jupiter_mcap` off all resolve to the same
  fail-closed default. This is load-bearing: `reconcileWallet` rethrows, so a raising
  classifier would fail an entire wallet's reconciliation.
- **`mcap` arrives as a JSON number and stays one.** It is confined to threshold comparison
  and never enters USD or allowance arithmetic, which remains exact-decimal `BigInt`
  ([usd-pricing-source](usd-pricing-source.md)).
- Per-mint lookups are comma-batched into one Jupiter call per reconcile batch and cached by
  mint; the cache is currently unbounded (known, accepted at Phase 0 scale).
- Disposals never consume a tier allowance — selling out of a tier is not a bet, regardless
  of size. Enforced in `evaluateTrade`'s `asset_tier_acquisition_usd` case.
