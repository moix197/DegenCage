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
   │    assert exact-in: swapMode === 'ExactIn' && inAmount === the requested amount
   │
   ▼  priceCeilingLimits()  lookupTokenDecimals + priceTrade  (chain/, pricing/)
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

## The submit half

The second and last server call. The wallet signs the message this module compiled; the signed
bytes come back and are checked against the intent the server itself approved, and only then
sent — or, with `chain.broadcast` off, simulated.

```
POST /api/swap/submit ──> submitSignedSwap()                 submit-service.ts
  runtime='nodejs'         resolveSession() → walletId + walletAddress
  flag: trade.terminal
   │
   ▼  readPresentedTransaction()
   │    decode the wire format → messageBytes + signature map
   │    sha256(messageBytes)   ← the MESSAGE, extracted from the signed bytes
   │    fee payer = staticAccounts[0]; its signature must be present
   │
   ▼  fee payer === session wallet address        else fee_payer_mismatch (409)
   │
   ▼  guarded UPDATE → 'signed'   (.ai/patterns/guarded-state-transition.md)
   │    WHERE id AND wallet_id AND status IN ('quoted','approved')
   │          AND expires_at > now() AND tx_message_hash = <hash>
   │    ZERO ROWS → resolveZeroRowOutcome(): a replay, or a named rejection
   │
   ▼  reevaluate()  same active constitution + fresh windowed history
   ▼  broadcastSignedTransaction()               chain/broadcast-transaction.ts
   ▼  guarded UPDATE 'signed' → 'submitted'
```

- **Every precondition rides in the WHERE** — ownership, status, expiry against the
  *database's* clock, and the hash. Never read, decide, then write by id: a double-click, a
  retry and a replayed request all arrive here, and a check-then-act would let two of them both
  believe they were first.
- **`status IN ('quoted','approved')`** is the signable set: `quoted` is what an *allowed*
  quote writes, `approved` is reserved for a later explicit-approval step. A `blocked` row
  carries `tx_message_hash: null`, so the hash equality in the same WHERE excludes it
  independently — the status list is not what keeps blocked trades unsignable.
- **Zero rows is not automatically an error.** An already-`signed`/`submitted`/`confirmed`
  intent whose recorded hash matches the bytes in hand is the same submit arriving twice: it is
  answered with the original result, records no events and re-transitions nothing. Its `dryRun`
  is read back from the recorded `trade.intent_submitted` event, never from the flag as it
  stands now — once Phase 6 turns broadcasting on, re-reading the flag would tell a replayed
  caller no funds moved when they had. Everything else is a named rejection.
- **Three checks, none derivable from the others:** `intent.wallet_id == session.walletId`
  (decision 13), the message hash, and the compiled message's fee payer read out of the message
  itself. See
  [swap-signing-and-submit](../../../../../.ai/decisions/swap-signing-and-submit.md).
- **Fail closed throughout.** A failed re-evaluation, a failed simulation, a missing
  constitution or unreadable bytes all end in "not broadcast" and a `failed` intent — nothing
  is ever broadcast on a throwing path.

The route (`app/api/swap/submit/route.ts`) is thin like the quote route: shape validation,
`resolveSession()` and status codes only — `403` for `wallet_mismatch` (an authorization
failure), `409` for every other rejection, `503` for anything unexpected.

## Public surface

