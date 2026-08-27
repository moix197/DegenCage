import type { AssetTier, Constitution } from '@degencage/rules';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Scope narrows a flag below "global". Absent/empty `userIds` means the flag's
 * `enabled` value applies to everyone; a non-empty list means it applies only to
 * those users and everyone else is disabled (fail closed).
 */
export interface FeatureFlagScope {
  userIds?: string[];
}

/**
 * Runtime kill switches. Global, per-feature, per-user, and per-integration all
 * live here so a switch can be flipped without a deploy (CLAUDE.md → Safety
 * infrastructure). `enabled` defaults to false: a row that exists but was never
 * turned on is off.
 */
export const featureFlags = pgTable('feature_flags', {
  key: text('key').primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  scope: jsonb('scope').$type<FeatureFlagScope>(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type FeatureFlagRow = typeof featureFlags.$inferSelect;

/**
 * A person. Deliberately empty beyond identity: Phase 0 has no email, no invite, no
 * profile (decision 11 — open connect). One user owns one wallet for now.
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * `embedded` is unused in Phase 0 but exists from day 1 (decision 2): retrofitting a
 * custody distinction after wallets have history is a migration nobody wants.
 */
export const walletCustody = pgEnum('wallet_custody', ['external', 'embedded']);

/**
 * `never` → `in_progress` → `current` | `failed`, driven entirely by `reconcile-wallet.ts`
 * (`apps/web/src/server/chain/reconcile-wallet.ts`). Distinct from "zero trades": a wallet
 * that has never been reconciled must never be read as clean — the survivorship-bias
 * constraint in `.ai/decisions/event-time-vs-observation-time.md`.
 */
export const RECONCILIATION_STATES = ['never', 'in_progress', 'current', 'failed'] as const;
export type ReconciliationState = (typeof RECONCILIATION_STATES)[number];
export const reconciliationState = pgEnum('reconciliation_state', RECONCILIATION_STATES);

export const wallets = pgTable('wallets', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  /** Base58, derived server-side from the signing public key — never taken from a request body. */
  address: text('address').notNull().unique(),
  custody: walletCustody('custody').notNull().default('external'),
  /** Highest finalized slot fully persisted by reconciliation; null until the first run. */
  reconciledThroughSlot: bigint('reconciled_through_slot', { mode: 'number' }),
  reconciliationState: reconciliationState('reconciliation_state').notNull().default('never'),
  /**
   * When the 90-day baseline backfill (decision 9) last finished successfully — set once,
   * never touched again. `reconciliation_state` alone cannot express "backfill finished":
   * a failed first run also leaves it `failed` (or `in_progress`, mid-crash), and deriving
   * "is this the baseline pull" from state or from `reconciled_through_slot` would then
   * treat the retry as a live run, feeding pre-commitment history to `evaluateTrade()`. This
   * column is null until a baseline run completes, so a failed-and-retried first connect is
   * still recognized as baseline.
   */
  baselineCompletedAt: timestamp('baseline_completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Opaque, revocable sessions (decision 15) — not a JWT, so a compromised or switched
 * wallet can be cut off server-side without waiting for a token to expire.
 *
 * Only the SHA-256 hash of the session id is stored: a database leak must not hand the
 * reader a working cookie.
 */
export const sessions = pgTable('sessions', {
  idHash: text('id_hash').primaryKey(),
  walletAddress: text('wallet_address')
    .notNull()
    .references(() => wallets.address),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
});

export type SessionRow = typeof sessions.$inferSelect;

/**
 * One issued `SolanaSignInInput`, keyed by its nonce.
 *
 * `verifySignIn` from `@solana/wallet-standard-util` checks the signature and that the
 * signed text matches the input we hand it — nothing more (decision 16). Replay, expiry
 * and domain binding are ours, and they are enforced against *this stored row*, never
 * against fields echoed back by the client.
 */
export const siwsChallenges = pgTable(
  'siws_challenges',
  {
    nonce: text('nonce').primaryKey(),
    input: jsonb('input').$type<StoredSignInInput>().notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Non-null means this challenge has already bought a session. Single use, forever. */
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    /**
     * Who asked for this challenge, as an opaque hash — never a readable IP. The nonce
     * endpoint is unauthenticated, so there is no user to attribute an issuance to and
     * this is the only thing a rate limit can count. Nullable because rows issued before
     * the limit existed have no key; such a row simply counts towards nobody.
     */
    clientKey: text('client_key'),
    /**
     * When this challenge's one `auth.sign_in_rejected` event was written, if it ever was.
     *
     * `verify` is unauthenticated and unthrottled, so a caller may resubmit one nonce
     * forever; without this column each replay wrote another append-only `events` row.
     * Claiming it is what makes the rejection audit trail one row per challenge issued —
     * and issuance is what the rate limit actually caps.
     */
    rejectionRecordedAt: timestamp('rejection_recorded_at', { withTimezone: true }),
  },
  (table) => [
    // The reaper's predicate.
    index('siws_challenges_expires_at_idx').on(table.expiresAt),
    // The rate limiter's predicate: one client's issuances inside the current window.
    index('siws_challenges_client_key_issued_at_idx').on(table.clientKey, table.issuedAt),
  ],
);

/** The subset of `SolanaSignInInput` we issue, stored verbatim so verification re-reads our copy. */
export interface StoredSignInInput {
  domain: string;
  statement: string;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
}

export type SiwsChallengeRow = typeof siwsChallenges.$inferSelect;

/**
 * The behavioral event log — product data, append-only, in the same Postgres as
 * everything else (`.ai/decisions/observability-stack.md`). No update, no delete: a
 * correction is a new row.
 *
 * `occurred_at` is when the thing happened (chain time, or a server clock for our own
 * actions); `observed_at` is when we wrote it down. Never conflated, never client-supplied
 * (`.ai/decisions/event-time-vs-observation-time.md`).
 */
export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
    eventType: text('event_type').notNull(),
    correlationId: text('correlation_id').notNull(),
    userId: uuid('user_id').references(() => users.id),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => [
    // The per-user, per-event-type rate limiter's predicate
    // (`server/constitution/rate-limit.ts`): how many of this event has this user recorded
    // inside the current window.
    index('events_user_id_event_type_occurred_at_idx').on(table.userId, table.eventType, table.occurredAt),
  ],
);

export type EventRow = typeof events.$inferSelect;

/**
 * `draft` → `committing` → `active`, per `apps/web/src/server/constitution/commitment.ts`.
 * A decrease/increase/removal *after* activation is Phase 8's pending-change row on top of
 * this table, not a new status here (decision 12).
 */
export const CONSTITUTION_STATUSES = ['draft', 'committing', 'active'] as const;
export type ConstitutionStatus = (typeof CONSTITUTION_STATUSES)[number];
export const constitutionStatus = pgEnum('constitution_status', CONSTITUTION_STATUSES);

/**
 * The trading constitution — one row per user in Phase 0 (`constitutions_user_id_idx`
 * enforces it; Phase 8 adds edit history via a pending-change row on top of this table,
 * not a second constitution per user).
 *
 * `document` is the versioned `Constitution` object from `@degencage/rules`; `schema_version`
 * is duplicated as a plain column so a later migration can filter/query by version without
 * unpacking jsonb.
 */
export const constitutions = pgTable(
  'constitutions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => wallets.id),
    status: constitutionStatus('status').notNull().default('draft'),
    document: jsonb('document').$type<Constitution>().notNull(),
    schemaVersion: integer('schema_version').notNull(),
    commitmentStartedAt: timestamp('commitment_started_at', { withTimezone: true }),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('constitutions_user_id_idx').on(table.userId)],
);

export type ConstitutionRow = typeof constitutions.$inferSelect;

/** Whether a classification came from a real Jupiter mcap read or the fail-closed default. */
export type TokenClassificationQuality = 'known' | 'unknown';

/**
 * One derived on-chain swap, from `server/chain/reconcile-wallet.ts`. `signature` is
 * unique so `INSERT ... ON CONFLICT (signature) DO NOTHING` makes re-running reconciliation
 * over an already-swept range a no-op rather than a duplicate row
 * (`.ai/decisions/event-time-vs-observation-time.md`'s "resumable and idempotent").
 *
 * `acquired_tier`/`is_acquisition` are Phase 5's additions: `acquired_tier` is the
 * market-cap tier of `bought_mint` at classification time (`server/chain/classify-token.ts`),
 * stamped once and never recomputed — a tier is a point-in-time judgement, and a token that
 * later moons must not retroactively rewrite a past violation (decision 17, append-only).
 * `is_acquisition` is `true` for every real (non-excluded) trade — a swap always acquires
 * exactly one tier, the bought leg's — and `false`/`null` for an excluded candidate, where
 * classification never runs. Loss columns (`is_round_trip_close`, `realized_loss_usd`) are
 * Phase 6's addition, deliberately not here.
 *
 * `usd_value` is nullable and must never be coerced to `0`: an unpriceable trade is
 * unpriced, not free (CLAUDE.md → fail closed). `is_baseline` marks a trade from the
 * 90-day backfill on first connect (decision 9) — baseline trades are a private behavioral
 * record and are never passed to `evaluateTrade()`.
 *
 * A row is written for *every* candidate `derive-swaps.ts` looks at, not only real trades:
 * an excluded candidate (self-transfer, pure receive/send, SOL↔wSOL wrap, an LST swap) gets
 * `excludedReason` set instead, so the status page can list exclusions with their reason
 * (this phase's success criteria). Not every exclusion reason has an identifiable leg on
 * both sides (a pure receive has no sold leg at all), so `soldMint`/`boughtMint` and their
 * amount columns are nullable — populated whenever `derive-swaps.ts` could identify that
 * side, `null` otherwise. A real (non-excluded) trade always has both.
 *
 * `signature` is unique *per wallet*, not globally: a signature is only actually unique
 * across a whole transaction, and a transaction can reference more than one wallet we track
 * (e.g. two of our users appear in the same swap). A single global unique constraint would
 * let `ON CONFLICT DO NOTHING` silently drop the second wallet's row.
 */
export const trades = pgTable(
  'trades',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => wallets.id),
    signature: text('signature').notNull(),
    slot: bigint('slot', { mode: 'number' }).notNull(),
    transactionIndex: integer('transaction_index').notNull(),
    /** Chain time — when the swap happened, never conflated with `observedAt`. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
    soldMint: text('sold_mint'),
    boughtMint: text('bought_mint'),
    /** Raw base units (pre-decimals), as a decimal-digit string — never a float. */
    soldAmountBaseUnits: text('sold_amount_base_units'),
    boughtAmountBaseUnits: text('bought_amount_base_units'),
    usdValue: numeric('usd_value', { precision: 38, scale: 12 }),
    priceSource: text('price_source'),
    isBaseline: boolean('is_baseline').notNull().default(false),
    excludedReason: text('excluded_reason'),
    /**
     * The market-cap tier `AssetTier` (`@degencage/rules`) of `bought_mint`, at
     * classification time. `null` for an excluded candidate. Plain `text`, not a `pgEnum` —
     * same choice as `excluded_reason` above, which is also a closed TS union stored as text.
     */
    acquiredTier: text('acquired_tier').$type<AssetTier>(),
    /** `true` for every real (non-excluded) trade; `false` for an excluded candidate. */
    isAcquisition: boolean('is_acquisition').notNull().default(false),
    /**
     * Whether `acquired_tier` came from a real Jupiter mcap read (`known`) or the
     * fail-closed default (`unknown` — unlisted mint, missing/null `mcap`, or the
     * `classification.jupiter_mcap` flag off). Without this column a `MICRO_CAP` badge
     * cannot be told apart from a genuine sub-$10M read, which the audit trail (decision 17)
     * and the status page's "counted as micro cap" tag both need to distinguish. `null` for
     * an excluded candidate, same as `acquired_tier`.
     */
    classification: text('classification').$type<TokenClassificationQuality>(),
  },
  (table) => [
    // The rolling-window sum's predicate: one wallet's live trades in a time range.
    index('trades_wallet_id_occurred_at_idx').on(table.walletId, table.occurredAt),
    // `ON CONFLICT (wallet_id, signature) DO NOTHING` — idempotent re-reconciliation, scoped
    // per wallet (see the table comment above).
    uniqueIndex('trades_wallet_id_signature_idx').on(table.walletId, table.signature),
  ],
);

export type TradeRow = typeof trades.$inferSelect;
export type NewTradeRow = typeof trades.$inferInsert;

/**
 * Shared 1-minute USD OHLCV cache for majors (SOL, stablecoins), from
 * `server/pricing/binance-klines.ts`. Keyed by `(mint, minuteBucketUtc)` — one row serves
 * every user's trade priced in that minute, so the cache is populated once regardless of
 * how many wallets reconcile through it.
 */
export const tokenPrices = pgTable(
  'token_prices',
  {
    mint: text('mint').notNull(),
    minuteBucketUtc: timestamp('minute_bucket_utc', { withTimezone: true }).notNull(),
    usdPrice: numeric('usd_price', { precision: 38, scale: 12 }).notNull(),
    source: text('source').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.mint, table.minuteBucketUtc] })],
);

export type TokenPriceRow = typeof tokenPrices.$inferSelect;
