# Wallet connection + authenticated server sessions (Phase 0 research)

> **PERISHABLE RESEARCH — verified 2026-08-26. Re-check before relying on it.**
>
> Provider free-tier limits, credit/CU costs, rate limits, and endpoint hostnames rot
> fast. An earlier pass of this research was already wrong twice: it put Pyth's API-key
> requirement at 2026-07-31 (actually 2026-08-26) and understated Birdeye's free
> allowance by ~2.5x. Treat every number below as a starting point to verify, not a fact.
>
> Durable choices — which provider and why — live in `.ai/decisions/` and
> `plans/phase-0-commitment-mechanism.md`. This file holds only the perishable detail
> that would be expensive to re-derive mid-implementation.
>
> **Delete at Phase 0 closeout**, once the working code is the record of which
> endpoints are actually in use.

Researched 2026-08-26. All versions/dates verified against the npm registry and GitHub API
on that date, not from memory.

---

## 1. How you connect a Solana wallet in 2026

**The ecosystem moved. `@solana/wallet-adapter-react` is on the legacy track.**

The official Solana docs (`solana.com/docs/frontend`) now state plainly: *"web3.js v1 and
wallet-adapter are legacy. For new work, prefer `@solana/kit` with the kit plugins below;
Wallet Standard discovery (via `@solana/kit-plugin-wallet`) replaces wallet-adapter for
modern wallets."*

Evidence, not vibes:

| Package | Latest | Last publish | Note |
| --- | --- | --- | --- |
| `@solana/wallet-adapter-react` | 0.15.39 | **2025-06-10** | 14 months without a release; peer-depends on `@solana/web3.js` v1 (itself legacy). Not formally deprecated. |
| `@solana/kit` | 8.0.0 | 2026-08-21 | active |
| `@solana/react` | 8.0.0 | 2026-08-21 | active |
| `@solana/kit-plugin-wallet` | **0.18.0** | 2026-08-21 | active, but **pre-1.0** |
| `@solana/wallet-standard-util` | 1.1.3 | 2026-06-18 | server-side verification |
| `@wallet-ui/react` | 4.3.0 | 2026-08-19 | optional prebuilt connect UI on top of `@solana/react` |

`anza-xyz/wallet-adapter` repo last pushed 2026-06-18 (still nominally maintained), but with
no npm release it is effectively frozen. `anza-xyz/kit` was pushed the day of this research.

### The recommended shape

`@solana/kit-plugin-wallet` exposes four plugins (`walletSigner`, `walletPayer`,
`walletIdentity`, `walletWithoutSigner`). We want **`walletSigner`** — the user's wallet is
both fee payer and identity (non-custodial, they sign).

```ts
const client = createClient()
  .use(walletSigner({ chain: 'solana:mainnet' }))
  .use(solanaRpc({ rpcUrl: process.env.NEXT_PUBLIC_RPC_URL! }));
```

It handles Wallet Standard discovery, connection lifecycle, account selection and signer
creation. Phantom/Solflare/Backpack all advertise via Wallet Standard, so **no per-wallet
adapter packages** — this is the big dependency win over wallet-adapter, which pulled in
`@solana/wallet-adapter-wallets` (40+ adapters, plus deprecated WalletConnect v1 transitive
deps).

State/actions on `client.wallet`: `getState()` (`wallets`, `connected`, `status`,
`reconnectingTo`), `connect`, `disconnect`, `selectAccount`, `signMessage`, **`signIn`**,
`whenReady()`.

React hooks live at `@solana/kit-plugin-wallet/react`: `useWalletStatus`,
`useConnectedWallet`, `useWallets`, `useIsWalletReady`, `useConnect`, `useDisconnect`,
`useSignIn`, `useSignMessage`, `useSelectAccount`, plus a `<WalletReadyGate>` component.

### App Router / RSC gotchas (verified by inspecting the published bundles)

1. **`@solana/react`'s dist ships no `'use client'` directive** (grepped
   `dist/index.browser.mjs` — zero matches). Same for the plugin. We must author our own
   `'use client'` wrapper module; importing these from a server component fails.
2. **The Kit client must be built outside the React tree** — module scope, or `useMemo` if
   its config is reactive — and published via `<ClientProvider client={client}>`. The
   reference must be stable across renders. So: one `'use client'` `client.ts` at module
   scope in `apps/web`, one provider mounted as low in the tree as possible so pages and
   route handlers stay server components.
3. **Async plugins suspend.** If any `.use()` is async, `createClient().use(...)` returns a
   promise; `ClientProvider` accepts it and suspends via the nearest `<Suspense>`. Needs a
   `<Suspense>` ancestor or it throws.
