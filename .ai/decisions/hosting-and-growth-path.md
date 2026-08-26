# Hosting and growth path

**Decision:** Ship on Vercel + hosted Postgres (Neon or Supabase) and nothing else.
Grow **additively** with managed services only when a real need appears: Upstash Redis
for shared cooldown timers / rate limits / kill-switch cache, a worker container
(Railway, Render, or Fly) for the Phase 4 wallet indexer, Inngest or Trigger.dev for
scheduled or retryable jobs. Do not stand up a VPS or write a Dockerfile now.

**Why:** The pieces commonly assumed to be "impossible on Vercel" all have managed
equivalents that need zero ops work. A VPS buys ssh, nginx, certs, patching, and
backups in order to save roughly $10/month — an ops job priced against no current
need. Each step of the growth path is independent: adding one never invalidates what
already works.

Phase 0 also avoids background infrastructure entirely by design. The roadmap surfaces
external violations *"next time they open the app"*, so wallet history is reconciled on
app open rather than on a schedule. No cron, no worker, until Phase 4.

**Rejected:**

- **VPS + Docker now** — real ops burden, no current problem it solves.
- **Splitting a separate API service off Vercel** — buys CORS, auth-token plumbing, and
  two deploys for nothing. What Phase 4 actually needs is a *worker* alongside the app,
  not an API split. Route handlers stay on Vercel.
- **Self-hosting Postgres on the app box** — forces public exposure so Vercel can reach
  it. See [single-source-of-truth-database](single-source-of-truth-database.md).

**Constraints it creates:**

- `output: 'standalone'` in `next.config` from day 1 — this is the entire future Docker
  story, and it costs one line now.
- Route handlers run on the **Node runtime**, not edge.
- No `@vercel/kv`, `@vercel/blob`, or `@vercel/postgres`. Use each vendor's own client;
  those wrappers are the lock-in.
- All configuration through plain env vars — never Vercel-specific config reads.
- Watch ISR and image optimization if leaned on; both degrade to needing our own cache
  and `sharp` setup off-platform.
- `packages/rules` stays I/O-free, which is what makes adding a worker later a non-event.
  See [monorepo-package-shape](monorepo-package-shape.md).
- **Vercel Hobby forbids commercial use.** Fine while validating; Pro (~$20/mo) the
  moment this is a product.
