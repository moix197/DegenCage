import { getDb } from './client';
import { featureFlags } from './schema';
import { HOME_STATUS_PANEL_FLAG } from '../flags/feature-flags';
import { logger } from '../observability/logger';

/**
 * Idempotent flag seed — `pnpm db:seed` from the repo root.
 *
 * Kill switches ship *with* the feature they guard, so each phase appends its own
 * flags here rather than turning them on by hand in a console.
 */
const SEED_FLAGS: { key: string; enabled: boolean }[] = [
  { key: HOME_STATUS_PANEL_FLAG, enabled: true },
];

async function seedFeatureFlags(): Promise<void> {
  const db = getDb();

  for (const flag of SEED_FLAGS) {
    await db
      .insert(featureFlags)
      .values(flag)
      .onConflictDoUpdate({
        target: featureFlags.key,
        set: { enabled: flag.enabled, updatedAt: new Date() },
      });
  }

  logger.info('feature flags seeded', { seeded: SEED_FLAGS.map((flag) => flag.key) });
}

await seedFeatureFlags();
process.exit(0);
