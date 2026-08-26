import { randomUUID } from 'node:crypto';

import { cookies } from 'next/headers';

import { captureError } from '@/observability/error-tracking';
import { logger } from '@/observability/logger';
import { buildClearedSessionCookie, revokeSession, type SessionCookie } from '@/server/auth/session';
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

    const session = await verifyWalletSignIn(proof, correlationId);
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
 * points at a different account, the session bound to the old one must stop resolving.
 */
export async function DELETE(): Promise<Response> {
  const correlationId = randomUUID();

  await revokeSession(correlationId);
  await applyCookie(buildClearedSessionCookie());

  return Response.json({ correlationId });
}
