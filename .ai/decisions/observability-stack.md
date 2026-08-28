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
- **Two rule-decision event types, deliberately not merged.** `rule.decision_recorded` is
  reconciliation's *retrospective* verdict on a trade that already happened;
  `rule.pre_trade_decision` is the pre-signature verdict that decided whether a trade happens
  at all. Same engine, opposite standing — one is a report, the other is an enforcement action
  — and the discipline metrics have to distinguish "we saw that afterwards" from "we stopped
  it". Folding them into one type behind a `stage` field would bury that distinction in a
  payload nothing can index on.
- **A rule evaluation emits `rule.pre_trade_decision` even when transaction assembly then
  fails**, with `intentId: null` and `assemblyFailed: true`. No `trade_intents` row is written
  in that case — nothing was assembled, so there is nothing signable to point at — but the
  decision *was* reached, and the audit trail must never lose a decision that was actually
  made. Before this, an `allow` that died in assembly survived only as a Sentry capture.
- **The intent-keyed family is one trade attempt's audit trail**, correlated by the
  trade-intent id: `trade.intent_created`, `rule.pre_trade_decision`, `trade.intent_signed`,
  `trade.intent_submitted`, `trade.intent_confirmed`, `trade.intent_failed`,
  `trade.intent_expired`, plus `trade.intent_poll_resolve_attempted` /
  `trade.intent_poll_resolve_timed_out` from the status-poll route. Unlike the two decision
  types, `trade.intent_failed` genuinely *is* one fact reached from several places
  (submit-time verification, reconciliation, the blockhash-expiry sweep) and carries
  `payload.stage` to separate them.
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
- **The browser SDK loads behind a DSN gate, via a dynamic `import()`.**
  `src/instrumentation-client.ts` reads `NEXT_PUBLIC_SENTRY_DSN` — the browser bundle
  cannot see the server-only `SENTRY_DSN` — and only then `import()`s the wrapper. A
  static import pulls `@sentry/nextjs`'s browser build into first-load JS for every
  visitor: **103 kB → 184 kB (~81 kB)**, paid on Phase 0's single static page even with
  Sentry switched off. The gate keeps the default build at 103 kB and costs nothing when
  the DSN is set. **Consequence:** `NEXT_PUBLIC_*` is inlined at build time, so turning
  browser reporting on or off requires a rebuild, not a restart — unlike `SENTRY_DSN`,
  which the server reads at startup. That asymmetry is the price of the size saving.
- **Short-lived processes must flush before exiting.** `captureError` only queues the
  event; `process.exit` kills the transport mid-flight, so a script's error would never
  reach Sentry. `error-tracking.ts` exports `flushErrorTracking(timeoutMs)` for that, and
  `src/server/db/seed.ts` awaits it in its catch. Long-running servers do not need it.
- A correlation id (the trade-intent id) appears on every log line and event belonging to
  one user action.
- **Redaction names must be credential-shaped on their own.** The logger blanks a fixed
  field-name list at every nesting level, and redaction is silent — so an over-matching
  name deletes audit data invisibly. A bare `token` is excluded on purpose: in a Solana
  app that is an SPL symbol or mint, and the trade events Phase 5 reads are built from it.
