# Observability stack

**Decision:**

| Stream | Tool |
| ------ | ---- |
| Behavioral events | append-only table in the same Postgres, `jsonb` payload |
| Errors | Sentry (`@sentry/nextjs`) |
| Structured logs | `pino`, JSON to stdout |
| Log search, metrics backend, distributed tracing | deferred, behind a thin internal wrapper |

**Why:** Two streams get conflated under the word "observability," and they have opposite
requirements. Getting this split right is the actual decision; the vendor names are
secondary.

*Operational telemetry* — errors, latency, uptime — is disposable, sampled, vendor-owned.
Thirty-day retention is fine, and losing it costs a day of blind debugging.

*Behavioral events* — rule evaluated, trade blocked, cooldown fired, timelock started,
external violation detected — are **product data**. Phase 5's dashboard reads them, and
streaks and discipline percentages are computed from them. A free-tier vendor's retention
policy must never be able to change a user's streak. So they live with the source of
truth, in Postgres, under the same rules as everything else there
([single-source-of-truth-database](single-source-of-truth-database.md)).

Logs go to **stdout** deliberately: every host captures stdout, making it the one logging
target with zero lock-in ([hosting-and-growth-path](hosting-and-growth-path.md)). Log
*search* is deferred because at zero users Vercel's own log view is enough; add a drain to
Axiom or Better Stack when there are enough logs to need querying.

Tracing is deferred because one Next.js app talking to one database has no service
boundary to trace across — a correlation id on every log line and event covers it.
Revisit when `apps/worker` lands in Phase 4; that is the first genuinely distributed call
path. CLAUDE.md's Observability section was softened to match, rather than leaving a
standing rule we knowingly violate.

**Rejected:**

- **A vendor-hosted event store at Phase 0** (Axiom, ClickHouse Cloud) — better aggregate
  queries for the dashboard, but splits truth across two stores and free-tier expiry
  silently corrupts streak history. Revisit on volume, not on principle.
- **OpenTelemetry now** — vendor-neutral and honors CLAUDE.md as originally written, but
  real config surface for a single-process app with nothing to correlate across.
- **Datadog or full APM** — cost and complexity far ahead of the need.
- **Self-hosted Grafana / OpenObserve** — contradicts the no-VPS decision.

**Constraints it creates:**

- **`packages/rules` emits nothing.** It is I/O-free, so it returns a decision object
  carrying its own reasoning — which limit applied, amount requested, allowance remaining
  — and the *caller* records the event. This is what lets "instrument decisions, not just
  errors" coexist with a pure engine
  ([monorepo-package-shape](monorepo-package-shape.md)).
- **Every rule decision writes an event, including allows.** A log of only blocks cannot
  compute a rules-followed percentage.
- Events carry both `occurred_at` and `observed_at`
  ([event-time-vs-observation-time](event-time-vs-observation-time.md)).
- **All logging goes through one internal module.** No scattered `console.log`, no vendor
  SDK imported at call sites. That wrapper is what makes adding OTel later a one-file
  change instead of a sweep.
- **Sentry's *initialisation* lives in that same wrapper, not in the Next.js
  instrumentation files.** `apps/web/src/instrumentation.ts` (server, edge) and
  `src/instrumentation-client.ts` (browser) only call
  `error-tracking.ts`'s `initErrorTracking(runtime)`, keeping `@sentry/nextjs` to exactly
  one import site. Without a DSN, Sentry stays uninitialised and the wrapper emits one
  startup warning — a no-op that is visible rather than silent.
- A correlation id (the trade-intent id) appears on every log line and event belonging to
  one user action.
