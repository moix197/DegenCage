import { randomUUID } from 'node:crypto';

import { captureError } from '@/observability/error-tracking';
import { isFeatureEnabled } from '@/server/flags/feature-flags';
import { CHAIN_HELIUS_RECONCILE_FLAG, ReconcileRejected, reconcileWallet } from '@/server/chain/reconcile-wallet';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Triggered on app open (not scheduled — `.ai/decisions/hosting-and-growth-path.md`'s
 * Phase 0 no-cron approach). Wallet identity comes entirely from `resolveSession()` inside
 * `reconcileWallet()`; this route never reads a wallet id from the request.
 */
export async function POST(): Promise<Response> {
  const correlationId = randomUUID();

  if (!(await isFeatureEnabled(CHAIN_HELIUS_RECONCILE_FLAG))) {
    return Response.json({ error: 'chain_helius_reconcile_disabled', correlationId }, { status: 503 });
  }

  try {
    const result = await reconcileWallet(correlationId);

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
