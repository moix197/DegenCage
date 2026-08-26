# `server/auth` — SIWS sign-in and sessions

Proves a caller holds a Solana wallet, and turns that proof into the one answer to
"which wallet is this request for". Nothing here custodies a key or authorizes a
transaction: the sign-in message says so in as many words, and the cookie it produces
authorizes nothing by itself.

The client half lives in `src/client/wallet/` and is documented at the bottom. Decisions
that outlive this module live in `.ai/` — this file is the flow and the invariants.

## The flow

```
browser                         server                              Postgres
   │  POST /api/auth/nonce         │
   │ ─────────────────────────────>│ isFeatureEnabled('auth.wallet_connect')
   │                               │ assertWithinChallengeRateLimit()
   │                               │ insert challenge  ────────────> siws_challenges
   │ <───────────────────────────  │ (then reap expired rows, best effort)
   │   SolanaSignInInput           │
   │                               │
   │  wallet signs (solana:signIn, │
   │  or connect + signMessage)    │
   │                               │
   │  POST /api/auth/verify        │
   │ ─────────────────────────────>│ resolveSession(cookie)  ← the identity we arrived as
   │                               │ ┌─ ONE transaction ─────────────────────────────┐
   │                               │ │ SELECT … FOR UPDATE the challenge by nonce    │
   │                               │ │ checkSignIn()  (pure)                         │
   │                               │ │ supersedePreviousSession()                    │
   │                               │ │ UPDATE … WHERE consumed_at IS NULL            │
   │                               │ │ establishSession()  → users/wallets/sessions  │
   │                               │ └───────────────────────────────────────────────┘
   │ <───────────────────────────  │ Set-Cookie: degencage_session=<opaque id>
   │   { address }                 │
```

`verifySignIn` from `@solana/wallet-standard-util` proves only that the signature is
valid and that the signed text matches the input handed to it. It knows nothing about
*our* challenge. Three checks are therefore ours, made against the stored row and never
against fields echoed back by the caller:

| Check | Failure |
| ----- | ------- |
| the nonce exists and `consumed_at IS NULL` | `unknown_nonce` / `nonce_already_consumed` |
| `now()` is inside `[issuedAt, expirationTime]` (5-minute TTL) | `challenge_expired` |
| the stored `domain` equals `SIWS_DOMAIN` | `domain_mismatch` |

