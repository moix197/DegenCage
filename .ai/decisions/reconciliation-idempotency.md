# Reconciliation correctness invariants

**Decision:** `apps/web/src/server/chain/reconcile-wallet.ts` is idempotent and
concurrency-safe by construction, enforced by the **database**, not by application
bookkeeping. Six invariants carry that, and later phases add columns and rule types on
top of them rather than re-deciding them.

1. **Dedup key is `(wallet_id, signature)`, not `signature`.** Unique index +
   `INSERT ... ON CONFLICT DO NOTHING ... RETURNING`. Zero rows returned means "already
   persisted", and the run then also skips the `trade.excluded` / `rule.decision_recorded`
   events — so a re-run duplicates neither rows nor audit-trail entries.
2. **One row-locked transaction per batch** (100 swaps): `SELECT ... FOR UPDATE` on the
   wallet row serializes concurrent reconciliations of the same wallet.
3. **Pricing happens outside that transaction.** `priceBatch` (Binance HTTP) runs first;
   `persistBatch` under the lock does DB work only.
4. **The cursor advances by `GREATEST(COALESCE(cursor, 0), highest_slot)`**, inside the same
   transaction as the batch's inserts.
5. **`wallets.baseline_completed_at` — not `reconciliation_state` — decides "is this the
   baseline pull".** Written exactly once, only on a successful baseline run, and for the
   final batch it rides inside that batch's own cursor `UPDATE`.
6. **`wallets.lots_built_through_slot` (Phase 6) is a second cursor for FIFO lot-matching
   (`lot-matching.ts`), independent of `reconciled_through_slot` and never assumed to equal
   it.** `rules.loss_limit_enabled` can be off while `reconciled_through_slot` keeps
   advancing; a trade persisted during that window is deduplicated by (1) forever and a
   normal re-run never revisits it, so it would simply never reach `position_lots`, leaving a
   permanent hole in FIFO order. `reconcileWallet()` detects the gap
   (`needsLotBackfill(lotsBuiltThroughSlot, reconciledThroughSlot)`, a pure predicate with its
   own unit tests) and backfills exactly the missing range **from `trades`, not Helius** — in
   the same true chronological order (`slot`, then `transaction_index`) live matching uses —
   before any new trade in the current run is matched against `position_lots`. Only advances
   when `rules.loss_limit_enabled` is actually on for the run doing the advancing, or the
   cursor itself would falsely certify trades as lot-matched that were skipped.

**Why:**

Per-batch rather than per-run locking keeps a 90-day backfill from holding one wallet lock
for its entire duration, and confines a mid-run failure's rollback to its own page.

Holding a row lock across a network round trip is how a slow external API turns into
database contention, so (3) is the rule that makes (2) affordable — the lock is held for
writes only.

`GREATEST` and not a blind `SET`: a concurrent run's batch may already have advanced the
cursor past this batch's highest slot. A cursor that can move backward re-pulls a range
that (1) then discards — correct but wasteful — and, worse, makes "reconciled through"
untrue while it is regressed.

(5) is the subtle one and was a real bug before it was fixed. `reconciliation_state` cannot
express "the backfill finished": `failed` and `in_progress` are both reachable *mid*-baseline,
so deriving baseline-ness from state (or from a non-null cursor) makes the retry after a
first-connect Helius outage — the common failure — run as a **live** pull. Pre-commitment
history would then be fed to `evaluateTrade()` and surfaced as violations the user never
agreed to be judged on. A dedicated write-once column is the only shape that survives a
failed first run. Folding it into the final batch's `UPDATE` closes the same hole one commit
narrower: a crash between "cursor advanced" and "baseline marked" would have re-tagged
genuinely live trades as baseline.

(6) is Phase 6's own version of the same class of bug, caught in code review before it ever
shipped live: a kill switch that gates *matching* but not *reconciliation* creates exactly
the kind of gap (5) exists to prevent, just one column over. If `lots_built_through_slot`
simply tracked `reconciled_through_slot` (or was inferred from it), flipping
`rules.loss_limit_enabled` off then back on would silently resume matching mid-stream —
every disposal after the gap would draw down whichever lot *happens* to still be in
`position_lots` (usually a newer, wrongly-eligible one) instead of the true oldest lot sitting
unmatched in the gap, misclassifying an ineligible close as eligible with no error, no failed
test, and no visible symptom short of an audited-after-the-fact wrong number. A second,
independently-advanced cursor plus a from-`trades` backfill is the only shape that makes
"caught up" and "has a gap" both honestly answerable.

**Rejected:**

- **A global unique index on `signature`** — a signature is unique per *transaction*, and one
  transaction can involve two wallets we track. `ON CONFLICT DO NOTHING` would silently drop
  the second wallet's row.
- **An advisory lock or an application-level "is running" flag** — a crashed process leaves
  the flag set; a row lock is released by the transaction ending, however it ends.
- **One transaction for the whole run** — long lock, and one bad page loses a completed
  backfill.
- **Deriving `is_baseline` from `reconciliation_state` or from `reconciled_through_slot`** —
  see above; both misclassify a retried first connect.
- **Resuming lot-matching mid-stream off `reconciled_through_slot` when `rules.loss_limit_enabled`
  flips on** — see (6); the gap is silent and the corruption is in money math, not a crash.

**Constraints it creates:**

- Baseline trades are a **private behavioral record**: never passed to `evaluateTrade()`,
  never counted in a rolling window, and they emit no `trade.excluded` or
  `rule.decision_recorded` event at all.
- The windowed history for a trade is read **before** that trade is inserted, giving an
  exclusive `asOf` upper bound — so a trade never counts itself, and same-`occurred_at`
  trades (block time is second-granularity) need no finer tiebreak.
- Which range to pull is keyed off the cursor, **not** off `is_baseline`: a prior run that
  found zero transactions leaves the cursor null too, and only a time-based filter can
  resume with no slot to anchor on.
- A baseline run that finds genuinely zero transactions still must be marked complete
  (there is no final batch to fold the write into), or every app open re-runs the 90-day
  pull as baseline.
- Wallet identity comes from `resolveSession()` only; no function in this pipeline accepts a
  caller-supplied wallet id.
- Lot-matching runs for *baseline* trades too, not only live ones — the mechanism behind
  decision 1's "opened and closed after activation": a live disposal years later can only
  tell a baseline-era acquisition apart from a post-activation one if the baseline
  acquisition was itself recorded as a lot. Baseline lots are still never surfaced as an
  event (same privacy rule as everything else in this file); only `position_lots` itself and
  `trades.is_round_trip_close`/`realized_loss_usd` are written for them.
- FIFO lot ordering is `slot`, then `transaction_index` — never `opened_at`/`occurred_at`
  alone, whose second-granularity `blockTime` cannot break a same-second tie.
- The quote leg of a swap (SOL, an LST, or a stablecoin — `isQuoteMint`) never opens or
  consumes a lot: a TOKEN→SOL swap tracks only TOKEN, or the realized-loss figure would be
  inflated by the quote currency's own price movement, not the trader's actual bet.
