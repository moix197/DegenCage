import { getDb } from './client';
import { featureFlags } from './schema';
import { WALLET_CONNECT_FLAG } from '../auth/solana-siws';
import { CHAIN_HELIUS_FLAG } from '../chain/helius-client';
import { CLASSIFICATION_JUPITER_MCAP_FLAG } from '../chain/jupiter-tokens';
import { CHAIN_HELIUS_RECONCILE_FLAG, LOSS_LIMIT_ENABLED_FLAG } from '../chain/reconcile-wallet';
import { CONSTITUTION_AUTHOR_FLAG } from '../constitution/commitment';
import { DASHBOARD_DISCIPLINE_VIEW_FLAG, HOME_STATUS_PANEL_FLAG } from '../flags/feature-flags';
import { PRICING_BINANCE_FLAG } from '../pricing/binance-klines';
import { PRICING_BIRDEYE_FLAG } from '../pricing/birdeye-price';
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
  // Phase 5 shipped these two flags without seeding them (an oversight, not a deliberate
  // "ship dark") — added here alongside Phase 6's own flag below so all three of Phase 4/5/6's
  // pipeline stages default the same way out of the box.
  { key: CLASSIFICATION_JUPITER_MCAP_FLAG, enabled: true },
  { key: PRICING_BIRDEYE_FLAG, enabled: true },
  // Off by default would make Phase 6's own success criteria unreachable out of the box —
  // every trade would carry `realizedLossUsd: null` and `evaluateTrade`'s `rolling_loss_usd`
  // case would (correctly, per the fail-closed fix) report `unevaluable` forever.
  { key: LOSS_LIMIT_ENABLED_FLAG, enabled: true },
  // Phase 7's dashboard is the real replacement for `/constitution-status` — same
  // ship-enabled-by-default posture as the other user-facing pages above.
  { key: DASHBOARD_DISCIPLINE_VIEW_FLAG, enabled: true },
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
