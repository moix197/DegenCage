import { compareUsd, migrateConstitution, sumRealizedLosses, sumTradeUsd, type AssetTier } from '@degencage/rules';
import { eq } from 'drizzle-orm';

import { getDb } from '../db/client';
import { constitutions, wallets } from '../db/schema';
import { computeRollingAllowance, loadWindowedTrades } from '../rules/rolling-allowance';
import { loadViolationsFeed, type ViolationFeedItem } from './violations-feed';

/**
 * The one place that answers "what does this wallet's dashboard look like right now" —
 * shared by `app/dashboard/page.tsx`'s initial SSR render and `GET /api/dashboard`'s poll
 * response, so the two read paths cannot drift (CLAUDE.md's "reuse before reinvent" /
 * thin-entry-point rule). Both callers hand this the same inputs (`walletId`, `userId`,
 * whether `rules.loss_limit_enabled` is on) and get back the exact same shape.
 */

interface TierAllowanceView {
  tier: AssetTier;
  maxUsd: string;
  totalUsd: string | null;
  withinLimit: boolean;
}

/**
 * Mirrors `computeRollingAllowance` (Phase 4) but scoped to one tier's qualifying
 * acquisitions — `loadWindowedTrades` is reused rather than duplicated; only the
 * tier-filter-then-sum step is new, composed here rather than inside
 * `rolling-allowance.ts` (which stays limit-type-agnostic).
 */
async function computeTierAllowance(walletId: string, limit: { tier: AssetTier; maxUsd: string; windowHours: number }): Promise<TierAllowanceView> {
  const windowed = await loadWindowedTrades({ walletId, windowHours: limit.windowHours, asOf: new Date() });
  const qualifying = windowed.filter((trade) => trade.isAcquisition === true && trade.acquiredTier === limit.tier);
  const totalUsd = sumTradeUsd(qualifying);

  return {
    tier: limit.tier,
    maxUsd: limit.maxUsd,
    totalUsd,
    withinLimit: totalUsd !== null && compareUsd(totalUsd, limit.maxUsd) <= 0,
  };
}

interface LossAllowanceView {
  maxUsd: string;
  totalUsd: string;
  withinLimit: boolean;
}

/** Mirrors `computeTierAllowance` above. */
async function computeLossAllowance(walletId: string, limit: { maxUsd: string; windowHours: number }): Promise<LossAllowanceView> {
  const windowed = await loadWindowedTrades({ walletId, windowHours: limit.windowHours, asOf: new Date() });
  const totalUsd = sumRealizedLosses(windowed);

  return { maxUsd: limit.maxUsd, totalUsd, withinLimit: compareUsd(totalUsd, limit.maxUsd) <= 0 };
}

/**
 * Distinct from "zero trades": a wallet that never finished reconciling must never read as
 * clean (the survivorship-bias constraint in
 * `.ai/decisions/event-time-vs-observation-time.md`). Both callers gate on this before
 * calling `buildDashboardState` below.
 */
export async function loadReconciliationState(walletId: string): Promise<string | null> {
  const rows = await getDb()
    .select({ reconciliationState: wallets.reconciliationState })
    .from(wallets)
    .where(eq(wallets.id, walletId))
    .limit(1);

  return rows[0]?.reconciliationState ?? null;
}

export interface SerializedViolationFeedItem extends Omit<ViolationFeedItem, 'occurredAt'> {
  occurredAt: string;
}

export interface DashboardApiResponse {
  now: string;
  allowance: { totalUsd: string | null; maxUsd: string; withinLimit: boolean } | null;
  tierAllowance: TierAllowanceView | null;
  lossAllowance: (LossAllowanceView & { enabled: true }) | { enabled: false; maxUsd: string } | null;
  violations: SerializedViolationFeedItem[];
  correlationId: string;
}

export interface BuildDashboardStateParams {
  walletId: string;
  userId: string;
  lossLimitEnabled: boolean;
  correlationId: string;
}

/**
 * Assumes the caller has already confirmed `loadReconciliationState(walletId) === 'current'`
 * — this function only reads whatever is already persisted, same "no new server
 * computation" discipline as `rolling-allowance.ts` itself.
 */
export async function buildDashboardState({ walletId, userId, lossLimitEnabled, correlationId }: BuildDashboardStateParams): Promise<DashboardApiResponse> {
  const constitutionRow = await getDb().select().from(constitutions).where(eq(constitutions.userId, userId)).limit(1);
  const constitution = constitutionRow[0] && constitutionRow[0].status === 'active' ? migrateConstitution(constitutionRow[0].document) : null;

  const dailyNotionalLimit = constitution?.limits.find(
    (limit): limit is Extract<typeof limit, { type: 'daily_notional_usd' }> => limit.type === 'daily_notional_usd',
  );
  const tierLimit = constitution?.limits.find(
    (limit): limit is Extract<typeof limit, { type: 'asset_tier_acquisition_usd' }> => limit.type === 'asset_tier_acquisition_usd',
  );
  const lossLimit = constitution?.limits.find(
    (limit): limit is Extract<typeof limit, { type: 'rolling_loss_usd' }> => limit.type === 'rolling_loss_usd',
  );

  const [allowance, tierAllowance, lossAllowance, violations] = await Promise.all([
    dailyNotionalLimit
      ? computeRollingAllowance({ walletId, windowHours: dailyNotionalLimit.windowHours, asOf: new Date(), maxUsd: dailyNotionalLimit.maxUsd })
      : null,
    tierLimit ? computeTierAllowance(walletId, tierLimit) : null,
    lossLimit && lossLimitEnabled ? computeLossAllowance(walletId, lossLimit) : null,
    loadViolationsFeed({ walletId, userId }),
  ]);

  return {
    now: new Date().toISOString(),
    allowance: allowance ? { totalUsd: allowance.totalUsd, maxUsd: allowance.maxUsd, withinLimit: allowance.withinLimit } : null,
    tierAllowance,
    lossAllowance: lossLimit
      ? lossLimitEnabled && lossAllowance
        ? { ...lossAllowance, enabled: true }
        : { enabled: false, maxUsd: lossLimit.maxUsd }
      : null,
    violations: violations.map((violation) => ({ ...violation, occurredAt: violation.occurredAt.toISOString() })),
    correlationId,
  };
}
