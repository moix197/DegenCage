import { randomUUID } from 'node:crypto';

import { resolveSession } from '@/server/auth/session';
import { CHAIN_HELIUS_RECONCILE_FLAG, LOSS_LIMIT_ENABLED_FLAG } from '@/server/chain/reconcile-wallet';
import { buildDashboardState, loadReconciliationState } from '@/server/dashboard/dashboard-state';
import { DASHBOARD_DISCIPLINE_VIEW_FLAG, isFeatureEnabled } from '@/server/flags/feature-flags';
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
 * only has to re-run `buildDashboardState` (`server/dashboard/dashboard-state.ts`) against
 * whatever is already persisted — no new server computation, per this phase's brief.
 *
 * `buildDashboardState` is the single source for this shape — `dashboard/page.tsx`'s
 * initial SSR render calls the exact same function, so the two can never drift.
 */
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
    const response = await buildDashboardState({ walletId: session.walletId, userId: session.userId, lossLimitEnabled, correlationId });

    return Response.json(response);
  } catch (error) {
    captureError(error, { correlationId, route: 'dashboard.get' });

    // Fail closed: the caller learns the figures are unavailable, never a stale or false "clean" read.
    return Response.json({ error: 'dashboard_unavailable', correlationId }, { status: 503 });
  }
}