4. **Warm-up flash.** A fresh client runs a silent auto-reconnect on mount, passing through
   `'pending'` → `'reconnecting'` before settling. Rendering wallet-dependent UI immediately
   flashes "disconnected". Gate on `useIsWalletReady` / `<WalletReadyGate>`.
5. `sideEffects: false` on the plugin, tree-shakeable — the 3.8 MB unpacked size of
   `@solana/kit` is not what ships.

### Rejected alternatives

- **`@solana/wallet-adapter-react`** — official docs call it legacy; stale on npm; drags
  web3.js v1 in alongside kit. Only reason to keep it would be an ecosystem library that
  demands its context (Jupiter's embeddable terminal is the one to check in Phase 1).
- **`@wallet-ui/react`** — genuinely nice prebuilt connect dropdown/modal built on
  `@solana/react`, actively maintained. But it adds `@zag-js/*` + `nanostores` for a button
  we can write ourselves. CLAUDE.md says build our own where it's not the differentiator's
  hard part. Skip; revisit if the connect UX becomes fiddly.
- **Reown / AppKit** — only earns its place if we need the WalletConnect *protocol* (relevant
  to mobile, see §4). Adds a hosted relay + project id.
- **Privy / Dynamic / Web3Auth** — hosted auth vendors that hold the session, the user
  record, and often embedded keys. Direct conflict with the no-vendor-lock-in constraint in
  `hosting-and-growth-path.md` and with CLAUDE.md's "non-custodial, never private keys".
  Reject for Phase 0.
- **`gill`** — 0.14.0, last publish 2025-11-07. Nice ergonomics over kit but 9 months stale
  and it's a convenience layer we don't need.

---

## 2. Sign-In With Solana (SIWS)

**Status: a first-class Wallet Standard feature, `solana:signIn`.** Authored by Phantom,
modeled on EIP-4361 (Sign-In With Ethereum). It is not a draft sitting in a repo — it is
implemented in the Wallet Standard packages and surfaced directly by `@solana/kit-plugin-wallet`.

**Why it beats connect-then-signMessage:** `signIn` combines authorize + sign into a *single*
wallet prompt. Two popups in a row is where users bail.

Message fields: `domain` and `address` required; `statement`, `uri`, `version`, `chainId`,
`nonce`, `issuedAt`, `expirationTime`, `notBefore`, `requestId`, `resources` optional.

Client:
```ts
const { dispatch: signIn } = useSignIn(client);
const output = await signIn(wallet, signInInputFromServer); // SolanaSignInOutput
// output = { account, signedMessage: Uint8Array, signature: Uint8Array, signatureType }
```

Server: `verifySignIn(input, output)` from `@solana/wallet-standard-util` (69 KB unpacked,
single dependency `@noble/curves`). Pure ed25519 — **no RPC call, no network**, Node runtime
safe. Same package also exports `verifyMessageSignature`, `parseSignInMessage`,
`createSignInMessageText`.

### The critical gotcha — read the source before trusting it

I read `lib/esm/signIn.js`. `verifySignIn` does exactly two things:

1. `deriveSignInMessage` — parses the message the wallet actually signed, then does **exact
   string equality on every field of your input** (`domain`, `address`, `statement`, `uri`,
   `version`, `chainId`, `nonce`, `issuedAt`, `expirationTime`, `notBefore`, `requestId`,
   `resources`) against the parsed message. Any mismatch → `null` → `false`.
2. `verifyMessageSignature` — ed25519 verify of the reconstructed message against
   `account.publicKey`.

**It does NOT check:**
- that `expirationTime` is in the future
- that `issuedAt` is recent
- that the nonce is single-use (no replay protection whatsoever)
- that `domain` is *our* domain — only that it matches whatever you passed in

So the server must do all four itself. `verifySignIn` is a signature+integrity primitive, not
an auth check. Treating it as one is the classic SIWE/SIWS replay bug.

Two more sharp edges from the same source:

- **Omitted fields must stay omitted.** The comparison is `input.x !== parsed.x`, so if you
  pass an input without `statement` and the wallet adds one, verification fails — and vice
  versa. Keep the input minimal and round-trip the *exact stored object*, never a rebuilt one.
- **ed25519 only.** The util assumes the account's public key is the verifying key. Smart-wallet /
  multisig accounts (Squads) cannot be verified this way.

### Fallback path

A wallet that doesn't expose `solana:signIn` will reject `signIn`. Fall back to
`connect()` → `client.wallet.signMessage(serverNonceMessage)` → `verifyMessageSignature` on
the server. Two prompts instead of one, but it works. Worth building because of Ledger (below).

---

## 3. Session handling

### Recommendation: opaque session id cookie + a `sessions` row in Postgres. No auth library.

Rationale, in the project's own terms:

- CLAUDE.md → *Safety infrastructure* requires **per-user kill switches, flippable at runtime
  without a deploy**. A stateless JWT/sealed-cookie session **cannot be revoked**. That single
  requirement disqualifies every stateless option.
- `single-source-of-truth-database.md` already puts Postgres on the request path for every
  rule evaluation. The session lookup is not an extra round trip; it rides along.
- Zero new dependencies: `node:crypto` for a 32-byte random id (store its SHA-256, not the id),
  Next's built-in `cookies()` for the cookie. `await cookies()` — async since Next 15; Next is
  at **16.3.3** (2026-08-25).

Cookie: `httpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, explicit `Max-Age`.

`sessions` table: `id_hash`, `wallet_address`, `created_at`, `expires_at`, `revoked_at`,
`last_seen_at`. Revocation = one `UPDATE`. Kill switch = one `UPDATE`.

### Evaluated and rejected

- **`jose` 6.2.10** (2026-08-21, **zero runtime deps**, 259 KB unpacked, 7.7k stars, actively
  maintained). Best-in-class if we want a signed/encrypted token. But a JWT buys nothing over
  a random opaque id when we're hitting Postgres anyway, and it costs us revocation. *Keep it
  in the back pocket* for a future short-lived stateless access token (e.g. if `apps/worker`
  ever needs to act on a user's behalf). Not needed now.
- **`iron-session` 8.0.4** — last npm publish **2024-11-12** (21 months); repo pushed 2026-04
  with no release since. Stateless sealed cookie ⇒ same non-revocable problem. Skip.
- **Auth.js v5 / NextAuth** — still beta-tagged in 2026, **no official Solana provider** (only
  community credentials-provider examples adapted from SIWE). It takes ownership of the cookie,
  the session model, and a `/api/auth/*` callback surface, in exchange for solving OAuth
  problems we don't have. We are verifying exactly one signature. Wrong altitude, and a large
  footprint for it. (Portability hit is moderate — it's OSS, not a vendor — but the complexity
  cost is real.)
- **Supabase Auth / Privy / Dynamic / Clerk** — vendor owns identity. Violates the
  no-vendor-lock-in constraint. Note: Supabase has an open discussion for native SIWS support;
  even if it ships, adopting it couples our identity to our database vendor, which
  `hosting-and-growth-path.md` explicitly avoids ("no `@vercel/*` wrappers" is the same
  principle applied one layer up).

### Where the code lives

Per `monorepo-package-shape.md`: this is I/O-bound and Next-aware, so it starts inside
`apps/web` (e.g. `src/server/auth/`), **not** in `packages/rules` (which must stay I/O-free).
Extract to `packages/auth` only when a second consumer appears.

---

## 4. Wallet-side UX constraints on a 20-minute commitment flow

**The headline recommendation: front-load authentication.** SIWS in the first 15 seconds, then
run the entire 20-minute constitution-building flow against the server session over plain HTTP.
Every constraint below is neutralised by that ordering, and none of them are by any other.

- **Page reload.** `kit-plugin-wallet` persists the selected account and silently auto-reconnects
  on mount. But the *cookie* is what actually carries identity, and it should be authoritative —
  **never re-prompt SIWS on reload.** Wallet connection state is cosmetic; the cookie is identity.
  This also means: don't gate the flow on `connected !== null`.
- **Mid-flow disconnect.** The user can disconnect from the extension at any moment. Since rules
  are server-evaluated (`server-side-rule-evaluation.md`), a disconnect must NOT invalidate the
  session — defining a constitution needs no wallet. A live connection is required only at the
  final Jupiter signature step (Phase 1).
- **Account switching — a real security hole if missed.** Phantom lets a user switch accounts
  *without* disconnecting. Compare `useConnectedWallet()?.account.address` against the session's
  wallet address on every render; on mismatch, tear down the session and force re-auth.
  Otherwise wallet B signs a trade under wallet A's constitution.
- **Mobile is the weak link.** Mobile browsers have no extension. MWA is Android-only (no iOS),
  and a mobile-web MWA session is not comparable to a desktop connection — see sRFC 22 and the
  long-running wallet-adapter issues on this. The practical 2026 path is still: detect mobile →
  deep-link into the wallet's own in-app browser (Phantom/Solflare universal links), where Wallet
  Standard is injected and everything above works normally. **That app switch destroys in-page
  state**, which is precisely why the 20-minute flow must be server-resumable, or must run after
  auth rather than before it.
- **Hardware wallets.** Ledger (via Solflare/Backpack) supports off-chain message signing, but
  some firmware/app-version combinations reject arbitrary message signing outright — SIWS can
  fail hard. Needs a visible error path with the `signMessage` fallback, not a hang. This is the
  main argument for building the fallback in Phase 0 rather than deferring it.
- **Timing.** Set `expirationTime` on the `signInInput` **short (~5 min)** — it is the auth
  window, not the session lifetime. Session cookie TTL is a separate, longer decision.
- **Superseded calls.** `connect`/`signIn` reject with a `DOMException` named `'AbortError'`
  when a newer call supersedes them (double-click). Swallow those specifically; don't surface
  them as failures.

---

## 5. Package list and footprint

| Package | Version | Unpacked | Justification |
| --- | --- | --- | --- |
| `@solana/kit` | 8.0.0 | 3.8 MB | Official successor to web3.js v1. Modular + `sideEffects:false`; only imported subpaths ship. |
| `@solana/react` | 8.0.0 | 1.6 MB | `ClientProvider`, `useClient`, `useAction`. Peer of the wallet plugin. |
| `@solana/kit-plugin-wallet` | 0.18.0 | 640 KB | Wallet Standard discovery + connect/signIn/signMessage + React hooks. Replaces the entire wallet-adapter tree. |
| `@solana/kit-plugin-rpc` | (with kit 8) | — | RPC transport for the client. |
| `@solana/wallet-standard-util` | 1.1.3 | 69 KB | **Server:** `verifySignIn`, `verifyMessageSignature`. One dep (`@noble/curves`). |
| `@solana/wallet-standard-features` | 1.4.0 | 67 KB | **Server:** `SolanaSignInInput/Output` types. Types only. |
| session layer | — | **0** | `node:crypto` + Next `cookies()` + a Postgres table. Build our own. |
| `jose` *(optional, later)* | 6.2.10 | 259 KB | Zero deps. Only if a stateless token is ever needed. |

**Net dependency footprint goes DOWN vs the wallet-adapter approach**: no
`@solana/wallet-adapter-wallets` bundle, no per-wallet adapters, no `@solana/web3.js` v1
carried alongside kit, no auth vendor SDK.

Server-side auth needs **only ~136 KB across two packages with one crypto dependency**. That is
the whole cost of the identity layer.

---

## 6. Auth flow

1. **Mint the challenge.** Client clicks Connect → `POST /api/auth/nonce`. Server builds a
   `SolanaSignInInput` — `{ domain, statement, nonce: 32 random bytes, issuedAt, expirationTime:
   +5 min, chainId: 'solana:mainnet' }` — and persists it keyed by nonce (Postgres, 5-min TTL,
   `consumed_at NULL`). `domain` comes from an env var, never from a request header.
2. **One wallet prompt.** Client calls `useSignIn(client).dispatch(wallet, input)` → connect +
   SIWS in a single popup → `SolanaSignInOutput`. On rejection (wallet lacks `solana:signIn`),
   fall back to `connect()` + `signMessage()`.
3. **Post it back.** `POST /api/auth/verify` with `{ address, publicKey, signedMessage, signature }`
   (base64).
4. **Verify, then actually check.** Load the stored input by nonce (reject if missing, consumed,
   or expired) → `verifySignIn(storedInput, output)` → **additionally** assert `domain` equals the
   expected host and `now` falls within `[issuedAt, expirationTime]` → mark the nonce consumed.
   Fail closed on any error (CLAUDE.md).
5. **Create the session.** Upsert the wallet row; insert a `sessions` row (SHA-256 of a random
   32-byte id, wallet address, `expires_at`); set the httpOnly/Secure/SameSite=Lax cookie. Emit
   an `auth.session_created` behavioral event carrying the correlation id.
6. **Trust only the cookie.** Every route handler resolves cookie → session (not revoked, not
   expired) → wallet address, and that address is the identity passed to `packages/rules`. A
   client-supplied address is untrusted input, always. Client-side, compare the connected
   account against the session address each render; mismatch → back to step 1.

---

## References

1. https://solana.com/docs/frontend — official "web3.js v1 and wallet-adapter are legacy" statement
2. https://www.npmjs.com/package/@solana/kit-plugin-wallet — plugin + React hooks + `signIn` API (README read in full)
3. https://github.com/phantom/sign-in-with-solana — SIWS spec, fields, `verifySignIn`
4. `@solana/wallet-standard-util@1.1.3` `lib/esm/signIn.js` — source read directly; basis of the §2 gotcha
5. https://forum.solana.com/t/srfc-22-extending-support-for-mobile-wallets-in-the-wallet-adapter/1245 — mobile session-context loss
6. https://www.npmjs.com/package/@solana/react — `ClientProvider` / stable-client-reference requirement
