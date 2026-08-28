# The server hashes the message, checks the fee payer itself, and refuses sign-and-send

**Decision:** The signed-swap path (`client/wallet/use-swap-signing.ts` →
`POST /api/swap/submit` → `server/swap/submit-service.ts`) is built on four rules:

1. **The hash is over the compiled `TransactionMessage`, never over a signed transaction.**
   `assemble-transaction.ts` hashes the message bytes at quote time and stores them as
   `trade_intents.tx_message_hash`; `submit-service.ts` decodes the wallet's wire-format bytes,
   **extracts `messageBytes`** (dropping the signature map the wallet prepended) and hashes
   *that* before comparing.
2. **The compiled message's fee payer — its first required signer — is checked against the
   session wallet's address**, read out of the message itself, independently of both the hash
   comparison and `intent.wallet_id == session.walletId` (decision 13).
3. **A wallet that offers only `solana:signAndSendTransaction` is refused, not accommodated.**
   `resolveSigningCapability` names it as its own outcome (`sign_and_send_only`) with its own
   user-facing copy.
4. **The guarded `→ signed` UPDATE accepts `status IN ('quoted','approved')`, and zero rows
   returned is not automatically an error** — it is first tested against the idempotent-replay
   case.

**Why:**

**(1) Message, not transaction.** No signature exists when the intent is created, and signature
bytes vary per signing — the same message signed twice by the same key is not guaranteed to
produce identical wire bytes. A hash taken over the whole signed transaction could therefore
never match a hash taken before any signature existed, and "hash the thing the wallet handed
back" is the single most natural mistake available on this path. Extracting the message is what
makes the comparison meaningful: the bytes the user signed are byte-identical to the bytes the
server compiled, or they are not ours.

**(2) The fee payer, checked separately.** The three checks cover three different failures and
none of them implies the others:

- `intent.wallet_id == session.walletId` proves the *row* belongs to the caller. It says
  nothing about the bytes.
- The hash proves the *bytes* are ones we compiled. It does not prove they are this session's —
  a leaked or shared quote is still a message we compiled.
- The fee payer is the account the transaction actually **spends from**, read from the message
  rather than inferred. It is the only one of the three that answers "whose money moves".

Defence in depth is the point: any single check failing open must not open the path. This is
also why the client performs its own fee-payer comparison before prompting and re-reads the
connected address *after* the prompt returns — both are conveniences that the server repeats
and does not trust.

**(3) Refusing `signAndSendTransaction`.** This is a deliberate deviation from the plan's Phase
3 success criteria, which read as though both signing methods would be supported. They will not
be. `signAndSendTransaction` broadcasts from inside the wallet, which means the transaction
leaves for the network without ever passing back through `POST /api/swap/submit`: no
verification of the signed bytes against `tx_message_hash`, no submit-time re-evaluation
against fresh allowance, no `trade.intent_signed`/`trade.intent_submitted` audit trail — and,
most of all, no `chain.broadcast` kill switch in front of a real mainnet send. Supporting it
would put a code path in production whose only safety property is that the user's wallet was
polite. A wallet that cannot sign without sending is a wallet this product cannot enforce
against, and saying so plainly ("use a wallet that supports signing on its own") is the honest
answer. It is detected and named — never silently substituted for `signTransaction`.

**(4) The signable status set, and zero rows.** `quote-service.ts` writes `quoted` only for an
*allowed* verdict; a blocked quote is written `blocked` **and** carries `tx_message_hash: null`,
so the hash equality in the same WHERE excludes it on its own. The status list is therefore not
what keeps a blocked trade unsignable — two independent conditions are. `approved` is in the
set because the schema reserves it for a later explicit-approval step, and admitting it now
means introducing that step is not a breaking change.

Zero rows from the guarded UPDATE means only "the precondition did not hold"
([guarded-state-transition](../patterns/guarded-state-transition.md)). The caller re-reads to
find out which: an intent already `signed`/`submitted`/`confirmed` whose recorded hash matches
the bytes in hand is the *same* submit arriving twice — a retry, a double-click, a replayed
request — and answering it with the original result is correct behaviour, not leniency.
Answering with an error would tell a user their trade failed when it did not, and would write a
failure into the audit trail that never happened. That branch records no events and
re-transitions nothing.

The replayed answer's `dryRun` is read back from the recorded `trade.intent_submitted` event,
**not** from `chain.broadcast` as it stands at replay time. The flag is a fact about the
present; the event is the only record of what that submit actually did. Once Phase 6 turns
broadcasting on, re-reading the flag would answer the replay of a genuinely broadcast trade
with "verified, not broadcast" — telling a user no funds moved when they had. A submit with no
recorded outcome yet (a concurrent one still mid-broadcast) answers `null`, which is a third
state and not a dry run.

**Rejected:**

- **Hashing the signed transaction** — could never match, and the failure would look like a
  tampering alert rather than a bug.
- **Trusting the hash match to prove wallet identity** — a matching hash proves provenance, not
  ownership; the account that pays is a separate fact.
- **Dropping the fee-payer check because `intent.wallet_id` is already compared** — the row and
  the bytes are two different objects, and the second is the one that spends.
- **Falling back to `signAndSendTransaction` when `signTransaction` is absent** — bypasses the
  entire submit gate and the broadcast kill switch. A wider wallet compatibility matrix is not
  worth an unenforceable trade.
- **Treating zero rows as a failure** — turns every double-click into a reported failure and
  pollutes the audit trail.
- **Re-reading `chain.broadcast` on the replay branch** — correct only while the flag never
  changes, i.e. only until Phase 6.

**Constraints it creates:**

- Anything that changes how the message is compiled (`assemble-transaction.ts`) changes the
  hash on both sides at once. The two hashing sites must stay byte-identical in what they feed
  `sha256`.
- A new signable status must be added to `SIGNABLE_STATUSES` *and* be a status whose rows carry
  a `tx_message_hash`, or the guard silently stops matching.
- Wallets that only sign-and-send stay unsupported for trading. If that ever changes, it needs
  a different broadcast story — not a relaxed capability check.
- `SubmitResult.dryRun` is `boolean | null`; callers must render the unknown case rather than
  collapsing it to either answer.
- Every new refusal is a named `SubmitRejectionReason` with a `trade.intent_failed` event. A
  submit that fails silently, or that fails without saying which check refused it, is a bug.
