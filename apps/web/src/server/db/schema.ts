import { boolean, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

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
