# DegenCage takes no platform fee on a routed swap

**Decision:** `server/swap/jupiter-client.ts` never sends `platformFeeBps` or `feeAccount` to
`/swap/v2/build`, and `jupiter-client.test.ts` asserts the built URL contains neither — the
absence is a tested property, not an omission waiting to be filled in.

**Why:** a per-trade fee earns more the more the user trades. The product sells the opposite:
friction against their own trading, up to and including refusing the trade outright. Holding
both at once means every blocked trade costs us revenue and every relapse pays us — the
incentive points directly at the thing we are supposed to be defending the user from, and no
amount of good intent survives that gradient.

It is also unenforceable as a business. The user can always go straight to Jupiter
(non-custodial, by design — CLAUDE.md), so a fee is a standing reason to leave, priced against
a free alternative that does everything except stop them.

Secondary, but real: a fee account is not a query parameter, it is extra instructions — a
referral / fee ATA in the assembled message, which changes compute consumption and therefore
the compiled message and its hash. "Just turn it on" is a change to the signing path, not a
config toggle.

**Rejected:**

- **A small default bps "while it's cheap"** — the conflict is structural, not proportional to
  the rate, and a fee buried in a route the user does not read is exactly the kind of quiet
  cost this product is against.
- **A per-user or flag-gated fee** — same conflict, now conditional and harder to reason about,
  with a live-money code path whose only test coverage would be the case we hope stays off.

**Constraints it creates:**

- Revenue, if it ever arrives, must not scale with trade count or notional. Anything
  volume-linked re-opens the conflict above; the growth path
  ([hosting-and-growth-path](hosting-and-growth-path.md)) assumes no per-trade take.
- Revisiting this is not a parameter change: it needs fee-account derivation per output mint,
  re-measured compute units, the fee disclosed in the quote view before signing, and this
  record rewritten — not appended to.
- The `not.toContain('platformFeeBps' / 'feeAccount')` assertions are the trip wire. Deleting
  them is the change, whatever else the diff says.
