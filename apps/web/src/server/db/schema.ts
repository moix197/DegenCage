import type { Constitution } from '@degencage/rules';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
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

export const wallets = pgTable('wallets', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  /** Base58, derived server-side from the signing public key — never taken from a request body. */
  address: text('address').notNull().unique(),
  custody: walletCustody('custody').notNull().default('external'),
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
export const events = pgTable('events', {
  id: uuid('id').primaryKey().defaultRandom(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
  eventType: text('event_type').notNull(),
  correlationId: text('correlation_id').notNull(),
  userId: uuid('user_id').references(() => users.id),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
});

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
