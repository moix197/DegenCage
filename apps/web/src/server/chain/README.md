# `server/chain` — reading the wallet's real trade history

Answers "what did this wallet actually do, on any app, whether or not it went through us".
Chain transactions in, `trades` rows out. Nothing here signs, quotes, or blocks anything:
this module observes. The rule *verdict* on what it observes comes from `packages/rules`;
this module only feeds it and records what came back.

Decisions that outlive this module live in `.ai/`:
[chain-data-source](../../../../../.ai/decisions/chain-data-source.md),
[reconciliation-idempotency](../../../../../.ai/decisions/reconciliation-idempotency.md),
[event-time-vs-observation-time](../../../../../.ai/decisions/event-time-vs-observation-time.md).
This file is the flow and the invariants.

## The flow

```
POST /api/wallet/reconcile ──> reconcileWallet(correlationId)
                                 resolveSession()  ← the only source of wallet identity
                                 baseline_completed_at IS NULL ?  → isBaseline
   │
   ▼  getTransactionsForAddress()          helius-client.ts
   │    cursor null → { sinceUnixSeconds: now - 90d }
   │    cursor set  → { minSlot: cursor + 1 }
   │
   ▼  deriveSwapFromTransaction()          derive-swaps.ts + lst-allowlist.ts
   │    one tx → exactly one DerivedSwap (real trade, or excluded with a reason)
   │    sorted by (slot, transactionIndex)
   │
   ▼  chunk(100) — then, per batch:
        priceBatch()    ← HTTP, OUTSIDE any transaction
        persistBatch()  ┌─ ONE transaction ──────────────────────────────────┐
                        │ SELECT … FOR UPDATE the wallet row                 │
                        │ per swap: loadWindowedTrades → INSERT … ON CONFLICT│
                        │           (wallet_id, signature) DO NOTHING        │
                        │           → evaluateTrade + recordEvent            │
                        │ UPDATE reconciled_through_slot = GREATEST(…)       │
                        │        [+ baseline_completed_at on the last batch] │
                        └────────────────────────────────────────────────────┘
```

## Public surface

| Export | Owns |
| ------ | ---- |
| `reconcileWallet(correlationId)` | the whole run for **the session's own wallet**; `ReconcileRejected('unauthenticated')` otherwise |
| `CHAIN_HELIUS_RECONCILE_FLAG` | the kill switch the *route* checks — see below |
| `getTransactionsForAddress(address, filter)` | paginated Helius pull; throws `HeliusClientError`, never returns a partial list quietly |
| `CHAIN_HELIUS_FLAG` | the kill switch the *client* checks |
| `deriveSwapFromTransaction(tx, address)` | pure; the whole swap heuristic, independently testable |
| `LST_MINTS` / `isSolOrLstMint` / `WSOL_MINT` | the shared SOL/LST set |

## Invariants a change must not break

- **`baseline_completed_at` is the sole answer to "is this the baseline pull".** Not
  `reconciliation_state`, not the cursor. Both of those reach a mid-baseline value that a
  failed first run also reaches, and a failed baseline must be retried *as* a baseline —
  otherwise a Helius outage on first connect (the likely failure) reclassifies 90 days of
  pre-commitment history as live and feeds it to `evaluateTrade()`. It is written exactly
  once, only on success, and only on a baseline run.
- **The cursor advance is `GREATEST`, never a blind `SET`.** A concurrent run's batch may
  already have moved it past this batch's highest slot; moving it backward re-pulls history
  that is already persisted. And `baseline_completed_at` rides in *that same UPDATE*, in
  that same transaction: issued separately after the commit, a crash in between leaves the
  cursor moved and the baseline unmarked, so the retry misclassifies live trades as
  baseline.
- **Pricing happens outside the transaction, on purpose.** `priceBatch` does the external
  HTTP; `persistBatch` opens the transaction and does DB work only. A row lock held across
  a network round trip serializes every other reconciliation of that wallet behind
  Binance's latency. Moving `priceTrade` inside the transaction is the easy mistake here.
- **Idempotency is the composite unique `(wallet_id, signature)`.** `ON CONFLICT DO NOTHING
  … RETURNING` returning no row means an earlier or concurrent run already persisted this
  exact trade, and that is the signal to skip **both** the `trade.excluded` event and the
  re-evaluation — otherwise a re-run double-records decisions against unchanged state.
  Unique *per wallet*, not globally: one signature can legitimately be two users' trade.
