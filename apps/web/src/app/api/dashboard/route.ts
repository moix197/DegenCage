import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { compareUsd, migrateConstitution, sumRealizedLosses, sumTradeUsd, type AssetTier } from '@degencage/rules';
import { resolveSession } from '@/server/auth/session';
import { CHAIN_HELIUS_RECONCILE_FLAG, LOSS_LIMIT_ENABLED_FLAG } from '@/server/chain/reconcile-wallet';
import { getDb } from '@/server/db/client';
import { constitutions, wallets } from '@/server/db/schema';
import { loadViolationsFeed, type ViolationFeedItem } from '@/server/dashboard/violations-feed';
import { DASHBOARD_DISCIPLINE_VIEW_FLAG, isFeatureEnabled } from '@/server/flags/feature-flags';
import { computeRollingAllowance, loadWindowedTrades } from '@/server/rules/rolling-allowance';
import { captureError } from '@/observability/error-tracking';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Read-only refresh endpoint the dashboard's client-side poller (`dashboard-panel.tsx`)
 * calls on an interval — the server-authoritative recompute behind the "figures visibly
 * move without a manual reload" success criterion. This never triggers reconciliation
 * itself (that stays `POST /api/wallet/reconcile`, run once on page open by
 * `dashboard/page.tsx`, same as the Phase 4–6 status page did): the allowance figures
 * already move on their own as the rolling window slides past aged-out trades, so a poll
 * only has to re-run `computeRollingAllowance`/`loadWindowedTrades` against whatever is
 * already persisted — no new server computation, per this phase's brief.
 */

interface TierAllowanceView {
  tier: AssetTier;
  maxUsd: string;
  totalUsd: string | null;
  withinLimit: boolean;
}

/** Mirrors `dashboard/page.tsx`'s identically-named combinator — see that file's doc comment for why this stays composed here rather than inside `rolling-allowance.ts`. */
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

/** Mirrors `dashboard/page.tsx`'s identically-named combinator. */
async function computeLossAllowance(walletId: string, limit: { maxUsd: string; windowHours: number }): Promise<LossAllowanceView> {
  const windowed = await loadWindowedTrades({ walletId, windowHours: limit.windowHours, asOf: new Date() });
  const totalUsd = sumRealizedLosses(windowed);

  return { maxUsd: limit.maxUsd, totalUsd, withinLimit: compareUsd(totalUsd, limit.maxUsd) <= 0 };
}

async function loadReconciliationState(walletId: string): Promise<string | null> {
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

export async function GET(): Promise<Response> {
  const correlationId = randomUUID();

  const [dashboardEnabled, reconcileEnabled] = await Promise.all([
    isFeatureEnabled(DASHBOARD_DISCIPLINE_VIEW_FLAG),
    isFeatureEnabled(CHAIN_HELIUS_RECONCILE_FLAG),
  ]);

  if (!dashboardEnabled || !reconcileEnabled) {
    return Response.json({ error: 'dashboard_discipline_view_disabled', correlationId }, { status: 503 });
  }

  const session = await resolveSession();

  if (!session) {
    return Response.json({ error: 'unauthenticated', correlationId }, { status: 401 });
  }

  try {
    const reconciliationState = await loadReconciliationState(session.walletId);

    // Same survivorship-bias constraint as the page: a wallet that never finished
    // reconciling must never read as clean.
    if (reconciliationState !== 'current') {
      return Response.json({ error: 'not_reconciled', correlationId }, { status: 409 });
    }

    const lossLimitEnabled = await isFeatureEnabled(LOSS_LIMIT_ENABLED_FLAG);
    const constitutionRow = await getDb().select().from(constitutions).where(eq(constitutions.userId, session.userId)).limit(1);
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
        ? computeRollingAllowance({ walletId: session.walletId, windowHours: dailyNotionalLimit.windowHours, asOf: new Date(), maxUsd: dailyNotionalLimit.maxUsd })
        : null,
      tierLimit ? computeTierAllowance(session.walletId, tierLimit) : null,
      lossLimit && lossLimitEnabled ? computeLossAllowance(session.walletId, lossLimit) : null,
      loadViolationsFeed({ walletId: session.walletId, userId: session.userId }),
    ]);

    const response: DashboardApiResponse = {
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

    return Response.json(response);
  } catch (error) {
    captureError(error, { correlationId, route: 'dashboard.get' });

    // Fail closed: the caller learns the figures are unavailable, never a stale or false "clean" read.
    return Response.json({ error: 'dashboard_unavailable', correlationId }, { status: 503 });
  }
}
