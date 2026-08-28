import { randomUUID } from 'node:crypto';

import { captureError } from '@/observability/error-tracking';
import { resolveSession } from '@/server/auth/session';
import { isFeatureEnabled, TRADE_TERMINAL_FLAG } from '@/server/flags/feature-flags';
import { loadIntentStatusForWallet } from '@/server/swap/intent-lifecycle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The terminal's status poll: after a submit returns, `/trade` polls this until the intent
 * reaches a terminal status, so the user sees reconciliation flip it to `confirmed`/`failed`
 * instead of being left on "submitted" forever.
 *
 * Read-only and thin, like the other two swap routes — the wallet-scoping that makes it safe
 * lives in `loadIntentStatusForWallet`, not here. The wallet comes from `resolveSession()` and
 * never from the request, so one user can never poll another's intent (decision 13).
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const correlationId = randomUUID();

  if (!(await isFeatureEnabled(TRADE_TERMINAL_FLAG))) {
    return Response.json({ error: 'trade_terminal_disabled', correlationId }, { status: 503 });
  }

  const session = await resolveSession();

  if (!session) {
    return Response.json({ error: 'unauthenticated', correlationId }, { status: 401 });
  }

  const { id } = await params;

  if (!UUID_PATTERN.test(id)) {
    return Response.json({ error: 'invalid_request', correlationId }, { status: 400 });
  }

  try {
    const intent = await loadIntentStatusForWallet(id, session.walletId);

    if (!intent) {
      return Response.json({ error: 'intent_not_found', correlationId }, { status: 404 });
    }

    return Response.json({ status: intent.status, signature: intent.signature, correlationId });
  } catch (error) {
    captureError(error, { correlationId, route: 'swap.intent_status', failedClosed: false });

    // A failed status read is only a stale display — it can never approve or broadcast anything,
    // so unlike quote/submit this one degrades rather than blocking.
    return Response.json({ error: 'status_unavailable', correlationId }, { status: 503 });
  }
}
