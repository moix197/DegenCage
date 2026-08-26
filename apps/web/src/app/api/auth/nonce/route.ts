import { randomUUID } from 'node:crypto';

import { captureError } from '@/observability/error-tracking';
import { issueSignInChallenge, WALLET_CONNECT_FLAG } from '@/server/auth/solana-siws';
import { isFeatureEnabled } from '@/server/flags/feature-flags';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Issues one single-use SIWS challenge.
 *
 * Behind `auth.wallet_connect` and fail closed: with the switch off, or with the flag
 * lookup itself failing, no challenge exists — so nothing downstream can be verified and
 * no session can be created.
 */
export async function POST(): Promise<Response> {
  const correlationId = randomUUID();

  if (!(await isFeatureEnabled(WALLET_CONNECT_FLAG))) {
    return Response.json(
      { error: 'wallet_connect_disabled', correlationId },
      { status: 503 },
    );
  }

  try {
    const input = await issueSignInChallenge(correlationId);

    return Response.json({ input, correlationId });
  } catch (error) {
    captureError(error, { correlationId, route: 'auth.nonce' });

    return Response.json({ error: 'challenge_unavailable', correlationId }, { status: 503 });
  }
}
