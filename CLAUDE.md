# CLAUDE.md — Project Context for Claude Code

## What we're building

**DegenCage** — a self-imposed trading discipline platform for Solana, built on the Jupiter API.
The user defines a "trading constitution" while calm (per-trade / daily / per-asset limits, loss
limits, cooldowns, time windows). The platform then creates friction when emotional future-them
tries to violate it: blocks trades routed through us, timelocks any *loosening* of the rules
(decrease = immediate, increase = 48h, remove = longer), and detects + reports violations that
happen on other apps ("we saw that" — accountability, not punishment).

**Non-custodial.** We are interface + policy engine + execution. Never private keys, never custody.
The user signs. They can always bypass us by going to Jupiter directly — that is fine and expected.

Roadmap: `roadmap__small.pdf` — Phase 0 (validate commitment mechanism) → 1 (Jupiter terminal) →
2 (rich rules) → 3 (commitment/timelock engine) → 4 (wallet accountability) → 5 (behavioral
dashboard). **Build incrementally**: smallest shippable slice of the current phase, validated,
before touching the next. Product/architecture detail lives in `.ai/`.


## Communication

- When reporting information to me, be extremely concise and sacrifice grammar for sake of concision.

## Tooling

- **Package manager is pnpm.** Always use `pnpm` (not npm or yarn) for installing, running scripts, and managing dependencies.

## Subagents

- **Always delegate subtasks to subagents.** Any subtask — research, codebase exploration, file searches, multi-step investigation, or self-contained implementation work — must run in a subagent (via the Task/Agent tool), not inline in the main context. This keeps the main context clean and focused on coordination and decisions.
- **Main context coordinates, subagents do the legwork.** Reserve the main thread for synthesizing subagent results and making decisions; push the exploratory and verbose work down into subagents.
- **One subagent per discrete subtask.** Scope each subagent narrowly and have it return only the conclusion or artifact needed, not the raw intermediate output.

## Project Knowledge Base
- **The `.ai/` directory is the source of truth for project knowledge. Any new feature, architectural change, pattern, dependency, or important decision must update the relevant `.ai/` documentation before considering the work complete.
- **When working on changes, always consult the knowledge base first and keep it synchronized with the current codebase.

## Coding principles

- **Keep entry points thin.** Business logic lives in dedicated layers (services, helpers, hooks) — not inside routes, page components, or top-level entry points.
- **Reuse before reinvent.** Check existing helpers, utilities, and components before writing new code. Duplicating logic that already exists somewhere in the codebase is always wrong.
- **Inspect a similar existing implementation before introducing a new pattern.** Match what's already there.
- **When unsure, prefer consistency with the existing codebase over introducing new patterns or abstractions.**
- **Small focused functions.** Functions should do one thing. If a function exceeds ~30 lines, it's doing too much — break it into smaller named functions that describe what they do.
- **Separation of concerns.** Don't mix data fetching, transformation, validation, and side effects in the same function. Each step should be independently readable and ideally reusable.
- **Name functions after what they do, not how they do it.** `getActiveUser()`, not `processData()`. If you can't name it clearly, the function is probably doing too much.
- **Generic / reusable components accept callbacks only** — no business logic, no redirects, no DOM manipulation baked in.
- **Prefer minimal changes over large refactors.** Make the smallest change that solves the problem; don't tidy up surrounding code that wasn't part of the task.
- **Preserve existing behavior** unless explicitly asked to change it.

## Architecture

- **Modular by packages.** Organize the codebase as discrete packages, each owning a single, well-defined responsibility. Prefer splitting along clear boundaries (domain, feature, or layer) over a single monolithic tree.
- **Clear package boundaries.** Each package exposes a deliberate public API; keep internals private. Depend on a package's published surface, not its internal files.
- **No circular dependencies between packages.** Dependencies flow in one direction. If two packages need each other, extract the shared piece into its own package.
- **New code belongs in the package that owns its concern.** Place logic where its responsibility lives; create a new package when a responsibility doesn't fit any existing one.

- **Use external libraries where they help.** A mature, well-maintained library is the right call for anything that isn't our differentiator — Solana/wallet SDKs, Jupiter clients, charting, observability, validation, decimal/date math, auth. Don't hand-roll those.
- **Build our own where it *is* the product.** The rule engine, commitment/timelock logic, violation detection, and discipline metrics are the IP. No framework owns those.
- **Still add deliberately.** Before pulling one in: confirm nothing in our own packages already covers it, prefer the smallest well-maintained option, check its footprint and maintenance status, and record the *why* in `.ai/decisions/`.

## Observability (day 1, not a later phase)

- **Every feature ships instrumented.** Structured logs and behavioral events are part of the first version — never a follow-up ticket. Metrics backend and distributed tracing arrive with the second process (the Phase 4 worker); until then a correlation id in structured logs covers it. Stack is settled — see `.ai/decisions/observability-stack.md`.
- **Instrument decisions, not just errors.** Every rule evaluation, block, cooldown trigger, timelock transition, and external-violation detection emits a structured event carrying the inputs that produced it. This audit trail *is* the product (Phase 5's dashboard reads from it).
- **Correlate end to end.** One trade-intent id flows UI → rule engine → Jupiter → chain, and appears on every log line, span, and event for that action.
- **No silent failures.** Swallowed errors and empty catch blocks are bugs. Any path that can degrade must be visible in telemetry.

## Safety infrastructure (built in, not bolted on)

Money moves through this system, so control surfaces are first-class features, shipped *with* the feature they guard:

- **Kill switches at every layer.** Global, per-feature, per-user, and per-integration (Jupiter, RPC, price feeds) — each flippable at runtime without a deploy.
- **Fail closed.** If the rule engine, price source, or wallet state is unavailable or stale, **block the trade**. Never fall through to "allow" on error.
- **Feature flags for anything user-facing.** New surfaces ship dark, then roll out.
- **Timeouts, rate limits, and circuit breakers on every external call.** No unbounded retries against Jupiter or RPC.
- **Idempotency wherever funds or rule state are touched.** A retry must not double-count a trade or double-spend an allowance.
- **Rule state is append-only and auditable.** Limit changes and their timelocks are a history, never an in-place overwrite — otherwise the commitment mechanism can be quietly weakened.
- **Definition of done includes them.** A feature without its kill switch, its flag, and its instrumentation is not done.

## Change strategy

When implementing a feature:

1. **Prefer extending existing patterns over adding custom one-off logic.**
2. **Reuse existing helpers** before creating new ones.
3. **Reuse existing components** before creating new ones.
4. **Follow patterns already used in similar features.**
5. **Make minimal changes** rather than large refactors.
6. **Preserve existing behavior** unless explicitly asked to change it.
7. **Update documentation** alongside code changes — relevant READMEs should reflect new behavior, exported APIs, and notable additions.

## Style

- DRY: don't repeat logic; extract once it's used in more than one place with intent to reuse.
- Modularize as needed — split files and functions when responsibilities are mixing, not preemptively.
- No speculative abstractions — wait for the second or third use case before generalizing.
- No dead code, no commented-out code blocks left "just in case."
- No comments that restate what the code does; only comment the non-obvious _why_.
