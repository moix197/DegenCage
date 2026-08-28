# Jupiter `/swap/v2/build` is one call, and it under-specifies more than it looks

**Decision:** One `GET api.jup.ag/swap/v2/build` per quote is the whole Jupiter surface for
trading: it returns the route *and* the raw instructions together, and we compile from those
ourselves. `server/swap/jupiter-client.ts` always throws on failure, never retries, requires
`JUPITER_API_KEY`, and asks for an explicit blockhash lifetime
(`BLOCKHASH_SLOTS_TO_EXPIRY = 150`) rather than accepting the default.

**Why:**

**One call, so the quote and the bytes describe the same route.** A separate quote-then-build
pair can return two different routes between calls, which would mean showing the user a verdict
computed for a trade the assembled message no longer performs.

**A 200 is not a pre-check.** `/build` documents no taker-balance check (contrast `/order`,
which reports one via `errorCode: 1`), and `400 { "error": string }` is the only documented
failure shape. Insufficient balance and slippage failures must be assumed to surface at
simulate/send time instead. So an unexpected body is surfaced raw rather than parsed into a
taxonomy that does not exist, and the CU simulation in `assemble-transaction.ts` — not the HTTP
status — is what actually stands between a quote and a doomed transaction.

**The compute-unit limit has to be measured.** The response carries a CU *price* but never a
limit, so the limit comes from simulating a throwaway message at the 1,400,000 maximum and
taking `unitsConsumed × 1.2`. A failed simulation blocks the quote outright: a guessed limit is
a swap that fails on chain **after** the user signed and paid fees. Jupiter's own
compute-budget instructions are passed through with any `SetComputeUnitLimit` filtered out —
two of them is `DuplicateInstruction`, which likewise only fails after signing.

**There is no quote TTL, so `expires_at` is ours.** The response has no wall-clock expiry, and
`lastValidBlockHeight` is only comparable against a current block height we would have to spend
another RPC call to fetch — and would be no more authoritative afterwards. Since we *ask* for a
known slot lifetime, the honest derivation is that lifetime from `fetchedAt` at ~400ms/slot.
`trade_intents.expires_at` is therefore a deliberately conservative estimate, never a value
Jupiter handed us — which is why a `signed`/`submitted` intent keeps reserving allowance past
it ([live-intent-reservation-vs-quote-slot](live-intent-reservation-vs-quote-slot.md)).

**Mainnet only.** Jupiter's swap API has no test network, and Helius' endpoints here are
mainnet. There is no staging environment for this path at all, which is the reason the rehearsal
is `chain.broadcast` off plus simulation rather than a devnet run, and why the terminal tells
the user plainly that signing means signing for real.

**One RPS, shared.** The Free tier's budget is org-wide across `/build` and
`/tokens/v2/search`, so the two compete with each other inside a single quote. Hence the 500ms
client debounce, the 3s wallet-keyed build cache, `jupiter-tokens.ts`' in-flight coalescing —
and no retries anywhere, since a retry storm converts a slow call into a rate-limited one.

**Rejected:**

- **Treating a 200 as proof of balance and liquidity** — undocumented, and the failure would
  land after signing.
- **Retrying a failed `/build`** — spends the same shared 1 RPS bucket that caused it.
- **Deriving expiry from `lastValidBlockHeight`** (the original plan's shape) — needs a block
  height we do not have, costs an extra RPC call, and yields an estimate either way.
- **A default CU limit when simulation fails, or letting Jupiter's own `SetComputeUnitLimit`
  through** — both produce a transaction that fails only after the user has signed it.
- **`lite-api.jup.ag`** — being retired; the host disappearing mid-phase is a live risk, not a
  hypothetical.

**Constraints it creates:**

- Every `/build` call goes through `buildSwap`, which is flag-gated (`jupiter.swap_build`) and
  throws on every failure path. A permissive resolve here would let a quote proceed without the
  route it is quoting.
- The quote cache key must include the wallet: `taker` is baked into the returned instructions
  (ATA derivation, transfer authority), so a pair-and-amount key would serve one user's
  assembled transaction to another's session.
- Nothing may treat `expires_at` as an authoritative on-chain deadline.
- Any new work added to the quote path is another call against a shared 1 RPS budget — a quote
  already makes up to four sequential external calls, and that is the latency budget the
  debounce is sized for.
