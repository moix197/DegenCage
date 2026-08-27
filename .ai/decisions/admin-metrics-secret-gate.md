# Admin metrics: shared-secret header + cookie, 404 not 403 everywhere

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
