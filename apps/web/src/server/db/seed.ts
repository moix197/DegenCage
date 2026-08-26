import { getDb } from './client';
import { featureFlags } from './schema';
import { WALLET_CONNECT_FLAG } from '../auth/solana-siws';
import { CHAIN_HELIUS_FLAG } from '../chain/helius-client';
import { CHAIN_HELIUS_RECONCILE_FLAG } from '../chain/reconcile-wallet';
import { CONSTITUTION_AUTHOR_FLAG } from '../constitution/commitment';
import { HOME_STATUS_PANEL_FLAG } from '../flags/feature-flags';
import { PRICING_BINANCE_FLAG } from '../pricing/binance-klines';
import {
  captureError,
  flushErrorTracking,
  initErrorTracking,
} from '../../observability/error-tracking';
import { logger } from '../../observability/logger';

/**
 * Idempotent flag seed — `pnpm db:seed` from the repo root.
 *
 * Kill switches ship *with* the feature they guard, so each phase appends its own
 * flags here rather than turning them on by hand in a console.
 */
const SEED_FLAGS: { key: string; enabled: boolean }[] = [
  { key: HOME_STATUS_PANEL_FLAG, enabled: true },
  { key: WALLET_CONNECT_FLAG, enabled: true },
  { key: CONSTITUTION_AUTHOR_FLAG, enabled: true },
  { key: CHAIN_HELIUS_FLAG, enabled: true },
  { key: CHAIN_HELIUS_RECONCILE_FLAG, enabled: true },
  { key: PRICING_BINANCE_FLAG, enabled: true },
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

/**
 * The script runs outside Next.js, so it initialises error tracking itself; a failed seed
 * must surface as a reported error and a non-zero exit, never a raw unhandled rejection.
 */
async function main(): Promise<never> {
  initErrorTracking('nodejs');

  try {
    await seedFeatureFlags();
  } catch (error) {
    captureError(error, { script: 'db:seed' });
    // `process.exit` kills the transport mid-flight, so the report has to be drained first.
    await flushErrorTracking();
    process.exit(1);
  }

  process.exit(0);
}

await main();
