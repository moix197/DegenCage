# The server assembles the bytes and decides twice

**Decision:** The trading terminal is a server relay, not a client that talks to Jupiter.
`POST /api/swap/quote` (`server/swap/quote-service.ts`) builds, prices, evaluates **and
compiles** the unsigned v0 message; the browser's only job is to hand those bytes to the
wallet; `POST /api/swap/submit` (`server/swap/submit-service.ts`) re-runs the rule engine
against fresh state before anything is broadcast. The browser is never given raw instructions
to assemble, and never told a verdict it could act on independently of the bytes.

**Why:**

**The verdict and the bytes must come out of the same pass.** If the client assembled the
transaction, the server's "allowed" would apply to a *description* of a trade while the wallet
signed something the server had never seen. Compiling server-side is what produces a
compiled-message hash **before any signature exists**, and that hash is the only thing that
later lets submit prove the signed bytes are the ones the rules approved. (The hashing rules
themselves, the fee-payer check and the sign-and-send refusal are in
[swap-signing-and-submit](swap-signing-and-submit.md) — not repeated here.)

**The trust boundary extends to Jupiter's own account map.** `assemble-transaction.ts`
re-reads every address-lookup table from chain via Helius rather than trusting
`addressesByLookupTableAddress` from `/build`. A lookup table is what decides which real
accounts each compressed index resolves to, so taking the response's word for it would let a
wrong or tampered map compile a message touching accounts nobody reviewed. Only the set of
table *addresses* is taken from Jupiter.

**Deciding once is deciding too early.** The gap between quote and signature is however long
the user stares at the screen, and during it they can trade elsewhere, or their constitution
can change. So submit re-reads the allowance and re-evaluates. It also requires the *same*
active constitution row (`constitution_changed`): an intent judged under rules no longer in
force fails closed rather than being re-judged under the new ones, which would silently let a
just-loosened limit bless a trade the user committed against.

**Expiry is a write, not a filter.** `trade_intents` is rule state, so every expiry is a
guarded `UPDATE ... SET status = 'expired'` (`intent-lifecycle.ts`), never the `DELETE` that
`challenge-reaper.ts` / `login-attempt-reaper.ts` use — those rows carry no product meaning and
these are the audit trail. Read-side filtering is not an option either: Postgres requires
partial-index predicates to be immutable, so `expires_at` cannot appear in the quote-slot unique
index, and a row whose wall-clock expiry has passed still occupies the slot until its `status`
actually flips. Hence an active reaper, called inline (this repo has no scheduled-job
infrastructure) from both the quote path and every live-intent sum. Which statuses those two
predicates cover, and why they differ, is
[live-intent-reservation-vs-quote-slot](live-intent-reservation-vs-quote-slot.md).

**Rejected:**

- **Client-side assembly (Jupiter's own terminal shape)** — the server would approve a trade it
  cannot recognise afterwards, and there would be nothing to hash a signature against.
- **Trusting `addressesByLookupTableAddress`** — saves one RPC round trip and gives an external
  service the final say over which accounts the user signs for.
- **Evaluating only at quote time** — the signature arrives against state that has moved.
- **Re-judging under a changed constitution at submit** — turns a mid-flight loosening into
  retroactive permission for a trade quoted under the old rules.
- **`DELETE`-based reaping, matching the existing reapers** — consistent, and it erases the
  decision history the product exists to keep.

**Constraints it creates:**

- `quote-service.ts` is the only place a signable message is produced, and a blocked quote is
  never assembled at all (`tx_message_hash` stays `null`). Any future "approve later" step must
  keep both properties.
- Every `trade_intents` status change is a guarded `UPDATE` per
  [guarded-state-transition](../patterns/guarded-state-transition.md). No path may delete one.
- Submit is idempotent by design — a replay returns the original result and records no new
  events. Any new submit-side effect must sit on the branch where the guarded `UPDATE` actually
  returned a row (see [swap-signing-and-submit](swap-signing-and-submit.md)).
- A dependency that throws anywhere in the quote pass blocks and records nothing as allowed;
  the evaluation itself is still persisted as a `rule.pre_trade_decision` even when assembly
  fails after it, so a reached verdict never vanishes.