Two more are ours by construction: the address is base58-decoded from the submitted
public key (never read off the caller's claim), and the address named *inside* the signed
message must equal it — `address_mismatch`, which is what a mid-prompt account switch
produces and which would otherwise be indistinguishable from a forgery in the logs.

## Invariants a change must not break

- **The nonce is single-use, enforced twice.** The row is taken with
  `SELECT … FOR UPDATE`, and the consume is `UPDATE … WHERE consumed_at IS NULL` with
  the affected-row count asserted. The lock and the SQL guard are belt and braces on
  purpose; removing either makes two racing requests able to spend one challenge.
- **Supersede, consume, and insert are one transaction.** Split apart, each seam is a
  live hole: a crash between consume and insert burns a nonce and leaves the user
  unauthenticated forever; a revoke that fails after the insert leaves the *old*,
  wrong-identity session alive and cookied while the caller is told sign-in failed.
- **The domain is configuration.** `requiredSignInDomain()` reads `SIWS_DOMAIN` and
  throws when unset. Never derive it from `Host`, `Origin`, or any other header — an
  attacker who can set headers could then bind a signature to any domain they like,
  which defeats binding it at all.
- **`resolveSession()` is the only source of caller identity.** No route may take a
  wallet id or address from a request body. Doing so would make every rule in the product
  opt-out. Both addresses the switch check compares are server-derived: `previous` from
  the cookie, `verifiedAddress` from the signature.
- **Everything fails closed.** No cookie, unknown id, revoked, expired, past the absolute
  ceiling, or a database that will not answer — all resolve to `null`. A flag lookup that
  fails means no challenge is issued. A rate-limit count that fails throws rather than
  issuing anyway. Errors are captured, never swallowed.
- **Rejections are uniformly opaque.** Every refusal answers `401 sign_in_rejected` with
  the same shape. The reason lives in the logs and the event log, where it is useful, not
  in the response, where it is a probing oracle.

## Session model

An opaque 32-byte `base64url` id in an httpOnly cookie; only its SHA-256 hash is stored,
as the `sessions` primary key. Not a JWT — an account switch or a compromised session has
to be killable server-side, now, and a database leak must not hand the reader a working
cookie.

| Property | Value | Why |
| -------- | ----- | --- |
| Cookie | `degencage_session` | `httpOnly`, `secure`, `path=/` |
| `SameSite` | `Lax`, not `Strict` | a link back into the app keeps the user signed in; the cookie authorizes nothing on its own |
| Sliding TTL | 30 days, pushed out on every resolve | `resolveSession(..., { slideExpiry: false })` for a caller that is only identifying a session in order to revoke it |
| Absolute cap | `SESSION_ABSOLUTE_MAX_LIFETIME_MS` — 90 days from `created_at` | a purely sliding session is immortal, which is exactly what a stolen cookie wants; "this wallet is still yours" is renewed by re-proving, not by being used |

The cap is measured from when the signature was verified, so nothing the cookie holder
does afterwards moves it. It is checked in `isSessionUsable()` *independently* of
`expires_at` rather than by clamping the stored value, so a row written before the cap
existed still dies on time; the slide is separately clamped to it, so one late request
cannot extend a session's last hours into another thirty days.

Revocation is by row, idempotent (`WHERE revoked_at IS NULL`), and the reason is narrowed
server-side to `SESSION_REVOCATION_REASONS` — a caller may annotate a revocation it is
entitled to ask for, never invent one into the audit trail.

## Rate limiting and reaping

`POST /api/auth/nonce` is unauthenticated by necessity (a challenge is what a caller needs
*before* it has an identity) and every call writes a row.

- **10 issuances per 5-minute fixed window**, counted in Postgres with a `COUNT(*)` over
  `siws_challenges` — the rows we already write are their own counter. In-process memory
  would be per-instance, and the thing being protected *is* the shared table. No Redis:
  that arrives with the Phase 4 worker.
- **Keyed by `sha256(first forwarded hop)`** — `x-vercel-forwarded-for`, falling back to
  `x-forwarded-for` then `x-real-ip` — truncated, stored in `client_key`. A raw IP is
  personal data with no purpose here; the limit only asks "same caller as a moment ago".
  A request with no forwarded address goes in one shared `unidentified` bucket; a
  per-caller allowance for callers we cannot tell apart would be no limit at all.
  **None of those headers is verified**, so this limit is only as good as the proxy in
  front of the process — a deployment trust assumption, recorded in
  [`.ai/decisions/rate-limit-forwarded-header-trust.md`](../../../../../.ai/decisions/rate-limit-forwarded-header-trust.md).
  Read it before changing where this deploys.
- **Enforced inside `issueSignInChallenge()`, not in the route,** so the check and the
  write it guards cannot drift apart. The route only translates
  `ChallengeRateLimited` into `429` + `Retry-After`.
- **The reaper** deletes challenges that expired more than `CHALLENGE_RETENTION_MS`
  (1 hour) ago, opportunistically on the same write path that creates them — there is no
  worker process until Phase 4. Retention is deliberately longer than the rate-limit
  window, or reaping would quietly refund a caller its allowance. Its predicate is
  `expires_at` alone and never `consumed_at`, which is what makes "cannot break a sign-in
  in flight" a property of the query rather than of timing. Failure is captured, never
  fatal — the challenge is already committed.

## Events

`recordEvent()` in `src/observability/events.ts` is the only write path into `events`, and
`observed_at` is always server-stamped there; a caller-supplied one is dropped and logged.
Pass the open transaction to make the event atomic with the state change it describes.

| Event | Emitted by | Payload |
| ----- | ---------- | ------- |
| `auth.session_created` | `establishSession()` | `walletAddress`, `walletId`, `expiresAt` |
| `auth.session_revoked` | `revokeSessionByIdHash()` | `walletAddress`, `reason` |
| `auth.wallet_account_switched` | `supersedePreviousSession()` when a sign-in proves a different address, **and** `DELETE /api/auth/verify?reason=account_switch` when the client watcher sees it first | previous address (server-derived); the switched-*to* account is deliberately absent — no signature has proved it |
| `auth.sign_in_rejected` | `recordSignInRejection()` | `reason` only — no address, no key, no nonce; `userId` is null, because nothing on that path has proved an identity |

`auth.sign_in_rejected` is written **only** for rejections reached against a challenge we
actually issued (`nonce_already_consumed`, `challenge_expired`, `domain_mismatch`,
`address_mismatch`, `signature_invalid`). Those are bounded by the issuance rate limit.
`malformed_proof` and `unknown_nonce` are free for an anonymous caller to generate, so
they stop at the log — otherwise the audit trail becomes the unbounded table the rate
limit exists to deny. Rate-limit rejections are logged for the same reason and are never
events.

## Kill switch

`auth.wallet_connect` (`WALLET_CONNECT_FLAG`), seeded by `src/server/db/seed.ts`, gates
both the nonce route and the connect panel. Off — or with the flag lookup *itself*
failing — no challenge is issued, so nothing downstream can be verified and no session can
be created, and `/connect` claims no identity at all. Existing sessions are unaffected;
the switch stops new sign-ins, it does not sign anyone out.

## Client half (`src/client/wallet/`)

| File | Owns |
| ---- | ---- |
| `wallet-provider.tsx` | the `@solana/kit` client and the connect panel |
| `use-wallet-session.ts` | the sign-in dispatch and the account-switch effect |
| `session-api.ts` | every `/api/auth/*` call; a response it cannot read as a success is a failure |
| `account-switch.ts` | the pure decision: is the wallet still the session's account, and may we act on the mismatch yet |
| `wallet-account-watch.ts` | three overlapping change channels — the plugin store's fan-out, per-wallet `standard:events`, and a `focus`/`visibilitychange` backstop |

Two client behaviours are load-bearing rather than cosmetic. Wallets without
`solana:signIn` fall back to `connect()` + `signMessage()` over the identical SIWS text,
which the server verifies identically; the account is re-read after the prompt, because a
message naming one account and a signature made by another mixes two identities. And the
proof is verified in the browser before it is posted — the server's uniformly opaque
rejection is correct against a prober but useless to a user whose wallet changed accounts
mid-prompt, and failing locally leaves the challenge unspent for a clean retry.

**Known limitation:** an in-extension account switch is not reliably observed, so session
identity can lag the wallet's active account until the next full page load. Read
[`.ai/decisions/wallet-account-switch-desync.md`](../../../../../.ai/decisions/wallet-account-switch-desync.md)
before relying on `resolveSession()` without a fresh signature.
