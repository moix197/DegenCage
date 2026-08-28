import { randomUUID } from 'node:crypto';

import { recordEvent } from '@/observability/events';
import { captureError } from '@/observability/error-tracking';
import { resolveSession } from '@/server/auth/session';
import { CHAIN_HELIUS_RECONCILE_FLAG, hasCompletedBaseline, isStrandedSubmittedIntent, reconcileWallet } from '@/server/chain/reconcile-wallet';
import { assertWithinConstitutionActionRateLimit, ConstitutionActionRateLimited } from '@/server/constitution/rate-limit';
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
 *
 * BLOCKING 1's fix: a user who never navigates to `/dashboard` or `/constitution/edit` never
 * triggers `reconcileWallet()`, so a `signed`/`submitted` intent whose transaction silently
 * never lands would otherwise reserve allowance forever and poll "submitted" indefinitely — the
 * stranded-intent sweep (`reconcile-wallet.ts`'s `sweepStrandedSubmittedIntents`) is unreachable
 * from this flow. This route now drives that resolution itself, once an intent it reads back is
 * past its own blockhash grace period: see `attemptStaleIntentResolution` below.
 *
 * That attempt is bounded on two sides, so this GET can never become the unbounded operation a
 * naive read of `reconcileWallet()` would suggest: it never runs at all while this wallet's own
 * 90-day baseline backfill hasn't completed yet (that pull belongs to the dashboard path, not a
 * poll), and it always races against `POLL_RECONCILE_TIMEOUT_MS` even once baseline is done.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Throttles this route's own resolution attempt, not the plain status read — reuses
 * `assertWithinConstitutionActionRateLimit` (`server/constitution/rate-limit.ts`) exactly as
 * `server/feedback/feedback.ts` does for an unrelated action, same cross-domain reuse that
 * file's own doc comment already establishes as this codebase's convention for a generic
 * per-(userId, eventType) budget, rather than a new limiter. Without this, a client parked on
 * `/trade` with a genuinely stuck intent would re-trigger a full `reconcileWallet()` — a
 * bounded but non-trivial Helius round trip — on every ~15s poll for as long as the tab stays
 * open.
 */
const POLL_RESOLVE_EVENT_TYPE = 'trade.intent_poll_resolve_attempted';

/**
 * Aggregate deadline on the reconcile attempt below, comfortably under `/trade`'s own ~15s
 * poll cadence (`server/swap/README.md`) so a slow or hung Helius round trip never itself
 * becomes the reason this GET stalls. `helius-client.ts`'s own per-page `REQUEST_TIMEOUT_MS`
 * (15s) times `MAX_PAGES` (50) bounds a single `reconcileWallet()` call at several minutes in
 * the worst case — nowhere close to a status poll's own budget — so this route needs its own,
 * tighter ceiling rather than trusting that one.
 */
const POLL_RECONCILE_TIMEOUT_MS = 8_000;

/** Recorded when `POLL_RECONCILE_TIMEOUT_MS` is hit — the visible half of degrading rather than silently swallowing a reconcile that ran long (CLAUDE.md → no silent failures). */
const POLL_RESOLVE_TIMEOUT_EVENT_TYPE = 'trade.intent_poll_resolve_timed_out';

/** Thrown by `withDeadline` below to distinguish "still running, past our budget" from a genuine `reconcileWallet()` failure — the two are reported differently. */
class PollReconcileTimeoutError extends Error {
  constructor() {
    super(`reconcile did not settle within ${POLL_RECONCILE_TIMEOUT_MS}ms`);
    this.name = 'PollReconcileTimeoutError';
  }
}

/**
 * Races `promise` against `ms`. `promise` itself is never cancelled — Node has no way to
 * abort an in-flight `reconcileWallet()` call from here — it is left to finish (or fail) in
 * the background; `.then(resolve, reject)` below keeps that eventual settlement from ever
 * surfacing as an unhandled rejection, it just no longer has anyone waiting on it once the
 * deadline has already won the race.
 */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PollReconcileTimeoutError()), ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Best-effort, same shape as `api/wallet/reconcile/route.ts`'s
 * `applyDuePendingChangesBestEffort`: a failure here must never turn a status read into a
 * broken response, it can only ever leave the poll showing a possibly-stale status. Reuses
 * `reconcileWallet()` wholesale rather than reimplementing either half of what it already does
 * — the on-chain signature linkage (a landed transaction resolves the intent via the normal
 * insert path) and the guarded stranded-intent sweep (nothing landed, so it resolves to
 * `failed`) — and gated by the same kill switch (`CHAIN_HELIUS_RECONCILE_FLAG`) every other
 * route that triggers reconciliation checks.
 *
 * Two guards keep this bounded, on top of the per-wallet rate limit below:
 *  - **Baseline not yet completed → skip entirely.** A wallet mid-baseline (or one that has
 *    never reconciled at all) would have this call trigger the full 90-day backfill inside a
 *    status poll — that pull belongs to the dashboard/`/constitution/edit` path, not here.
 *  - **`POLL_RECONCILE_TIMEOUT_MS` deadline.** Bounds even a legitimate incremental reconcile
 *    so this GET always returns promptly; a deadline hit is recorded, never swallowed.
 */
async function attemptStaleIntentResolution(userId: string, walletId: string, correlationId: string): Promise<void> {
  if (!(await isFeatureEnabled(CHAIN_HELIUS_RECONCILE_FLAG))) {
    return;
  }

  if (!(await hasCompletedBaseline(walletId))) {
    return;
  }

  const now = new Date();

  try {
    await assertWithinConstitutionActionRateLimit(userId, POLL_RESOLVE_EVENT_TYPE, correlationId, now);
  } catch (error) {
    if (error instanceof ConstitutionActionRateLimited) {
      return;
    }

    captureError(error, { correlationId, operation: 'swap.intent_status.resolve_rate_limit' });
    return;
  }

  await recordEvent({ eventType: POLL_RESOLVE_EVENT_TYPE, occurredAt: now, correlationId, userId, payload: {} });

  try {
    await withDeadline(reconcileWallet(correlationId), POLL_RECONCILE_TIMEOUT_MS);
  } catch (error) {
    if (error instanceof PollReconcileTimeoutError) {
      await recordEvent({ eventType: POLL_RESOLVE_TIMEOUT_EVENT_TYPE, occurredAt: new Date(), correlationId, userId, payload: {} });
      return;
    }

    captureError(error, { correlationId, operation: 'swap.intent_status.resolve', failedClosed: false });
  }
}

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

    const isStillReserving = intent.status === 'submitted' || intent.status === 'signed';

    if (!isStillReserving || !isStrandedSubmittedIntent(intent.expiresAt, new Date())) {
      return Response.json({ status: intent.status, signature: intent.signature, correlationId });
    }

    await attemptStaleIntentResolution(session.userId, session.walletId, correlationId);

    // Re-read rather than infer the outcome: `attemptStaleIntentResolution` is best-effort and
    // may have done nothing (flag off, rate limited, or itself failed), so the honest answer is
    // whatever is actually in the row now, not an assumption about what the attempt did.
    const refreshed = await loadIntentStatusForWallet(id, session.walletId);

    return Response.json({ status: refreshed?.status ?? intent.status, signature: refreshed?.signature ?? intent.signature, correlationId });
  } catch (error) {
    captureError(error, { correlationId, route: 'swap.intent_status', failedClosed: false });

    // A failed status read is only a stale display — it can never approve or broadcast anything,
    // so unlike quote/submit this one degrades rather than blocking.
    return Response.json({ error: 'status_unavailable', correlationId }, { status: 503 });
  }
}
