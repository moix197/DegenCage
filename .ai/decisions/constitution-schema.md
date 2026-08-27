# The constitution is a versioned jsonb document

**Decision:** `packages/rules/src/constitution.ts` defines the constitution as
`{ schemaVersion, limits: LimitRule[] }`, where `LimitRule` is a discriminated union whose
**all three** members (`daily_notional_usd`, `asset_tier_acquisition_usd`,
`rolling_loss_usd`) exist now, even though only the first is offered by the authoring UI
and only the first is evaluated — `evaluateTrade` returns `unevaluable` (never a silent
allow) for the other two until their phases land. It is stored whole in
`constitutions.document jsonb`,
with `schema_version` mirrored as a relational column. Each `LimitRule` carries a stable
`id`, and `windowHours` is a plain number rather than a `24` literal.

**Why:** The *shape* is cheap to decide once and expensive to change later; the *behaviour*
(evaluator, UI) is delivered one limit type per phase. Splitting them along that line is
the whole point.

Defining the union up front costs three type members today. Deferring it costs a document
migration over rows users have already **committed to** — rewriting the text of someone's
constitution is precisely the thing the commitment mechanism exists to make impossible, so
the migration is not merely inconvenient, it is corrosive to the product.

The same reasoning drives the two field-level choices:

- **`windowHours: number`** — a later 7-day limit is then a different value in an existing
  document, not an `ALTER TABLE` and not a schema-version bump.
- **stable `id`, never array position** — Phase 8's pending-change mechanism must say
  "*this* limit's `maxUsd` is increasing" across an edit that reorders or inserts. With
  positional identity, inserting one limit makes every later limit look changed, and a
  48-hour timelock would fire on limits nobody touched.

Only a breaking **reshape of an existing field** bumps `CONSTITUTION_SCHEMA_VERSION` and
needs a case in `migrateConstitution` (which upgrades a stored document on read). Adding a
limit type never does.

**Rejected:**

- **Relational columns per limit type** — every new type and every new window becomes a
  migration, against a vocabulary the roadmap expects to keep growing.
- **`schemaVersion` only inside the jsonb** — a version you cannot filter or index on
  cannot drive a backfill; hence the duplicated column.
- **Ship only `daily_notional_usd` and add the union later** — the cheapest option, and the
  one that pays for itself in a migration over committed constitutions.

**Constraints it creates:**

- **Two entry points, not interchangeable.** `parseConstitution` validates *untrusted*
  input (the draft/save path) and returns a reason; `migrateConstitution` validates our own
  *stored* row and **throws**, because a failure there means the row is corrupt. Never
  substitute one for the other.
- The server validator accepts any well-formed `LimitRule`, including the two the UI does
  not offer — Phases 5/6 add their UI with no server change.
- `maxUsd` is a decimal **string**, and positivity is proven digit-by-digit, never through
  `parseFloat`: a long enough digit string parses to `Infinity`, which is `> 0`, so a float
  check would pass a value it never actually read. The evaluator keeps that discipline:
  every USD sum and comparison is `BigInt` over decimal strings — see
  [usd-pricing-source](usd-pricing-source.md).
- Limit `id`s must be unique within a document (`duplicate_limit_id`) — Phase 8's identity
  depends on it.
- All of this stays I/O-free, per
  [monorepo-package-shape](monorepo-package-shape.md) and
  [architecture.md](../architecture.md)'s load-bearing rule for `packages/rules`.
