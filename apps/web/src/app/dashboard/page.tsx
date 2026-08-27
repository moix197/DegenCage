import { desc, eq } from 'drizzle-orm';

import { compareUsd, migrateConstitution, sumRealizedLosses, sumTradeUsd, type AssetTier } from '@degencage/rules';
import { resolveSession } from '@/server/auth/session';
import { CHAIN_HELIUS_RECONCILE_FLAG, LOSS_LIMIT_ENABLED_FLAG, ReconcileRejected, reconcileWallet } from '@/server/chain/reconcile-wallet';
import { getDb } from '@/server/db/client';
import { constitutions, trades, wallets, type TokenClassificationQuality } from '@/server/db/schema';
import { loadViolationsFeed } from '@/server/dashboard/violations-feed';
import { DASHBOARD_DISCIPLINE_VIEW_FLAG, isFeatureEnabled } from '@/server/flags/feature-flags';
import { computeRollingAllowance, loadWindowedTrades } from '@/server/rules/rolling-allowance';
import { captureError } from '@/observability/error-tracking';
import { recordEvent } from '@/observability/events';
import type { DashboardApiResponse } from '@/app/api/dashboard/route';
import { DashboardPanel } from './dashboard-panel';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The Phase 4–6 status page (`constitution-status/page.tsx`), promoted into the real
 * dashboard (Phase 7): same server-side reconciliation-on-open and allowance computation,
 * plus the live-polling `DashboardPanel` and the violations feed. This component only
 * builds the *initial* server-rendered snapshot — `GET /api/dashboard`
 * (`app/api/dashboard/route.ts`) is the sole place that recomputes it afterwards, so the two
 * intentionally mirror each other's combinators rather than sharing one.
 */

const TRADE_LIST_LIMIT = 50;

interface TradeRowView {
  signature: string;
  occurredAt: Date;
  soldMint: string | null;
  boughtMint: string | null;
  usdValue: string | null;
  isBaseline: boolean;
  excludedReason: string | null;
  acquiredTier: AssetTier | null;
  classification: TokenClassificationQuality | null;
  isRoundTripClose: boolean;
  realizedLossUsd: string | null;
}

async function loadRecentTrades(walletId: string): Promise<TradeRowView[]> {
  return getDb()
    .select({
      signature: trades.signature,
      occurredAt: trades.occurredAt,
      soldMint: trades.soldMint,
      boughtMint: trades.boughtMint,
      usdValue: trades.usdValue,
      isBaseline: trades.isBaseline,
      excludedReason: trades.excludedReason,
      acquiredTier: trades.acquiredTier,
      classification: trades.classification,
      isRoundTripClose: trades.isRoundTripClose,
      realizedLossUsd: trades.realizedLossUsd,
    })
    .from(trades)
    .where(eq(trades.walletId, walletId))
    .orderBy(desc(trades.occurredAt))
    .limit(TRADE_LIST_LIMIT);
}

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
 * `rolling-allowance.ts` (which stays limit-type-agnostic). `app/api/dashboard/route.ts`
 * has its own identically-named combinator for the same reason.
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

/**
 * `[MICRO_CAP]`, except the fail-closed default is called out by name — success criteria
 * requires an unlisted/unpriceable token to be "visibly tagged". Gated on `classification`,
 * not on `tier === 'MICRO_CAP'` alone: a genuine sub-$10M mcap read is also `MICRO_CAP`, and
 * tagging it "counted as micro cap" would misrepresent a real reading as the fallback.
 */
function formatTierBadge(tier: AssetTier | null, classification: TokenClassificationQuality | null): string | null {
  if (tier === null) return null;
  return classification === 'unknown' ? `${tier} — counted as micro cap` : tier;
}

interface LossAllowanceView {
  maxUsd: string;
  totalUsd: string;
  withinLimit: boolean;
}

/** Mirrors `computeTierAllowance` above; `app/api/dashboard/route.ts` has the same combinator for the poll path. */
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