- **The windowed history is read before the trade is inserted**, so a trade can never count
  as its own prior history. `loadWindowedTrades`' exclusive upper bound depends on this
  ordering, and it is what makes same-second `blockTime` collisions a non-problem.
- **The Helius filter is keyed off the cursor, not off `isBaseline`.** A prior run that
  found zero transactions leaves the cursor null too, and with no slot to anchor on only a
  time filter resumes correctly.
- **Baseline rows emit no events at all.** No `trade.excluded`, no
  `rule.decision_recorded`. They are a private behavioural record, not enforcement; a user
  must never be shown a violation for something they did before they wrote the rule.
- **Fail closed at the client.** A disabled `chain.helius` flag or any request error
  *throws*. Returning `[]` would read downstream as "this wallet has no trades" instead of
  "we could not check", which silently marks a reconciliation `current` on no data.
- **Wallet identity comes only from `resolveSession()`.** No function below
  `reconcileWallet` takes a wallet id from anything a caller supplies.
- **`MAX_PAGES` is a real bound, not a formality.** No unbounded loop against an external
  API; hitting it logs a truncation warning rather than looping or failing.

## The swap heuristic (`derive-swaps.ts`)

One transaction produces exactly **one** `DerivedSwap` — a real trade (`excludedReason:
null`, both legs populated) or an excluded candidate carrying its reason and whichever leg
could be identified. `reconcile-wallet.ts` persists a row either way, which is what lets the
status page say *why* something was not counted instead of just omitting it.

Two things are load-bearing rather than incidental:

- **Native SOL is normalized onto the wSOL mint.** That is what makes wrap/unwrap
  self-cancel for free — the lamport debit and the wSOL credit merge under one map key and
  net to ~0 — with no special-cased wrap detection to keep in sync.
- **The fee is added back for the fee payer**, whose post-balance already has it deducted.
  Without it every SOL leg is quietly off by the fee.

| `excludedReason` | Means |
| ---------------- | ----- |
| `missing_block_time` | no chain timestamp, so the trade cannot be honestly placed in a rolling window — excluded rather than defaulted to the epoch |
| `no_net_change` / `wrap_unwrap` | nothing moved; the second when the wallet had a real wSOL token account in the tx |
| `pure_receive` / `pure_send` | one-sided — a transfer, an airdrop, not a bet |
| `lst_swap` | both legs in `LST_MINTS` — economically a staking action |

`RENT_NOISE_LAMPORTS` prunes sub-0.003 SOL wSOL movement: comfortably above the ATA
rent-exempt minimum, far below any real trade.

**`LST_MINTS` is curated and deliberately non-exhaustive** — the majors by TVL, not every
LST that exists. A missing one is a swap counted as a trade, which is the safe direction to
be wrong in; a wrongly-added mint silently *stops* counting real trades. Add only mints
verified against the issuer's own docs. The set is shared, not duplicated: Phase 5's
`classify-token.ts` reads the same one, so exclusion and classification cannot drift.

## Events

All carry the run's `correlationId`, so one reconciliation is one thread through the logs.

| Event | When |
| ----- | ---- |
| `wallet.backfill_started` / `wallet.backfill_completed` | the baseline run |
| `wallet.reconciliation_started` / `wallet.reconciliation_completed` | every later run |
| `wallet.reconciliation_failed` | Helius or persistence threw; state set `failed` |
| `trade.excluded` | live, non-baseline, newly-inserted excluded candidate |
| `rule.decision_recorded` | live real trade evaluated against an active constitution |

The last two are written **inside the batch transaction**, so a decision cannot exist
without the row that caused it, or vice versa. `failReconciliation`'s own bookkeeping is
wrapped so it can never mask or throw past the original error.

## Kill switches

Two, at different layers, both seeded by `src/server/db/seed.ts`:

| Flag | Off means |
| ---- | --------- |
| `chain.helius_reconcile` | the route answers `503` and the status page hides the control — no run starts |
| `chain.helius` | the client throws — an already-started run fails closed rather than persisting a truncated history |

Neither deletes anything already reconciled; both stop new reads. A flag lookup that itself
fails is treated as off.