| Export | From | What it is |
| ------ | ---- | ---------- |
| `createQuote(params)` | `quote-service.ts` | the whole gate; throws `QuotePreconditionError` for the two `409` cases |
| `foldVerdict(evaluations)` | `quote-service.ts` | decision 4's fold — allow only if every limit allowed |
| `buildSwap(params)` | `jupiter-client.ts` | `/swap/v2/build`; **always throws** on failure |
| `JUPITER_SWAP_BUILD_FLAG` | `jupiter-client.ts` | the integration's kill switch |
| `assembleSwapTransaction(build, taker)` | `assemble-transaction.ts` | compiled message + its hash |
| `submitSignedSwap(params)` | `submit-service.ts` | verifies the signed bytes, then broadcasts or simulates; throws `SubmitRejectedError` for every refusal |
| `SubmitRejectedError` | `submit-service.ts` | the refusal, carrying the `reason` the route turns into a status code |

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
  at quote time, and signature bytes vary per signing. The submit path therefore extracts the
  message from the signed bytes and hashes *that*; hashing a whole signed transaction could
  never match.
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
- **The exact-in premise is asserted, not assumed.** Ceiling limits are priced off `inAmount`
  only because the swap is exact-in for the amount requested, so a `/build` response whose
  `swapMode` is not `ExactIn`, or whose `inAmount` differs from the requested amount, throws
  and blocks the quote instead of being priced.

## Pricing (the slippage-safe leg rule)

Which leg a pre-trade limit prices off follows from the limit's *shape*, and the caller names
it rather than letting `priceTrade` infer one — see
[pre-trade-slippage-pricing](../../../../../.ai/decisions/pre-trade-slippage-pricing.md).

- **Ceiling limits** — `daily_notional_usd`, `asset_tier_acquisition_usd`, where a *larger*
  number must be more likely to block — price the **sold leg**, `leg: 'sold'` off `inAmount`.
  That is the amount the request declared it was spending, and nothing in the request can
  shrink it. Pricing a ceiling off `otherAmountThreshold` instead let a caller discount its own
  recorded notional simply by asking for more slippage — a bypass through the enforcement path,
  which is why that is no longer done.
- **Floor limits** — `rolling_loss_usd`, where *smaller* proceeds are what block — price the
  proceeds off `otherAmountThreshold`, the guaranteed minimum. Worst case maximises the
  estimated loss, the conservative direction for a floor.
- **`outAmount` is never used, in either direction.** It is the aggregator's optimistic estimate
  with no documented upper bound.

`inAmount` is only fixed because the swap is exact-in, so `createQuote` asserts that premise
against the `/build` response before pricing anything (see the invariant below).

An unresolved decimal scale is `usd_value: null` — unpriced, never `$0` — which folds every
ceiling limit to a block.

## Events

| Event | When |
| ----- | ---- |
| `trade.intent_created` | every quote, allowed or blocked — carries the quote's inputs |
| `rule.pre_trade_decision` | the verdict and the evaluations that produced it |
| `trade.intent_signed` | the guarded `→ signed` transition matched — signature and hash recorded before anything is broadcast |
| `trade.intent_submitted` | the submit completed; carries `dryRun` and the network signature, and is the record a later replay reads its answer back from |
| `trade.intent_failed` | any refusal, including one that never reached the intent row (unreadable bytes, fee-payer mismatch) — a submit that failed must be visible in telemetry, not only in an HTTP status |

Neither `trade.intent_signed` nor `trade.intent_submitted` is recorded on the replay branch: a
call that did nothing must leave the audit trail saying exactly that.

Deliberately distinct from `rule.decision_recorded`, which reconciliation writes for a trade
that already happened: Phase 5's dashboard has to tell a trade we *stopped* apart from one we
merely *scored*.

## Kill switches

| Flag | Off means |
| ---- | --------- |
| `trade.terminal` | `/trade` renders a switched-off notice and the route answers `503` — the surface is gone, which is the only safe direction |
| `jupiter.swap_build` | `buildSwap` throws; no quote is produced, so nothing can be evaluated or signed |
| `chain.helius` | (existing) lookup-table resolution and the compute-unit simulation throw, blocking the quote |
| `chain.broadcast` | seeded **off**: a verified submit is simulated instead of sent (`dryRun: true`), and the user is told so. Owned by `server/chain/broadcast-transaction.ts` — nothing here branches on it |

No flag can disable rule *enforcement* while trading is live: turning the terminal off
removes the ability to quote, it never turns a quote into an unchecked one.
