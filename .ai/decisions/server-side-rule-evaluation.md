# Rules are evaluated server-side

**Decision:** Rule evaluation happens on the server, against server-authored timestamps.
The client renders decisions; it never makes them. Same for timelock countdowns and
cooldown expiry.

**Why:** Two independent reasons, either one sufficient.

1. **The mechanism.** A constitution enforced in the browser is decoration — devtools
   bypasses it in seconds. The commitment mechanism *is* the product, so it cannot live
   somewhere the user can edit while emotional.
2. **The measurement.** Phase 0's entire deliverable is behavioral data: do people
   complete onboarding, set limits, activate them, keep them, violate externally, come
   back. Client-held state and client-authored timestamps make that data worthless, and
   there is no second chance to collect Phase 0 data.

Note the distinction from the accepted bypass: a user going to Jupiter directly is fine
and expected (CLAUDE.md). A user bypassing the rules *inside our own app* is not.

**Rejected:**

- **localStorage-only Phase 0 to skip the database** — the cheapest thing to build, and
  it destroys both the mechanism and the measurement that Phase 0 exists to produce.

**Constraints it creates:**

- Every rule decision is a server round-trip that emits a structured event carrying the
  inputs that produced it (see CLAUDE.md → *Observability*).
- Client-supplied timestamps are untrusted input.
- Optimistic UI may *predict* a decision, but must reconcile against the server's, and
  must never let a predicted allow become an executed trade.
