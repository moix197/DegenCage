# Admin metrics: shared-secret header + cookie, 404 not 403 everywhere

> **This whole mechanism is provisional and frozen.** Everything below describes what exists
> and why, and it is all still true — but it is closed to further development and will be
> replaced by a maintained auth library. Read
> [admin-auth-is-provisional](admin-auth-is-provisional.md) before extending anything here;
> in particular it supersedes the "extend `server/admin/access.ts` rather than copying it"
> constraint at the bottom of this doc as the forward guidance.

**Decision:** Every surface under `/admin` and `/api/admin/metrics` is gated by
`ADMIN_METRICS_SECRET`, in two forms sharing one comparison primitive
(`server/admin/access.ts`'s `secretsMatch`, `createAdminSessionCookieValue`,
`verifyAdminSessionCookie`):

- **`GET /api/admin/metrics`** — programmatic/curl callers send the secret directly as the
  `x-admin-metrics-secret` header, checked by `hasValidAdminSecretHeader`.
- **`/admin/metrics`, the page** — a browser navigation cannot attach a custom header, so
  `POST /api/admin/login` exchanges the secret (posted from `/admin/login`'s plain HTML form)
  for a signed, httpOnly, `/admin`-scoped cookie; the page verifies that cookie itself,
  server-side, before running any query, and calls `notFound()` if it's missing, expired, or
  tampered with.

Both a missing/wrong secret on the API route, and every non-`GET` method on it, answer an
identical **404** — never 403/401, and never an auto-405. The page answers Next's real 404
(via `notFound()`) on a missing/invalid session.

**This revises the phase's original version of this doc**, which described the page as
relying only on being "unlinked" — no cookie, no gate, `buildMetricsSnapshot()` called
directly from an unauthenticated Server Component. A code review and a security audit both
flagged this as the actual vulnerability: the page rendered real per-user data —
`userId`s, live violations/week per user, the private 90-day baseline counterfactual
(decision 9 — never meant to be user-facing at all), and 50 verbatim feedback quotes — to
anyone who typed the URL. "Unlinked" is not a control; the secret header only ever protected
the API route, which was never the page's own gate. That framing was wrong and is not
carried forward.

**Why not RBAC, or at least a session check:** decision 11 (open connect, no accounts/roles)
means there is no role system in Phase 0 to hang "founder/PM" off of. `resolveSession()`
answers "which wallet is this" for a *user*, not "is this an operator" — reusing it here
would mean either inventing a role column with exactly one legitimate value, or trusting
"has a session" as a proxy for "is internal," which any activated user satisfies. A
dedicated secret is the smallest thing that is actually true: only someone who was handed
the value can ever get in, on either surface.

**Why a signed cookie, not a server-side session table:** nothing else in Phase 0 needs a
generic session store, and standing one up for exactly one internal login would be new
infrastructure for a single caller. `createAdminSessionCookieValue` is
`${expiresAtMs}.${hmacHex}` — stateless: the cookie's own HMAC (keyed by the current
`ADMIN_METRICS_SECRET`, via `node:crypto`'s `createHmac`) is the only thing that has to
verify, alongside its own embedded expiry (12h, `ADMIN_SESSION_TTL_MS`). Rotating the secret
invalidates every outstanding cookie at once, with nothing to clear.

**Why 404, not 403/401, on the API route:** a 403 or 401 confirms the route exists and is
protected — it tells an unauthenticated prober "there is something here, guarded." A 404 is
indistinguishable from a path that was never registered. This route computes and returns
real user-behavior aggregates; the question "does an internal metrics endpoint exist" is
itself information worth not leaking for free.

**Two things a code review found still leaking existence, now fixed:**

- **The original 404 response had no `Content-Type` and an empty body** — a shape distinct
  from every other response this app ever sends, itself a fingerprint independent of status
  code. `notFoundResponse()` now sets `content-type: text/html; charset=utf-8` and a short
  generic body. This is *not* a byte-for-byte copy of Next's own themed not-found page (that
  would be brittle across Next versions and isn't the property that matters) — the property
  that matters is "no header shape or status code reveals whether this path is real," which
  a generic, consistent 404 shape satisfies without chasing Next's exact HTML.
- **Only `GET` was exported, so `POST`/`PUT`/etc. auto-405'd with an `Allow: GET` header** —
  itself proof the route exists, regardless of the secret. `route.ts` now exports every
  method (`GET`/`POST`/`PUT`/`PATCH`/`DELETE`/`HEAD`/`OPTIONS`) through one shared handler
  that 404s any method other than `GET`, even with a correct secret, so Next's auto-405
  fallback can never fire for this route at all.

**Login route/secret handling:** `POST /api/admin/login` accepts either
`application/x-www-form-urlencoded` (the plain-HTML-form path, zero client JS) or JSON. A
wrong or missing secret, or an unset `ADMIN_METRICS_SECRET`, all redirect (303) back to
`/admin/login?error=1` and set no cookie — a 401-ish outcome here doesn't leak metrics data
(only that a login attempt failed), so this endpoint doesn't need the API route's
404-not-403 treatment; it's a login form, not silently-exists-or-not internal data.

**HIGH — the login route was itself an unthrottled online-guessing oracle, closed by
`server/admin/login-rate-limit.ts`.** The first version of this doc treated the login
route's "wrong-secret redirect leaks nothing" reasoning as the whole story, but missed the
consequence of `/admin/login` being a public 200 page: unlike `GET /api/admin/metrics`
(obscured by the 404-not-403 gate above), the login page necessarily *advertises* that this
endpoint exists — the only thing standing between a prober and the secret was the secret's
own entropy, guessed at whatever rate the caller could send `POST` requests. `attemptAdmin
Login` (5 failed attempts / 15 minutes, per client key) closes that: past the limit, every
subsequent call redirects to `/admin/login?error=rate_limited` *before the secret is ever
compared* — `verifySecret()` runs inside the same transaction as the throttle check (see
the atomicity fix below), so a locked-out caller cannot distinguish "still guessing wrong"
from "now throttled" by response shape or timing beyond the fixed rejection itself.

This is a **sibling to `server/auth/challenge-rate-limit.ts`, not an extension of
`server/constitution/rate-limit.ts`.** The constitution limiter is keyed by `(userId,
eventType)` against `events.user_id`, a real FK to `users` — login is unauthenticated (no
user yet to key on), and bending that column to accept an arbitrary hashed client key would
change what it means for `commitment.ts`/`pending-changes.ts`'s existing callers too, which
was an explicit non-goal. Instead: `clientKeyForRequest` (`challenge-rate-limit.ts`) is
reused as-is (already generic — hashes a forwarded client address, nothing SIWS-specific in
its logic; its trust boundary — see `.ai/decisions/rate-limit-forwarded-header-trust.md`,
now updated to cover this throttle too — applies here unchanged), and a small dedicated
table, `admin_login_attempts` (migration `0015`), is the counting source — same shape as
`siws_challenges`' own rate-limit use, for the same reason: an unauthenticated endpoint's
throttle needs a key that isn't a user id.

**MEDIUM, found in the follow-up audit — the check-then-insert was itself TOCTOU, not
atomic.** The first version of this fix had a real race: `assertWithinAdminLoginRateLimit`
ran a `SELECT count(...)`, and the `INSERT` recording the attempt happened later in the
route, after the secret was compared — no transaction spanned the two. A burst of N
concurrent `POST`s could all read `failed < 5` before any of their inserts committed, so the
*effective* budget under a burst was N, not 5 — not a break (the 32-char entropy floor
below is what actually makes guessing infeasible), but a stated bound that isn't real is
worse than none, since anyone reading "5/15min" would trust a number that doesn't hold.
Fixed by collapsing the whole decision into one function, `attemptAdminLogin`: the count
check, the `verifySecret()` call, and the `INSERT` all run inside one Postgres transaction,
serialized per client key via `pg_advisory_xact_lock(hashtext(clientKey))` — the exact
technique `challenge-rate-limit.ts`'s own doc comment already names as the fix for this
class of race (that file leaves its own equivalent race open deliberately, for a
lower-stakes resource; see the forwarded-header-trust doc's now-expanded "why the two
throttles differ here" section). `hashtext` is a built-in Postgres function; no extension
required. A concurrency test in `login-rate-limit.test.ts` fires many simultaneous
`attemptAdminLogin` calls against a serializing fake transaction and asserts exactly
`ADMIN_LOGIN_RATE_LIMIT_MAX` succeed — this proves the application logic holds the budget
*given* a serializing transaction primitive (which `pg_advisory_xact_lock` provides in real
Postgres); it is not a live-DB integration test, consistent with this codebase's hermetic-
test rule (`.ai/decisions/migration-and-test-tooling.md`).

**A throttled call writes no new `admin_login_attempts` row** (the transaction returns
`'rate_limited'` before the `INSERT` runs), which bounds that table's growth to
`ADMIN_LOGIN_RATE_LIMIT_MAX` failed rows per client key per window. **This alone does not
bound the table's *total* growth**, though — a distributed attacker with many distinct
client keys (trivial over IPv6) opens a fresh small budget per key. `login-attempt-
reaper.ts` (mirroring `challenge-reaper.ts`'s pattern exactly — opportunistic deletion on
the write path, no scheduled job) deletes rows older than `ADMIN_LOGIN_ATTEMPT_RETENTION_MS`
(1h, run from inside `attemptAdminLogin` after the transaction). This bounds *storage
duration*, not the number of distinct keys an attacker can open within that hour — deferred
as an accepted, documented cost (see "Constraints it creates" below), the same posture
`siws_challenges` already has for the unauthenticated nonce endpoint.

The `admin.login_rate_limited` **event** is self-throttled separately
(`recordRateLimitedLoginEventOnce`): without it, every millisecond-spaced request from an
already-locked-out caller would each write a new `events` row for the rest of the window,
since the underlying attempt-count staying flat means nothing else bounds it. Its existence
check is now filtered by `clientKey` **in the query itself**
(`payload->>'clientKey' = ...`), not fetched broadly and filtered in JS across every client
key — the first version's JS-side filter made its own "bounded set" claim true *per key*
but false *across keys*, so a distributed attacker made every throttled request scan an
ever-growing cross-key result set; a code review caught this. `admin.login_failed` needs no
such guard — it can only be written after a call has already passed the throttle, so it's
naturally capped at `ADMIN_LOGIN_RATE_LIMIT_MAX` per client key per window by the same
mechanism that governs the throttle itself.

**Secret entropy is enforced, not just documented — but only a length floor, not a real
entropy check.** `MIN_ADMIN_SECRET_LENGTH` (32 chars, `server/admin/access.ts`) makes a
too-short `ADMIN_METRICS_SECRET` behave identically to an unset one everywhere —
`getConfiguredAdminSecret()` is the one place that reads the env var, so this can't be
checked in one gate and forgotten in another. `instrumentation.ts` also logs a startup
warning (`warnIfAdminSecretMisconfigured`) if the secret is missing or weak — visible
immediately, without crashing the app over a misconfigured admin-only surface (an admin
gate failing closed is not worth taking the whole product down for). **Do not read this as
a strength guarantee: `"a".repeat(32)` passes the check and is still trivially guessable.**
`MIN_ADMIN_SECRET_LENGTH` counts characters, not randomness — it catches "someone typed a
short word" and nothing more; `.env.example`'s comment says so explicitly, telling the
operator to use a real generator (`openssl rand -base64 32`), not just "32+ characters of
anything." The throttle above and this length floor are complementary, not substitutes: a
genuinely random secret makes online guessing infeasible in the time the throttle allows;
the throttle bounds the *rate* even if the secret turns out weaker than the length check
alone can catch.

**LOW fixes from the same audit round:**

- **The session cookie's `Secure` attribute was conditional on `NODE_ENV === 'production'`**,
  which meant any staging/preview deploy (not `NODE_ENV=production` by default) sent the 12h
  admin bearer token over plain HTTP. `isPlainHttpLocalhost(request)` in both
  `api/admin/login/route.ts` and `api/admin/logout/route.ts` now keys the flag off the
  request's actual hostname instead — `Secure` is unconditional everywhere except a bare
  `localhost`/`127.0.0.1` dev server, which cannot read back a `Secure` cookie it set for
  itself over plain HTTP at all.
- **No logout existed** — rotating `ADMIN_METRICS_SECRET` (invalidating every cookie at
  once, per the stateless design above) was the only way to end a session early. `POST
  /api/admin/logout` now overwrites the cookie with `maxAge: 0`, matching every scoping
  attribute (`path: '/admin'`, etc.) the original `set` used — a mismatched attribute would
  make the browser treat it as a different cookie and leave the real one live.
- **`new URL('/admin/metrics', request.url)` was a host-header open redirect** — Next.js
  does not verify `request.url`'s host against a trusted proxy list here, so a forged `Host`
  header could redirect a successful login to an attacker-controlled origin. Every redirect
  in `api/admin/login/route.ts` and `api/admin/logout/route.ts` now uses a bare relative
  `Location` header (`relativeRedirect`) instead — a relative `Location` is resolved by the
  browser against the origin it actually connected to, which a spoofed `Host` cannot change.
- **Logout had no CSRF protection** — a cross-site auto-submitting form pointed at
  `/api/admin/logout` could force a re-login (impact only: it can't touch
  `degencage_session`, the unrelated user-facing cookie). `POST /api/admin/logout` now only
  issues a `Set-Cookie` when the *incoming* request already carries a currently-valid admin
  session — which a cross-site `POST` can't: the cookie is `sameSite: 'lax'`, and Lax
  cookies aren't attached to a cross-site `POST` at all, so a forged form's request arrives
  with no cookie for the route to read, and `hasValidSession` is false before anything is
  cleared. A same-origin check (`Origin` header, when present) sits on top as defense in
  depth for the case `SameSite` handling is ever weakened, not as the primary gate.

**Accepted, documented gap — timing:** the unauthorized path (an immediate `secretsMatch`
compare) and the authorized path (`buildMetricsSnapshot`'s ~9 parallel queries) have a real,
measurable timing delta. Closing it (e.g. a constant-time floor on every response) was
explicitly weighed and rejected as over-engineering for an internal route behind a shared
secret: the timing side-channel only tells a caller "the secret was wrong," which they
already know from the identical 404 — it does not narrow the secret's own search space the
way a per-character timing leak inside `secretsMatch` itself would (which is what
`timingSafeEqual` on hashed digests actually defends against, and does).

**Constraints it creates:**

- `ADMIN_METRICS_SECRET` must be provisioned per environment; forgetting it in prod means
  *nobody* gets in — the API route 404s and the login route always redirects to the error
  page, both fail closed rather than fail open.
- Never add a body/JSON error shape to the API route's unauthorized branch (`error:
  'unauthorized'`, a correlation id, etc.) — any structured response distinguishable from a
  generic 404 narrows what "this route might exist" could mean.
- If a second internal-only route or page is ever added, extend `server/admin/access.ts`
  rather than copying its functions — a second copy is how the "hash first, then compare"
  and "HMAC-sign the expiry" details get silently dropped from one of the two.
- The moment a real role system exists, both surfaces should move to it instead of the
  secret/cookie split described here.
- `admin_login_attempts` (migration `0015_sad_nightshade.sql`) is reaped by
  `login-attempt-reaper.ts` (1h retention, opportunistic on the write path — mirrors
  `challenge-reaper.ts` exactly). That bounds *storage duration*, not the *number of
  distinct client keys* an attacker can each open their own small budget under within that
  hour — trivial to multiply over IPv6, where one actor controls a huge address block. This
  is an accepted, unauthenticated-traffic cost the underlying header-trust boundary already
  carries (`.ai/decisions/rate-limit-forwarded-header-trust.md`), not something the reaper
  is meant to solve; revisit if this table's growth ever actually becomes operationally
  relevant.
- `ADMIN_METRICS_SECRET` must additionally be at least `MIN_ADMIN_SECRET_LENGTH` (32) characters — see `.env.example`'s comment and `server/admin/access.ts`. A secret shorter than that is treated as unset everywhere, including by whoever holds it.
