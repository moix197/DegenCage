# Wallet account-switch desync is an accepted limitation

**Decision:** When a user switches the active account in their wallet extension without
disconnecting, the UI keeps showing the previous account and the session cookie stays
live — `resolveSession()` keeps authenticating as the **old** address until the next full
page load. After four attempts this is accepted as a known limitation, not a bug we keep
chasing.

**Why:** The desync is real, not cosmetic. Three account-switch revokes each recorded
`sessions.last_seen_at` **0.7–2.1s before** `revoked_at` — authenticated requests were
served as the old address after the switch had already happened. `auth.wallet_account_switched`
had zero rows at that point, because it was only emitted server-side in
`supersedePreviousSession`, never by the client watcher.

Root cause: nothing drove a re-render on account change. The original watcher effect's
deps only re-fired on remount; the design was described as "polls every render" but
nothing generated a render.

Four fixes, in history:

| Commit | What it did |
| ------ | ----------- |
| `048976c` | Force re-auth when the active account changes (client-side detection; reviewed RED) |
| `617ee51` | Make session supersede atomic and fail closed on revoke failure — **verified good, stands on its own merits** |
| `734132f` | Only show the account-switch notice on an actual switch |
| `e6453ad` | Subscribe to account changes via `useSyncExternalStore` over three channels: the plugin store's fan-out of wallet-standard `standard:events change`, per-wallet `standard:events` subscriptions, and a `focus`/`visibilitychange` re-read backstop |

Even after `e6453ad` the UI does not resync reliably on switch. **Jupiter's own site
exhibits the same behavior** — this is an ecosystem-wide wallet-standard propagation
problem, not a DegenCage defect, and further effort has poor expected return until the
underlying libraries fix it.

The practical mitigation: if the newly-selected wallet attempts to sign, it gets an
error. The switched-to account cannot transact under the stale session. The exposure is
a stale *display* plus a still-live session for the old address until the next page load —
not the ability to trade as the wrong identity via a signature.

**Rejected:**

- **Keep iterating on client-side account-change detection** — four attempts across
  three independent channels did not produce reliable resync; the signal is not
  dependably emitted by the extensions.
- **Poll the wallet on an interval to force renders** — turns a correctness problem into
  a battery/noise problem and still races the extension's own state.
- **Ship it as fixed** — the evidence above says it is not, and silently claiming it
  would leave the residual risk below undocumented.

**Constraints it creates:**

- **Any authenticated request in that window is served as the OLD address.** This matters
  more here than in a typical app because rule evaluation is scoped per-wallet
  ([server-side-rule-evaluation](server-side-rule-evaluation.md)): a request in that
  window is checked against the wrong account's limits.
- Anything added later that acts on `resolveSession()` **without requiring a fresh
  signature** must account for this.
- Signing is the only identity check that holds during the window. Do not treat session
  identity alone as proof of the active wallet.

**Revisit when:**

- Before Phase 4 (wallet accountability), or before any flow that reads session identity
  without requiring a fresh signature.
- Wallet-standard or the Solana wallet libraries ship reliable account-change propagation.
- Jupiter or another major Solana app solves it — re-check their approach.
