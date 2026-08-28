# Pre-trade pricing names its leg, and the leg is always the sold one

**Decision:** A *pre-trade* quote never lets `priceTrade` infer which leg to price. The caller
names it (`PriceableTrade.leg`, `apps/web/src/server/pricing/price-trade.ts`), and the one
pre-trade call site — `priceCeilingLimits()` in `apps/web/src/server/swap/quote-service.ts` —
names `'sold'`: Jupiter's `inAmount`, which for an exact-in swap is the amount we hand the
aggregator, fixed before execution and unchanged by how the route fills. That single figure is
the `usd_value` written to the `trade_intents` row and the only USD number the rule engine sees
pre-trade.

Per limit, as shipped:

- **`daily_notional_usd` and `asset_tier_acquisition_usd`** — the ceiling limits, where a
  larger number must be *more* likely to block — are the limits that consume it.
- **`rolling_loss_usd` consumes no quote pricing at all.** It sums `realized_loss_usd` over
  closed round trips, and pre-trade there is no lot matching: `isRoundTripClose` is left unset,
  so the proposed trade contributes nothing to its own loss total and the limit is evaluated
  against the window's already-realized losses (or `unevaluable` → block with the flag off).
- **`outAmount` is never priced,** in either direction: the aggregator's optimistic estimate,
  with no documented upper bound.
- **`otherAmountThreshold` is never priced either.** It is passed to `priceTrade` as
  `boughtAmountBaseUnits` and it reaches the quote view and the intent events, but `leg:
  'sold'` returns before it is read. `leg: 'bought'` exists on the type and has no production
  call site — worst-case-proceeds pricing is a shape reserved for a future floor-type limit,
  not behaviour that shipped.

Reconciliation (`chain/reconcile-wallet.ts`) passes no `leg` and keeps the inferred
liquidity-ordered behaviour: post-execution both amounts are real on-chain facts, so pricing
the most liquid leg is simply the most accurate reading.

Client-supplied `slippageBps` is capped at **500 (5%)** in `app/api/swap/quote/route.ts`, and
an out-of-range value is **rejected (400), never clamped**.

**Why:** Understatement is the dangerous direction, and only one of the two amounts can be
understated by the request itself. `otherAmountThreshold` is the quote minus slippage: pricing
a *ceiling* limit off it records a notional of roughly `true × (1 − slippageBps/1e4)`. A caller
posting straight to `/api/swap/quote` could therefore shrink its own recorded daily notional
just by asking for more slippage, and slide a trade past a limit that should have blocked it —
a discipline bypass through the enforcement path itself, not around it. The old 5000 bps
ceiling made that a 50% discount. The sold leg has no such knob: `inAmount` is what the request
already declared it was spending.

The symmetric mistake is pricing a ceiling off `outAmount`. That understates whenever execution
comes in *better* than quoted — exactly the trades whose real risk is highest.

The bad number does not stay in memory either: it is persisted as `trade_intents.usd_value`,
which Phase 4 sums to reserve allowance. One understated intent under-reserves for every trade
that follows it.

The cap is 5% rather than something tighter because a genuinely illiquid pair needs room, and
above Jupiter's own high-slippage warning band a request is no longer asking for tolerance —
it is asking to trade a size the pair cannot absorb. Rejecting rather than clamping follows the
same rule as everywhere else here: silently executing something other than what was asked for
is the quiet accommodation this product exists to refuse.

None of this is an accuracy claim. A pre-trade figure is an estimate by construction — it is
chosen to be wrong in the safe direction. Phase 0 reconciliation later prices the same swap off
the real on-chain balance deltas and writes the true `usd_value` to `trades`; the intent's
estimate is a gate input, never the historical record.

**Rejected:**

- **Reordering `priceTrade`'s existing `isStablecoin`/`SOL_MINT` branches so the sold leg wins**
  — fixes the SOL→USDC case by accident and silently changes reconciliation, whose behaviour is
  correct as-is. The leg is a caller's decision, so it belongs in the caller's hands.
- **Falling back to the bought leg when the sold leg has no price source** — reintroduces the
  slippage-shrinkable number through the back door. An unpriceable sold leg is `usdValue: null`,
  which folds every ceiling limit to `unevaluable` → block, per
  [usd-pricing-source](usd-pricing-source.md).
- **Clamping an out-of-range slippage to the maximum** — the user is then shown a verdict for a
  trade they did not request.
- **Averaging `outAmount` and `otherAmountThreshold`, or applying a fudge factor** — invents a
  number, and still moves with `slippageBps`.

**Constraints it creates:**

- Every new pre-trade pricing call site must name its `leg`. Omitting it is the reconciliation
  behaviour, which is wrong for a gate.
- A new ceiling-type limit prices off the sold leg. A floor-type limit — one where a *smaller*
  figure is what blocks — would price the bought leg off `otherAmountThreshold`, the guaranteed
  minimum, because worst-case proceeds maximise the estimated loss; no shipped limit does this
  yet, so the first one that needs it is introducing the pattern, not following it.
- Raising `MAX_SLIPPAGE_BPS` widens the gap between the quoted and executed trade for every
  limit computed from a quote — it is a rule-engine change, not a UX knob.
- Exact-in is the premise: `inAmount` is only fixed because `swapMode` is `ExactIn` and the
  amount returned is the amount requested. `quote-service.ts` asserts both against the `/build`
  response before pricing and blocks on a mismatch, so the premise is checked rather than
  trusted. An exact-*out* route would invert which leg is the fixed one and this rule would
  have to be re-derived.
