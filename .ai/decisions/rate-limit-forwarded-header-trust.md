# The nonce rate limit trusts forwarded headers, so hosting must set them

**Decision:** `clientKeyForRequest()` derives its bucket from the first hop of
`x-vercel-forwarded-for`, then `x-forwarded-for`, then `x-real-ip` — and **verifies
none of them**. That is correct only because DegenCage runs behind a proxy that writes
those headers itself. The assumption is a **deployment constraint**, not a defect in the
limiter: the limiter is right given it, and wrong the moment it stops holding.

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
  A container behind nothing satisfies neither half.
- Callers with no identifiable header share one `UNIDENTIFIED_CLIENT_KEY` bucket — a
  per-caller allowance for callers we cannot tell apart would be no limit at all. This
  is also why the count-then-insert TOCTOU is left open: `pg_advisory_xact_lock` on the
  client key would close it by serializing *all* unidentified issuance through one lock.
  Reasoning at `apps/web/src/server/auth/challenge-rate-limit.ts:120`.
- The limit is enforced inside `issueSignInChallenge()`, so no write path can skip it —
  a second issuance path must go through it, not around it.
- Counting happens in Postgres because the shared `siws_challenges` table is the thing
  being protected; an in-process window bounds nothing across instances. A Redis-backed
  limiter arrives with the Phase 4 worker and inherits this same header problem.

**Revisit when:**

- Hosting changes, a proxy or CDN is put in front of Vercel, or a worker/API process is
  exposed directly.
- The rate-limit cache moves to Redis in Phase 4 — the key derivation is what carries
  over, and it is the part that trusts the platform.
