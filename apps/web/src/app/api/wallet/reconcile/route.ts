import { randomUUID } from 'node:crypto';

import { captureError } from '@/observability/error-tracking';
import { isFeatureEnabled } from '@/server/flags/feature-flags';
import { CHAIN_HELIUS_RECONCILE_FLAG, ReconcileRejected, reconcileWallet } from '@/server/chain/reconcile-wallet';
import { applyDuePendingChanges } from '@/server/constitution/pending-changes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Applies any due constitution limit increases alongside chain reconciliation. Best-effort:
 * a failure here must never turn a successful chain reconciliation into an error response —
 * `applyDuePendingChanges` already fails closed internally (captures and skips a row it
 * cannot apply rather than throwing), so this only guards against something even more
 * unexpected escaping it.
 */
async function applyDuePendingChangesBestEffort(correlationId: string): Promise<void> {
  try {
    await applyDuePendingChanges(correlationId);
  } catch (error) {
    captureError(error, { correlationId, operation: 'reconcile.applyDuePendingChanges' });
  }
}

/**
 * Meant to be triggered on app open (not scheduled — `.ai/decisions/hosting-and-growth-path.md`'s
 * Phase 0 no-cron approach), same as `reconcileWallet()`'s other call site. **The real
 * app-open triggers are the page loads themselves** — `apps/web/src/app/dashboard/page.tsx`
 * and `apps/web/src/app/constitution/edit/page.tsx` both call `reconcileWallet()` /
 * `applyDuePendingChanges()` directly server-side; nothing in this app currently calls this
 * route. It is kept wired (not deleted) as the API surface for a future non-page caller —
 * a client-driven refresh button, a mobile client — so that caller does not have to
 * reintroduce this wiring from scratch, but it is not load-bearing for either page today.
 *
 * Also piggybacks Phase 8's `applyDuePendingChanges()` on this same app-open trigger — the
 * plan's lazy-cron pattern used once already for chain reconciliation, reused here rather
 * than standing up a second scheduler for one more "runs on app open" job.
 */
export async function POST(): Promise<Response> {
  const correlationId = randomUUID();

  if (!(await isFeatureEnabled(CHAIN_HELIUS_RECONCILE_FLAG))) {
    return Response.json({ error: 'chain_helius_reconcile_disabled', correlationId }, { status: 503 });
  }

  try {
    const result = await reconcileWallet(correlationId);

    await applyDuePendingChangesBestEffort(correlationId);

    return Response.json({ result, correlationId });
  } catch (error) {
    if (error instanceof ReconcileRejected) {
      return Response.json({ error: error.reason, correlationId }, { status: error.reason === 'unauthenticated' ? 401 : 400 });
    }

    captureError(error, { correlationId, route: 'wallet.reconcile' });

    // Fail closed: the caller learns reconciliation did not happen, never a false success.
    return Response.json({ error: 'reconcile_unavailable', correlationId }, { status: 503 });
  }
}
