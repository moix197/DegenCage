# Feature flags and kill switches

**Decision:** Kill switches live in a `feature_flags` table in the same Postgres, one row
per key (`key`, `enabled`, `scope jsonb`, `updated_at`). Every read goes through one
helper — `isFeatureEnabled(key, ctx?)` in `apps/web/src/server/flags/feature-flags.ts`.
No other module queries the table, and no flag is read from an env var.

Scope shape starts minimal: absent or empty `scope.userIds` means the row's `enabled`
value applies globally; a non-empty list means the flag applies to those users only and
everyone else is off. Per-integration switches (`chain.helius`, `pricing.binance`, …) are
just keys — no extra column.

**Why:** CLAUDE.md mandates switches at every layer, flippable at runtime without a
deploy, and never specified where they live. Env vars fail the "without a deploy" test on
Vercel. A dedicated flag vendor is a second source of truth for state that decides whether
money-adjacent code runs, which is precisely what
[single-source-of-truth-database](single-source-of-truth-database.md) forbids — and a
vendor outage would then decide whether our kill switch is reachable.

`jsonb` for `scope` rather than columns: scoping dimensions will churn as phases add
integrations, and this is the same reasoning that puts the constitution in `jsonb`.

**Rejected:**

- **Env-var flags** — a redeploy to flip a switch is not a kill switch.
- **LaunchDarkly / Statsig / Unleash** — mature and free at this size, but a second store
  and a third-party dependency in the path of "should this run at all."
- **Redis-backed flags** — Redis is cache-only here; losing it must never change
  correctness, and a flag lookup changes correctness.
- **A boolean column per flag** — an `ALTER TABLE` per kill switch, which guarantees
  switches get skipped.

**Constraints it creates:**

- **Fail closed, without exception.** Unknown key, disabled row, out-of-scope user, *or a
  database that will not answer* all resolve to `false`. A lookup that throws is captured
  through `error-tracking.ts` and returns `false` — visible in telemetry, never a silent
  swallow, and never a fall-through to "allow".
- Each flag lookup is a database round trip. Acceptable at Phase 0 volume; a request-scoped
  cache is the first optimisation, and Redis the second — neither may change the
  fail-closed semantics.
- **A feature ships with its flag seeded.** `apps/web/src/server/db/seed.ts` is the list;
  each phase appends its keys there rather than inserting rows by hand.
- Naming is `domain.feature` (`auth.wallet_connect`, `chain.helius`, `pricing.birdeye`) so
  a whole integration can be found by prefix.
- The decision (`resolveFeatureFlag`) is a pure function separate from the query, which is
  what keeps flag tests hermetic.
