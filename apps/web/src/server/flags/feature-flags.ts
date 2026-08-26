import { count, eq } from 'drizzle-orm';

import { getDb } from '../db/client';
import { featureFlags, type FeatureFlagRow } from '../db/schema';
import { captureError } from '../observability/error-tracking';
import { logger } from '../observability/logger';

/**
 * The one kill-switch read path. Every gated feature calls `isFeatureEnabled`;
 * nothing queries `feature_flags` directly.
 *
 * Fail closed, always: an unknown key, a disabled row, an out-of-scope user, or a
 * database that will not answer all resolve to `false`. A flag lookup that errors
 * must never fall through to "allow" (CLAUDE.md → Safety infrastructure).
 */

export interface FeatureFlagContext {
  userId?: string;
}

/** The home page's own kill switch — seeded enabled by `src/server/db/seed.ts`. */
export const HOME_STATUS_PANEL_FLAG = 'web.home_status_panel';

/** Pure decision: given the stored row (or none), is this feature on for this caller? */
export function resolveFeatureFlag(
  row: FeatureFlagRow | undefined,
  context: FeatureFlagContext = {},
): boolean {
  if (!row?.enabled) {
    return false;
  }

  const scopedUserIds = row.scope?.userIds;

  if (!scopedUserIds || scopedUserIds.length === 0) {
    return true;
  }

  return context.userId !== undefined && scopedUserIds.includes(context.userId);
}

export async function isFeatureEnabled(
  key: string,
  context: FeatureFlagContext = {},
): Promise<boolean> {
  try {
    const rows = await getDb()
      .select()
      .from(featureFlags)
      .where(eq(featureFlags.key, key))
      .limit(1);

    const enabled = resolveFeatureFlag(rows[0], context);
    logger.debug('feature flag resolved', { flagKey: key, enabled, known: rows.length > 0 });

    return enabled;
  } catch (error) {
    captureError(error, { flagKey: key, failedClosed: true });

    return false;
  }
}

export interface FeatureFlagStatus {
  /** False means the pooled Postgres round trip did not complete — not "no flags". */
  connected: boolean;
  flagCount: number;
}

/** Live pooled-Postgres round trip backing the home page's connection status. */
export async function loadFeatureFlagStatus(): Promise<FeatureFlagStatus> {
  try {
    const rows = await getDb().select({ total: count() }).from(featureFlags);

    return { connected: true, flagCount: rows[0]?.total ?? 0 };
  } catch (error) {
    captureError(error, { failedClosed: true });

    return { connected: false, flagCount: 0 };
  }
}
