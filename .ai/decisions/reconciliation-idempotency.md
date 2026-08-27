# Reconciliation correctness invariants

**Decision:** `apps/web/src/server/chain/reconcile-wallet.ts` is idempotent and
concurrency-safe by construction, enforced by the **database**, not by application
bookkeeping. Five invariants carry that, and Phases 5 and 6 add columns and rule types on
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
