# Architecture

The high-level shape of the system: package boundaries, how data flows, and the
rules that keep dependencies pointing one direction.

> The pnpm workspace, `apps/web`, and `packages/rules` are **built**. Anything marked
> *later* below is still target shape, not a tree on disk.

## System shape

```
apps/web        Next.js App Router — UI + route handlers (Vercel), output: 'standalone'
  src/app/                   routes and pages — entry points only, no business logic
  src/observability/         logger + captureError — the only pino/Sentry importers;
                             shared by server and browser, so not under src/server/
  src/server/db/             drizzle schema, migrations, seed, the one pooled getDb()
  src/server/flags/          isFeatureEnabled() — fail-closed kill switches
  src/server/auth/           SIWS verification + sessions; resolveSession() is the only
                             source of caller identity
  src/server/constitution/   draft -> commit -> activate lifecycle; the commitment window is
                             measured by Postgres' clock, not this process'
  src/server/chain/          everything that talks to Solana. Helius pull -> swap derivation ->
                             FIFO lot-matching (pure, lot-matching.ts) -> reconcileWallet(),
                             the only writer of `trades`/`position_lots`, triggered in-request
                             on app open; plus the pre-trade RPC (simulate, lookup-table reads)
                             and broadcast-transaction.ts, the one fork between verifying
                             signed bytes and sending them
  src/server/pricing/        a swap's USD value + the shared token_prices minute cache
  src/server/rules/          the I/O half of evaluation: windowed trade queries that feed
                             packages/rules' pure evaluateTrade()
  src/server/swap/           the pre-trade gate: build -> price -> evaluate -> compile the
                             unsigned message the wallet signs, then verify it on the way back.
                             The only module that refuses a trade rather than recording one
  src/client/wallet/         browser-only wallet code — the extension never reaches the
                             server tree, and identity is still rendered from the session
packages/rules  the rule engine: pure, I/O-free, the product IP — and the constitution
                document schema, which is why the shape crosses the boundary but no I/O does

later, only when the need is real:
packages/db     schema + queries — only once a second consumer needs them
apps/worker     a scheduled sweep of every wallet, logged in or not (worker container, not
                a VPS). The indexer itself already exists at src/server/chain — what a
                worker adds is *when* it runs, not what it does
```

`packages/db` was deliberately **not** introduced. `apps/web` is still the only consumer
of the schema and queries, so they live at `apps/web/src/server/db`. The bar for
extracting it is a second real consumer (`apps/worker`), not anticipation of one.

Deliberately not split further up front — see
[decisions/monorepo-package-shape](decisions/monorepo-package-shape.md).

## Dependency direction

`apps/*` → `packages/*`. Packages never import from apps. `packages/rules` sits at the
bottom and imports nothing of ours.

The load-bearing rule: **`packages/rules` does no I/O** — no DB, no `fetch`, no `next/*`.
It is a pure function of (constitution, history, proposed trade) → decision. That single
property is what keeps hosting decisions decoupled from business logic, and what makes
adding a worker process later a non-event.

## Data flow

Two directions, both ending at `packages/rules`. The first is **interception** — built in
Phase 1, and the whole reason `/trade` exists:

```
wallet → /trade → POST /api/swap/quote → src/server/swap
                          │   Jupiter /swap/v2/build (route + raw instructions, one call)
                          │   src/server/pricing  (worst case for the limit being tested)
                          │   src/server/chain    (tier classification, lookup tables, simulate)
                          │   src/server/rules → packages/rules evaluateTrade → Decision
                          ▼
              foldVerdict: allow only if every limit allowed
                  │                                    │
                allow                                block
                  ▼                                    ▼
        compile the v0 message,              nothing compiled,
        hash it → trade_intents            tx_message_hash NULL
                  │                     (the browser holds no signable bytes)
                  ▼
        wallet signs → POST /api/swap/submit
                  │   re-hash the message extracted from the signed bytes,
                  │   re-check the fee payer, re-evaluate against fresh state
                  ▼
        chain/broadcast-transaction.ts → Solana
```

The block is real: a refused trade never produces bytes to sign, so declining is not an
advisory the client can route around. What is **not** proven is the last hop. `chain.broadcast`
is seeded `false` and has never been turned on (Phase 6 is deferred), so that final step
verifies the signed transaction by simulation instead of sending it. Everything up to and
including the user's signature runs for real; nothing has settled on chain through us, and no
part of this path has been exercised against live mainnet execution. The surface also ships
dark — `trade.terminal` and `jupiter.swap_build` are seeded `false` too. Why the server, not
the browser, holds every step of this:
[decisions/trade-intent-server-relay](decisions/trade-intent-server-relay.md); why an
`unevaluable` limit blocks alongside a violated one:
[decisions/pre-trade-fail-closed-folding](decisions/pre-trade-fail-closed-folding.md).

The second direction is **observation** — the roadmap's "we saw that" accountability, and the
only writer of `trades`:

```
Solana → Helius → src/server/chain (derive swap from net balance deltas)
                        │
                        ▼
                  src/server/pricing (price the known leg)
                        │
                        ▼
          src/server/chain/lot-matching.ts (pure FIFO cost-basis, per mint)
                        │
                        ▼
   src/server/rules (windowed history) → packages/rules evaluateTrade → Decision
                        │                                                  │
                        ▼                                                  ▼
    Postgres `trades` / `position_lots`                       rule.decision_recorded
        (idempotent, row-locked, cursor-advanced)              (allows and violations)
```

Both directions end in the same place: `packages/rules` decides, Postgres records, an event
carries the inputs. They meet again afterwards — reconciliation matches a submitted intent's
signature back to the trade it became and resolves the intent's terminal status. Their event
families stay separate on purpose (`rule.pre_trade_decision` vs `rule.decision_recorded`): a
trade we refused and a trade we merely noticed are different facts about the user.

Neither direction has a process of its own. Both run in-request inside the Vercel handler, so
"on app open" is the scheduler — see the `apps/worker` note above for what a second process
would add.

Rules are evaluated server-side with server-authored timestamps, never in the client —
see [decisions/server-side-rule-evaluation](decisions/server-side-rule-evaluation.md).

One Postgres is authoritative for constitutions, rule state, allowances, and trade
history; the web app and any future worker share it — see
[decisions/single-source-of-truth-database](decisions/single-source-of-truth-database.md).
It is reached through exactly one handle (`getDb()`, pooled), managed by Drizzle —
see [decisions/migration-and-test-tooling](decisions/migration-and-test-tooling.md).

Two cross-cutting rules constrain every module above: a feature is gated by
`isFeatureEnabled()` and fails closed
([decisions/feature-flags-and-kill-switches](decisions/feature-flags-and-kill-switches.md)),
and it logs and reports errors through the observability wrappers rather than importing
pino or Sentry directly
([decisions/observability-stack](decisions/observability-stack.md)).

Product context, observability requirements, and safety-infrastructure rules (kill
switches, fail-closed, idempotency) live in **CLAUDE.md** and are not duplicated here.

> Update via the `sync-knowledge` skill when an architectural boundary, package,
> or flow is introduced or changed.
