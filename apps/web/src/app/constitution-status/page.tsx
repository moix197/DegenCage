import { desc, eq } from 'drizzle-orm';

import { migrateConstitution } from '@degencage/rules';
import { resolveSession } from '@/server/auth/session';
import { CHAIN_HELIUS_RECONCILE_FLAG, ReconcileRejected, reconcileWallet } from '@/server/chain/reconcile-wallet';
import { getDb } from '@/server/db/client';
import { constitutions, trades, wallets } from '@/server/db/schema';
import { isFeatureEnabled } from '@/server/flags/feature-flags';
import { computeRollingAllowance } from '@/server/rules/rolling-allowance';
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
    })
    .from(trades)
    .where(eq(trades.walletId, walletId))
    .orderBy(desc(trades.occurredAt))
    .limit(TRADE_LIST_LIMIT);
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

  const allowance = dailyNotionalLimit
    ? await computeRollingAllowance({
        walletId: session.walletId,
        windowHours: dailyNotionalLimit.windowHours,
        asOf: new Date(),
        maxUsd: dailyNotionalLimit.maxUsd,
      })
    : null;

  return (
    <main>
      <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Constitution status</h1>

      {allowance ? (
        <p>
          Today&apos;s notional: {formatUsd(allowance.totalUsd)} of ${allowance.maxUsd}
          {!allowance.withinLimit ? ' — over limit' : ''}
        </p>
      ) : (
        <p>No daily notional limit set on your active constitution.</p>
      )}

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
