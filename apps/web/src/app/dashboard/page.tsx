import { desc, eq } from 'drizzle-orm';

import type { AssetTier } from '@degencage/rules';
import { resolveSession } from '@/server/auth/session';
import { CHAIN_HELIUS_RECONCILE_FLAG, LOSS_LIMIT_ENABLED_FLAG, ReconcileRejected, reconcileWallet } from '@/server/chain/reconcile-wallet';
import { applyDuePendingChanges } from '@/server/constitution/pending-changes';
import { getDb } from '@/server/db/client';
import { trades, type TokenClassificationQuality } from '@/server/db/schema';
import { buildDashboardState, loadReconciliationState } from '@/server/dashboard/dashboard-state';
import { FEEDBACK_CAPTURE_FLAG } from '@/server/feedback/feedback';
import { DASHBOARD_DISCIPLINE_VIEW_FLAG, isFeatureEnabled } from '@/server/flags/feature-flags';
import { captureError } from '@/observability/error-tracking';
import { recordEvent } from '@/observability/events';
import { DashboardPanel } from './dashboard-panel';
import { FeedbackPrompt } from './feedback-prompt';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The Phase 4–6 status page (`constitution-status/page.tsx`), promoted into the real
 * dashboard (Phase 7): same server-side reconciliation-on-open, plus the live-polling
 * `DashboardPanel` and the violations feed. The allowance/violations computation itself
 * lives in `server/dashboard/dashboard-state.ts`'s `buildDashboardState` — the identical
 * function `GET /api/dashboard` calls for every subsequent poll — so this component only
 * has to build the *initial* server-rendered snapshot from it, never a second copy of the
 * computation.
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

function formatMint(mint: string | null): string {
  if (!mint) return '—';
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

function formatUsd(usdValue: string | null): string {
  return usdValue === null ? 'unvalued' : `$${usdValue}`;
}

/**
 * Reconciliation runs synchronously on every page load — "triggered on app open", not on a
 * schedule. Fails closed throughout: a reconciliation error, a disabled flag, or no active
 * `daily_notional_usd` limit all render an explicit state — never a false "$0 spent today".
 */
export default async function DashboardPage() {
  const [session, dashboardEnabled, reconcileEnabled, lossLimitEnabled, feedbackCaptureEnabled] = await Promise.all([
    resolveSession(),
    isFeatureEnabled(DASHBOARD_DISCIPLINE_VIEW_FLAG),
    isFeatureEnabled(CHAIN_HELIUS_RECONCILE_FLAG),
    isFeatureEnabled(LOSS_LIMIT_ENABLED_FLAG),
    isFeatureEnabled(FEEDBACK_CAPTURE_FLAG),
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

  // The real app-open trigger: `POST /api/wallet/reconcile` has no caller of its own, so this
  // page load (and `/constitution/edit`'s) is what actually resolves a due limit increase.
  // Best-effort and independent of chain reconciliation above — a due constitution edit does
  // not depend on wallet history, so it must still resolve even when `reconcileFailed`.
  try {
    await applyDuePendingChanges(correlationId);
  } catch (error) {
    captureError(error, { correlationId, page: 'dashboard', operation: 'applyDuePendingChanges' });
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
    buildDashboardState({ walletId: session.walletId, userId: session.userId, lossLimitEnabled, correlationId }),
    loadRecentTrades(session.walletId),
  ]);

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6">
      <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Dashboard</h1>

      <DashboardPanel initial={initial} />

      {/* Ships dark by default (`FEEDBACK_CAPTURE_FLAG` not seeded enabled) — surfaced at
          the "after a violation is shown" moment the plan calls out, not on every visit. */}
      {feedbackCaptureEnabled && initial.violations.length > 0 ? <FeedbackPrompt /> : null}

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
