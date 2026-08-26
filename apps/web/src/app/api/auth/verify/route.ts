import { randomUUID } from 'node:crypto';

import { cookies } from 'next/headers';

import { captureError } from '@/observability/error-tracking';
import { logger } from '@/observability/logger';
import {
  buildClearedSessionCookie,
  parseRevocationReason,
  resolveSession,
  revokeSession,
  supersedePreviousSession,
  type SessionCookie,
} from '@/server/auth/session';
import { parseSignInProof, SignInRejected, verifyWalletSignIn } from '@/server/auth/solana-siws';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function applyCookie(cookie: SessionCookie): Promise<void> {
  (await cookies()).set(cookie.name, cookie.value, cookie.options);
}

/**
 * Exchanges a signed SIWS challenge for a session.
 *
 * Every rejection returns the same shape and status. A caller learns only that it failed,
 * never *which* of expiry, replay, domain or signature tripped — that distinction is in
 * the logs, where it is useful, not in the response, where it is a probing oracle.
 */
export async function POST(request: Request): Promise<Response> {
  const correlationId = randomUUID();

  try {
    // A body that is not JSON is a rejected sign-in, not a server fault.
    const proof = parseSignInProof(await request.json().catch(() => null));

    if (!proof) {
      return Response.json({ error: 'sign_in_rejected', correlationId }, { status: 401 });
    }

    // Read *before* verifying and before the new cookie is written: this is the identity
    // the request arrived as, straight from the cookie, and it is the only thing the
    // switch check is allowed to compare against.
    const previous = await resolveSession();
    const session = await verifyWalletSignIn(proof, correlationId);

    await supersedePreviousSession(previous, session.walletAddress, correlationId);
    await applyCookie(session.cookie);

    return Response.json({ address: session.walletAddress, correlationId });
  } catch (error) {
    if (error instanceof SignInRejected) {
      logger.warn('wallet sign-in rejected', { correlationId, reason: error.reason });

      return Response.json({ error: 'sign_in_rejected', correlationId }, { status: 401 });
    }

    captureError(error, { correlationId, route: 'auth.verify' });

    return Response.json({ error: 'sign_in_unavailable', correlationId }, { status: 503 });
  }
}

/**
 * Kills the current session. Called by the account-switch watcher: the moment the wallet
 * points at a different account — or stops reporting one at all — the session bound to
 * the old account must stop resolving.
 *
 * `reason` is an annotation on a revocation the caller is entitled to ask for, never an
 * identity claim: which session dies is decided by the cookie alone, and the value is
 * narrowed to a known reason server-side before it reaches the audit trail.
 */
export async function DELETE(request: Request): Promise<Response> {
  const correlationId = randomUUID();
  const reason = parseRevocationReason(new URL(request.url).searchParams.get('reason'));

  await revokeSession(correlationId, reason);
  await applyCookie(buildClearedSessionCookie());

  return Response.json({ correlationId });
}
