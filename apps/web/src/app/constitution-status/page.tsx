import { desc, eq } from 'drizzle-orm';

import { compareUsd, migrateConstitution, sumTradeUsd, type AssetTier } from '@degencage/rules';
import { resolveSession } from '@/server/auth/session';
import { CHAIN_HELIUS_RECONCILE_FLAG, ReconcileRejected, reconcileWallet } from '@/server/chain/reconcile-wallet';
import { getDb } from '@/server/db/client';
import { constitutions, trades, wallets, type TokenClassificationQuality } from '@/server/db/schema';
import { isFeatureEnabled } from '@/server/flags/feature-flags';
import { computeRollingAllowance, loadWindowedTrades } from '@/server/rules/rolling-allowance';
import { captureError } from '@/observability/error-tracking';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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
 * "Today's notional" against the caller's active `daily_notional_usd` limit, plus a bare
 * trade list. Reconciliation runs synchronously on every page load — "triggered on app
 * open" (this phase's success criteria), not on a schedule.
 *
 * Fails closed throughout: a reconciliation error, a disabled flag, or no active
 * `daily_notional_usd` limit all render an explicit "not yet reconciled" / "no limit set"
 * state — never a false "$0 spent today" or a false "clean".
 */
export default async function ConstitutionStatusPage() {
  const [session, reconcileEnabled] = await Promise.all([resolveSession(), isFeatureEnabled(CHAIN_HELIUS_RECONCILE_FLAG)]);

  if (!reconcileEnabled) {
    return (
      <main>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Constitution status</h1>
        <p>Wallet reconciliation is switched off right now. Nothing is wrong with your wallet.</p>
      </main>
    );
  }

  if (!session) {
    return (
      <main>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Constitution status</h1>
        <p>
          Connect your wallet on <a href="/connect">/connect</a> first.
        </p>
      </main>
    );
  }

  const correlationId = crypto.randomUUID();
  let reconcileFailed = false;

  try {
    await reconcileWallet(correlationId);
  } catch (error) {
    if (!(error instanceof ReconcileRejected)) {
      captureError(error, { correlationId, page: 'constitution-status' });
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
        <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Constitution status</h1>
        <p>Not yet reconciled. We could not confirm your wallet&apos;s trade history just now — try reopening this page.</p>
      </main>
    );
  }

  const [constitutionRow, tradesList] = await Promise.all([
    getDb().select().from(constitutions).where(eq(constitutions.userId, session.userId)).limit(1),
    loadRecentTrades(session.walletId),
  ]);

  const constitution = constitutionRow[0] && constitutionRow[0].status === 'active' ? migrateConstitution(constitutionRow[0].document) : null;
  const dailyNotionalLimit = constitution?.limits.find(
    (limit): limit is Extract<typeof limit, { type: 'daily_notional_usd' }> => limit.type === 'daily_notional_usd',
  );

  const tierLimit = constitution?.limits.find(
    (limit): limit is Extract<typeof limit, { type: 'asset_tier_acquisition_usd' }> =>
      limit.type === 'asset_tier_acquisition_usd',
  );

  const [allowance, tierAllowance] = await Promise.all([
    dailyNotionalLimit
      ? computeRollingAllowance({
          walletId: session.walletId,
          windowHours: dailyNotionalLimit.windowHours,
          asOf: new Date(),
          maxUsd: dailyNotionalLimit.maxUsd,
        })
      : null,
    tierLimit ? computeTierAllowance(session.walletId, tierLimit) : null,
  ]);

  return (
    <main>
      <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Constitution status</h1>

      {allowance ? (
        allowance.totalUsd === null ? (
          <p>
            Today&apos;s notional: unknown of ${allowance.maxUsd} — some trades in the window could not be priced, so the
            limit status is unknown (never assumed clean, never assumed over).
          </p>
        ) : (
          <p>
            Today&apos;s notional: {formatUsd(allowance.totalUsd)} of ${allowance.maxUsd}
            {!allowance.withinLimit ? ' — over limit' : ''}
          </p>
        )
      ) : (
        <p>No daily notional limit set on your active constitution.</p>
      )}

      {tierAllowance ? (
        tierAllowance.totalUsd === null ? (
          <p>
            {tierAllowance.tier} acquisitions: unknown of ${tierAllowance.maxUsd} — some trades in the window could not be
            priced, so the limit status is unknown (never assumed clean, never assumed over).
          </p>
        ) : (
          <p>
            {tierAllowance.tier} acquisitions: {formatUsd(tierAllowance.totalUsd)} of ${tierAllowance.maxUsd}
            {!tierAllowance.withinLimit ? ' — over limit' : ''}
          </p>
        )
      ) : null}

      <h2 style={{ fontSize: '1rem', fontWeight: 600 }}>Recent activity</h2>
      {tradesList.length === 0 ? (
        <p>No trade history yet.</p>
      ) : (
        <ul>
          {tradesList.map((trade) => (
            <li key={trade.signature}>
              <span>{trade.isBaseline ? '[baseline — private]' : '[live]'}</span>{' '}
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
