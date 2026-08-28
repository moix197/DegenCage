# `server/swap` — the pre-trade gate

Answers "may this trade happen at all", *before* the wallet is asked to sign. Quote in,
verdict out. This is the first module in the codebase that enforces anything: `server/chain`
observes trades that already happened, this one intercepts trades that have not.

Non-custodial throughout. The server builds and compiles the unsigned transaction; the
browser wallet signs it; no private key ever reaches here. The user can always bypass us by
going straight to Jupiter — that is expected and is not something this module tries to
prevent.

## The flow

```
POST /api/swap/quote ──> createQuote()                       quote-service.ts
  runtime='nodejs'         resolveSession()  ← the only source of wallet identity
  flags: trade.terminal
         jupiter.swap_build
   │
   ▼  preconditions — BEFORE any external call
   │    constitutions.status === 'active'   else 409 constitution_not_active
   │    loadReconciliationState() === 'current'  else 409 not_reconciled
   │
   ▼  buildSwap()                                            jupiter-client.ts
   │    GET api.jup.ag/swap/v2/build  (quote + raw instructions, one call)
   │    short-TTL cache keyed (walletId, inputMint, outputMint, amount, slippageBps)
   │
   ▼  priceQuote()      lookupTokenDecimals + priceTrade      (chain/, pricing/)
   │  classifyToken()   bought mint → AssetTier
   │  loadWindowedTrades()                                    rules/rolling-allowance.ts
   │
   ▼  evaluateTrade()                                         packages/rules (pure)
   │    foldVerdict(): any violation OR any unevaluable → block
   │
   ▼  allowed only: assembleSwapTransaction()                assemble-transaction.ts
   │    resolveLookupTables()   ← Helius getMultipleAccounts, read from chain
   │    simulate with CU limit 1,400,000, replaceRecentBlockhash: true
   │    compile with unitsConsumed * 1.2 (capped) + /build's OWN blockhash
   │    sha256(compiled message bytes) → tx_message_hash
   │
   ▼  ONE transaction ────────────────────────────────────────────────────┐
        INSERT trade_intents (status 'quoted' | 'blocked')                 │
        recordEvent trade.intent_created                                   │
        recordEvent rule.pre_trade_decision                                │
      ─────────────────────────────────────────────────────────────────────┘
```

## Public surface

| Export | From | What it is |
| ------ | ---- | ---------- |
| `createQuote(params)` | `quote-service.ts` | the whole gate; throws `QuotePreconditionError` for the two `409` cases |
| `foldVerdict(evaluations)` | `quote-service.ts` | decision 4's fold — allow only if every limit allowed |
| `buildSwap(params)` | `jupiter-client.ts` | `/swap/v2/build`; **always throws** on failure |
| `JUPITER_SWAP_BUILD_FLAG` | `jupiter-client.ts` | the integration's kill switch |
| `assembleSwapTransaction(build, taker)` | `assemble-transaction.ts` | compiled message + its hash |

## Invariants a change must not break

- **Preconditions run before any external call.** Evaluating a trade against a `draft`/
  `committing` constitution, or an unreconciled history, produces a confident "allowed" that
  means nothing — worse than no answer.
- **Every failure blocks.** A dependency that *throws* propagates and the route answers
  `503`; a dependency that resolves to *unknown* folds to `unevaluable`, which is a block and
  is persisted as one. Neither ever falls through to allow.
- **Only an allowed quote is assembled.** A blocked quote gets no compiled message, no
  simulation, and `tx_message_hash IS NULL` — the browser never holds signable bytes for a
  trade the rules refused.
- **The hash is over the compiled *message*, not a signed transaction.** No signature exists
  at quote time. Phase 3's submit path strips the wallet's signature off the signed bytes and
  hashes what remains; hashing a whole signed transaction could never match.
- **`/build`'s blockhash is bytes, not base58.** Using it un-encoded compiles silently and
  fails mysteriously at send time. The simulation pass's *replaced* blockhash must never
  reach the message the user signs.
- **The compute-unit limit is measured, never guessed.** `/build` returns a CU price only. A
  failed simulation blocks; there is no default to fall back to.
- **Lookup tables are read from chain.** A lookup table decides which real accounts each
  compressed index resolves to, so `addressesByLookupTableAddress` supplies only the table
  *addresses* — the contents come from our own Helius RPC.
- **The quote cache key includes `walletId`.** `taker` is baked into the returned
  instructions; a key without it would serve one user's assembled transaction, containing
  their own address, to another user's session.
- **The intent row and both its events are one transaction.** A decision the user saw must be
  reconstructable, and a live intent must never exist with nothing explaining it.
- **`resolveSession()` is the only source of wallet identity.** A body-supplied wallet would
  make every rule in the product opt-out.

## Pricing (the slippage-safe leg rule)

The sold leg is priced off `inAmount` — for an exact-in swap that amount is fixed no matter
how the swap fills. The bought leg, reached only when neither mint is a stablecoin or SOL, is
priced off `otherAmountThreshold`, the guaranteed minimum. The optimistic `outAmount` is
never used: the acquired token count has no documented upper bound, so pricing off it would
understate risk on exactly the trades that execute better than quoted.

An unresolved decimal scale is `usd_value: null` — unpriced, never `$0` — which folds every
ceiling limit to a block.

## Events

| Event | When |
| ----- | ---- |
| `trade.intent_created` | every quote, allowed or blocked — carries the quote's inputs |
| `rule.pre_trade_decision` | the verdict and the evaluations that produced it |

Deliberately distinct from `rule.decision_recorded`, which reconciliation writes for a trade
that already happened: Phase 5's dashboard has to tell a trade we *stopped* apart from one we
merely *scored*.

## Kill switches

| Flag | Off means |
| ---- | --------- |
| `trade.terminal` | `/trade` renders a switched-off notice and the route answers `503` — the surface is gone, which is the only safe direction |
| `jupiter.swap_build` | `buildSwap` throws; no quote is produced, so nothing can be evaluated or signed |
| `chain.helius` | (existing) lookup-table resolution and the compute-unit simulation throw, blocking the quote |

No flag can disable rule *enforcement* while trading is live: turning the terminal off
removes the ability to quote, it never turns a quote into an unchecked one.