function formatMint(mint: string | null): string {
  if (!mint) return '—';
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

function formatUsd(usdValue: string | null): string {
  return usdValue === null ? 'unvalued' : `$${usdValue}`;
}

/**
 * Builds the same shape `GET /api/dashboard` returns, so `DashboardPanel` can treat its
 * `initial` prop and every subsequent poll response identically.
 */
async function buildInitialDashboardState(
  walletId: string,
  userId: string,
  lossLimitEnabled: boolean,
): Promise<DashboardApiResponse> {
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
    correlationId: crypto.randomUUID(),
  };
}

/**
 * Reconciliation runs synchronously on every page load — "triggered on app open", not on a
 * schedule. Fails closed throughout: a reconciliation error, a disabled flag, or no active
 * `daily_notional_usd` limit all render an explicit state — never a false "$0 spent today".
 */
export default async function DashboardPage() {
  const [session, dashboardEnabled, reconcileEnabled, lossLimitEnabled] = await Promise.all([
    resolveSession(),
    isFeatureEnabled(DASHBOARD_DISCIPLINE_VIEW_FLAG),
    isFeatureEnabled(CHAIN_HELIUS_RECONCILE_FLAG),
    isFeatureEnabled(LOSS_LIMIT_ENABLED_FLAG),
  ]);

  if (!dashboardEnabled || !reconcileEnabled) {
    return (
      <main>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Dashboard</h1>
        <p>The dashboard is switched off right now. Nothing is wrong with your wallet.</p>
      </main>
    );
  }

  if (!session) {
    return (
      <main>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Dashboard</h1>
        <p>
          Connect your wallet on <a href="/connect">/connect</a> first.
        </p>
      </main>
    );
  }

  const correlationId = crypto.randomUUID();

  // Serves Phase 9's return-visit metric — fired for every authenticated view, independent
  // of whether reconciliation below succeeds.
  await recordEvent({ eventType: 'dashboard.viewed', occurredAt: new Date(), correlationId, userId: session.userId });

  let reconcileFailed = false;

  try {
    await reconcileWallet(correlationId);
  } catch (error) {
    if (!(error instanceof ReconcileRejected)) {
      captureError(error, { correlationId, page: 'dashboard' });
    }
    reconcileFailed = true;
  }

  const reconciliationState = await loadReconciliationState(session.walletId);

  // Distinct from "zero trades": a wallet that never finished reconciling must never read
  // as clean (the survivorship-bias constraint in
  // `.ai/decisions/event-time-vs-observation-time.md`).
  if (reconcileFailed || reconciliationState !== 'current') {
    return (
      <main>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Dashboard</h1>
        <p>Not yet reconciled. We could not confirm your wallet&apos;s trade history just now — try reopening this page.</p>
      </main>
    );
  }

  const [initial, tradesList] = await Promise.all([
    buildInitialDashboardState(session.walletId, session.userId, lossLimitEnabled),
    loadRecentTrades(session.walletId),
  ]);

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6">
      <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Dashboard</h1>

      <DashboardPanel initial={initial} />

      <h2 style={{ fontSize: '1rem', fontWeight: 600 }}>Recent activity</h2>
      {tradesList.length === 0 ? (
        <p>No trade history yet.</p>
      ) : (
        <ul>
          {tradesList.map((trade) => (
            <li key={trade.signature}>
              <span>{trade.isBaseline ? '[pre-commitment activity — private]' : '[live]'}</span>{' '}
              {trade.excludedReason ? (
                <span>
                  excluded ({trade.excludedReason}) — {formatMint(trade.soldMint)} → {formatMint(trade.boughtMint)}
                </span>
              ) : (
                <span>
                  {formatMint(trade.soldMint)} → {formatMint(trade.boughtMint)} — {formatUsd(trade.usdValue)}
                  {trade.acquiredTier ? (
                    <span>
                      {' '}
                      [{formatTierBadge(trade.acquiredTier, trade.classification)}
                      {trade.isBaseline ? ', backfilled at today’s mcap — not a contemporaneous judgement' : ''}]
                    </span>
                  ) : null}
                  {trade.isRoundTripClose ? (
                    <span>
                      {' '}
                      [{trade.realizedLossUsd !== null ? `realized: ${formatUsd(trade.realizedLossUsd)}` : 'closed a position — not loss-limit-eligible (opened before activation, or a mixed close)'}]
                    </span>
                  ) : null}
                </span>
              )}{' '}
              <span>({trade.occurredAt.toISOString()})</span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
