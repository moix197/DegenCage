# Rate limits that trust forwarded headers, so hosting must set them

**Decision:** `clientKeyForRequest()` (`challenge-rate-limit.ts`) derives its bucket from
the first hop of `TRUSTED_PLATFORM_HEADER` (`x-vercel-forwarded-for`), then
`x-forwarded-for`, then `x-real-ip` — and **verifies none of them**. That is correct only
because DegenCage runs behind a proxy that writes those headers itself. The assumption is a
**deployment constraint**, not a defect in the limiter: the limiter is right given it, and
wrong the moment it stops holding.

**Scope, as of Phase 9: this covers two limiters, not one.** `clientKeyForRequest` was
written for `POST /api/auth/nonce`'s throttle and is now also reused as-is by
`server/admin/login-rate-limit.ts`'s `attemptAdminLogin` (`POST /api/admin/login`) — same
function, same trust boundary, same failure mode if hosting changes. Everything below
about "what breaks if it stops holding" applies to both; the admin login case is the
higher-stakes one (an online-guessing throttle degrading to decorative, not a nonce-issuance
throttle degrading to unlimited free rows).

**Why:** There is nothing else to key on. `POST /api/auth/nonce` is unauthenticated by
necessity — a challenge is what a caller needs *before* it has an identity — so the only
signal available is what the platform in front of us reports. Every such signal is a
header, and a header is only as trustworthy as whoever last wrote it.

On Vercel ([hosting-and-growth-path](hosting-and-growth-path.md)) it holds: Vercel
overwrites `X-Forwarded-For` and does not forward external IPs, *specifically* to prevent
IP spoofing. `x-vercel-forwarded-for` is preferred because Vercel documents that plain XFF
can still be rewritten by a proxy layered on top of Vercel; XFF and `x-real-ip` are the
fallbacks for every other platform.

**What breaks if it stops holding:** `output: 'standalone'`
([architecture.md](../architecture.md)) is the whole off-Vercel story, and a standalone
process reached directly makes all three headers caller-supplied. The limit then degrades
to one bucket per value the caller invents — no limit at all. This is not a loud failure:
it looks exactly like a working rate limit.

**Rejected:**

- **Verify the address against a trusted-proxy allowlist** — the list is itself
  configuration that must track the platform, and on Vercel the platform already
  guarantees the property the list would re-check.
- **Fall back to something unspoofable when the headers look wrong** — nothing about an
  anonymous HTTP request is unspoofable. A user agent or TLS fingerprint is a worse key
  with the same hole plus false collisions.
- **Drop the limit because it is only as good as the platform** — it is defence in depth
  against a loop filling `siws_challenges`, never the thing that makes a sign-in safe.
  Nothing downstream trusts `client_key` for identity ([auth README](../../apps/web/src/server/auth/README.md)).

**Constraints it creates:**

- **Anyone moving DegenCage off Vercel must re-verify this before deploying**: the new
  front door has to set at least one of the three headers and strip the caller's own.
  A container behind nothing satisfies neither half. This now blocks two throttles, not
  one — re-audit `challenge-rate-limit.ts` **and** `server/admin/login-rate-limit.ts`
  together, since a fix to one without the other leaves the shared function's callers
  inconsistently protected.
- Callers with no identifiable header share one `UNIDENTIFIED_CLIENT_KEY` bucket — a
  per-caller allowance for callers we cannot tell apart would be no limit at all. For the
  nonce throttle this is a shared *issuance* budget, low-stakes. **For the admin login
  throttle it is sharper: `ADMIN_LOGIN_RATE_LIMIT_MAX` (5) failed attempts from *any*
  unidentified caller inside the 15-minute window locks out every other unidentified
  caller too — including the legitimate operator, if their own request ever arrives with
  none of the three headers set (e.g. a mis-configured proxy in front of Vercel, or a
  direct connection during an incident).** There is no bypass once that happens short of
  waiting out the window or fixing whatever stripped the header. Accepted as the correct
  trade-off (a shared lockout is stricter than "no limit for callers we can't tell
  apart," per the "why" section above) but worth knowing before it surprises someone
  mid-incident.
- The nonce throttle's count-then-insert TOCTOU is left open on purpose:
  `pg_advisory_xact_lock` on the client key would close it by serializing *all*
  unidentified issuance through one lock, at a cost judged not worth it for a
  low-stakes, generous (10/5min) issuance budget. Reasoning at
  `apps/web/src/server/auth/challenge-rate-limit.ts:120`. **The admin login throttle
  makes the opposite call** — `attemptAdminLogin` (`server/admin/login-rate-limit.ts`)
  *does* wrap its count-check-and-insert in exactly this `pg_advisory_xact_lock`
  pattern, because an online-guessing budget's stated bound has to be real, not just
  usually-true-except-under-a-burst. The two throttles sharing `clientKeyForRequest` but
  differing here is deliberate, not an inconsistency to fix.
- The limit is enforced inside `issueSignInChallenge()`/`attemptAdminLogin()`, so no
  write path can skip it — a second issuance/login path must go through it, not around
  it.
- Counting happens in Postgres because the shared table being protected (`siws_challenges`
  / `admin_login_attempts`) is what matters; an in-process window bounds nothing across
  instances. A Redis-backed limiter arrives with the Phase 4 worker and inherits this same
  header problem.

**Revisit when:**

- Hosting changes, a proxy or CDN is put in front of Vercel, or a worker/API process is
  exposed directly.
- The rate-limit cache moves to Redis in Phase 4 — the key derivation is what carries
  over, and it is the part that trusts the platform.
