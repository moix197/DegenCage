# Admin metrics: shared-secret header, 404 not 403

**Decision:** `GET /api/admin/metrics` (Phase 9) is gated by a single shared secret,
`ADMIN_METRICS_SECRET`, sent as the `x-admin-metrics-secret` header. A missing header, a
wrong value, or an unset `ADMIN_METRICS_SECRET` all answer **404**, never 403 or 401.
`/admin/metrics` (the page) enforces nothing at all — it calls `buildMetricsSnapshot()`
directly, server-side, with no HTTP hop and therefore no header to check.

**Why not RBAC, or at least a session check:** decision 11 (open connect, no accounts/roles)
means there is no role system in Phase 0 to hang "founder/PM" off of. `resolveSession()`
answers "which wallet is this" for a *user*, not "is this an operator" — reusing it here
would mean either inventing a role column with exactly one legitimate value, or trusting
"has a session" as a proxy for "is internal," which any activated user satisfies. A
dedicated secret is the smallest thing that is actually true: only someone who was handed
the value can call this route.

**Why 404, not 403/401:** a 403 or 401 confirms the route exists and is protected — it
tells an unauthenticated prober "there is something here, guarded." A 404 is
indistinguishable from a path that was never registered at all. This route computes and
returns real user-behavior aggregates (event counts, per-user violation rates); the
question "does an internal metrics endpoint exist" is itself information worth not
leaking for free. Implemented via `timingSafeEqual` over SHA-256 digests of both the
provided and expected secret (`route.ts`'s `secretsMatch`) rather than a direct string
compare, so a wrong-length guess doesn't short-circuit before the constant-time compare
even runs — `timingSafeEqual` throws on mismatched buffer lengths, and hashing first
normalizes both sides to 32 bytes regardless of the secret's actual length.

**Why the page is unguarded:** a browser navigation to `/admin/metrics` cannot attach a
custom header the way a `fetch`/`curl` call to the API route can — there is no mechanism
for a plain page load to prove it holds the secret. The page is therefore *unlinked and
undocumented* rather than gated: reachable only by someone who already knows the URL,
same posture as the metrics data itself pre-RBAC. This is an accepted gap, not an
oversight — re-evaluate before this ships anywhere the URL could leak (a support channel,
a shared bookmark, server logs with the path in them). The moment a real role system
exists, both surfaces should move to it instead of the secret/obscurity split.

**Constraints it creates:**

- `ADMIN_METRICS_SECRET` must be provisioned per environment; forgetting it in prod does
  not break anything user-facing (fail closed = 404 for everyone, including anyone with
  the real secret) but does mean the route silently reports "not found" to a legitimate
  operator too. Check `.env.example`'s comment first if `/api/admin/metrics` 404s
  unexpectedly.
- Never add a body/JSON error shape to the unauthorized branch (`error: 'unauthorized'`,
  a correlation id, etc.) — any structured response distinguishable from a genuine
  Next.js not-found response narrows what "this route might exist" could mean. The
  current implementation returns `new Response(null, { status: 404 })` for exactly this
  reason.
- If a second internal-only route is ever added, extract `secretsMatch`/`isAuthorized`
  rather than copying them — a second copy is how the "hash first, then compare" detail
  gets silently dropped from one of the two.
