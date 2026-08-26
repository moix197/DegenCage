# Guarded state transition: the precondition goes in the UPDATE

**Pattern:** a transition of any row holding rule state or identity is one statement —
`UPDATE … SET <next state> WHERE <owner> AND <precondition> RETURNING *` — and the caller
branches on whether a row came back. Never `SELECT`, decide in application code, then
`UPDATE` by id.

**Where it is already used** (this is recorded because it recurred, not in anticipation):

| Site | Precondition carried by the WHERE |
| ---- | --------------------------------- |
| `server/auth/solana-siws.ts` — nonce consume | `consumed_at IS NULL` |
| `server/auth/solana-siws.ts` — `claimRejectionEventSlot` | `rejection_recorded_at IS NULL` |
| `server/auth/session.ts` — revoke | `revoked_at IS NULL` |
| `server/constitution/commitment.ts` — `updateExistingDraft` | `status = 'draft'` |
| `server/constitution/commitment.ts` — `startCommitment` | `status = 'draft'` |
| `server/constitution/commitment.ts` — `attemptAtomicActivation` | `status = 'committing'` **and** the commitment period has elapsed |

**Why:** the check-then-act alternative is a TOCTOU hole at every one of those sites, and
the holes are not theoretical. A draft save racing a commit was found in review to swap the
*committed* document while leaving the clock untouched — the user edits the constitution
they are already committed to, and the 20-minute wait certifies text that is no longer
there. The commitment mechanism fails, silently, with no error anywhere. The concurrency
that gets you there is a double-click, a retry, or a second tab, not an exotic attack.

**Zero rows returned is not automatically an error.** It means only "the precondition did
not hold." The caller then re-reads to decide *which* case it was, and the distinction is
usually the difference between correct and merely safe: an already-`active` constitution is
an idempotent no-op, while a still-`committing` one is a genuine early-activation rejection
worth recording. Collapsing both into a failure would make the loser of a harmless race
look like an attempted violation in the audit trail.

**Constraints it creates:**

- State read in order to authorize a write must not be a separate statement from that write.
- A time-based precondition uses the database's clock — see
  [decisions/commitment-window-server-clock](../decisions/commitment-window-server-clock.md).
- The guard implying a column is non-null does not license a `!` on it. On a money-adjacent
  path, verify and fail closed: `activateConstitution` captures an error and rejects when a
  `committing` row somehow has no `commitment_started_at`, rather than asserting.
- The lock and the SQL guard are belt-and-braces where both exist (the nonce consume also
  takes `SELECT … FOR UPDATE`); removing the WHERE because a lock is present reintroduces
  the race the moment the lock's scope changes.
