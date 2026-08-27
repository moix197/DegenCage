# The hand-rolled admin gate is provisional and frozen

**Decision:** Phase 9's custom admin authentication stays as-is for now, and is **closed to
further development**. No new features, no hardening passes, no additional endpoints or
surfaces built on it. It is a stopgap that will be **replaced by an established, maintained
auth library** (NextAuth/Auth.js is a candidate, not a choice — the evaluation is open)
before the admin surface grows past the one internal metrics view it exists to protect.

**What exists today** (all of it hand-written, all of it in scope of the freeze):

- `apps/web/src/server/admin/access.ts` — `secretsMatch` (constant-time compare on hashed
  digests), `hasValidAdminSecretHeader`, and the HMAC-SHA256 signed cookie format
  `${expiresAtMs}.${hmacHex}` (`createAdminSessionCookieValue` /
  `verifyAdminSessionCookie`, 12h `ADMIN_SESSION_TTL_MS`).
- `apps/web/src/server/admin/secret-config.ts` — `getConfiguredAdminSecret`,
  `MIN_ADMIN_SECRET_LENGTH` (32), `warnIfAdminSecretMisconfigured`.
- `apps/web/src/server/admin/login-rate-limit.ts` + `login-attempt-reaper.ts` —
  `attemptAdminLogin` (5 failed / 15 min per client key, serialized by
  `pg_advisory_xact_lock`) and its opportunistic 1h reaper.
- `admin_login_attempts` (migration `0015_sad_nightshade.sql`) — the throttle's counting table.
- `POST /api/admin/login`, `POST /api/admin/logout`, the `/admin/login` plain-HTML form page,
  and the cookie check inside `/admin/metrics/page.tsx`.

**Why it was built at all:** none of it was in the Phase 9 plan, which specified only an
`ADMIN_METRICS_SECRET` header check on `GET /api/admin/metrics` and said nothing about gating
the page. A security audit found `/admin/metrics` served real per-user data — `userId`s, live
violations/week, 50 verbatim feedback quotes, and the private 90-day baseline counterfactual
(never meant to be user-facing at all) — to any unauthenticated visitor who typed the URL. The
custom machinery is the *minimum* thing that closed that, built under audit pressure. Full
rationale for each piece: [admin-metrics-secret-gate](admin-metrics-secret-gate.md).

**The tension with CLAUDE.md, stated plainly:** CLAUDE.md → *Architecture* says to use mature
external libraries for anything that isn't our differentiator and names **auth** explicitly in
that list, and to build our own only where it *is* the product (the rule engine,
commitment/timelock logic, violation detection, discipline metrics — admin auth is none of
these). This gate is a **deliberate, temporary exception** to our own stated rule, taken
because the audit needed closing now and because pulling in an auth framework mid-remediation
would have been a larger, less reviewable change than the ~200 lines that fixed the actual
leak. Recording it here so nobody later reads the existing code as precedent for hand-rolling
auth — it is a debt, not a pattern.

**Frozen means frozen.** If a change to the admin surface would require touching
`server/admin/*` for anything beyond a security fix on the existing behavior, that is the
signal to do the library migration instead of extending this. Note this replaces
`admin-metrics-secret-gate.md`'s "extend `access.ts` rather than copying it" constraint as the
*forward* guidance: don't copy it, and don't extend it either — replace it.

**What would trigger the replacement** (any one of these, not all):

- A **second admin user** — the shared secret has no notion of *who* logged in; two holders of
  one value are indistinguishable in the audit trail.
- **Any role distinction** — read-only vs. full, or founder vs. contractor. There is exactly
  one privilege level today and no place to put a second.
- **An admin surface that mutates state** rather than reads it — a shared secret plus a
  `sameSite: 'lax'` cookie is an acceptable gate for a read-only internal dashboard; it is not
  what should stand between anyone and a write path into user rule state.
- **A non-Vercel deploy** — the login throttle keys off an unverified forwarded header, a
  platform trust assumption recorded in
  [rate-limit-forwarded-header-trust](rate-limit-forwarded-header-trust.md).
- **More than the one internal metrics view** living under `/admin`.

**What a replacement must preserve** (these are properties, not implementation details — any
library that can't hold them is the wrong library):

- **404, never 403/401, on `GET /api/admin/metrics`** — and on every non-`GET` method, so
  Next's auto-405 can't fire either. The existence of an internal metrics endpoint is itself
  information. Most auth libraries default to 401/redirect; this route needs an explicit
  opt-out of that default. The page's own `notFound()` behavior is the same property.
- **Fail closed on a missing or too-short secret/credential** — an unset or under-length
  `ADMIN_METRICS_SECRET` locks *everyone* out today, including the operator. Never fail open,
  and never let a misconfiguration downgrade the gate to "unlinked."
- **No user accounts, no roles, no signup** — this is an **operator gate**, not user auth. A
  library brought in here should be configured with a single credentials-style operator
  identity, not a user table. Adding accounts *to satisfy the library* would be the tail
  wagging the dog.
- **Complete separation from the SIWS wallet session.** `resolveSession()` and the
  `degencage_session` cookie answer "which wallet is this request for" for a *user*; they must
  never become an input to "is this an operator." They are different cookies, different
  lifetimes, different trust questions — a replacement must not collapse them, and "has a
  valid wallet session" must never be a proxy for admin access (any activated user satisfies
  it).
- **Startup-visible misconfiguration** without crashing the app — an admin-only gate failing
  closed is not worth taking the product down for (`warnIfAdminSecretMisconfigured` today).
- The **instrumentation**: `admin.login_failed` / `admin.login_rate_limited` events, and a
  throttle on the login path — a public login page advertises its own existence, so whatever
  replaces this must not reopen the unthrottled online-guessing oracle that
  `attemptAdminLogin` closed.

**Not decided here:** which library. NextAuth/Auth.js was named as a candidate ("or better").
The evaluation — footprint, maintenance status, whether it can express a credentials-only
operator gate without dragging in a user/account model, and whether it can be made to answer
404 — belongs in its own decision doc when the trigger fires.
