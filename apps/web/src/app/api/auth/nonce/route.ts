import { randomUUID } from 'node:crypto';

import { captureError } from '@/observability/error-tracking';
import {
  ChallengeRateLimited,
  CHALLENGE_RATE_LIMIT_RETRY_AFTER_SECONDS,
  clientKeyForRequest,
} from '@/server/auth/challenge-rate-limit';
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
 *
 * Rate limited per client (`challenge-rate-limit`), because this is the one unauthenticated
 * endpoint that writes a row: without a limit a loop fills `siws_challenges` for free.
 */
export async function POST(request: Request): Promise<Response> {
  const correlationId = randomUUID();

  if (!(await isFeatureEnabled(WALLET_CONNECT_FLAG))) {
    return Response.json(
      { error: 'wallet_connect_disabled', correlationId },
      { status: 503 },
    );
  }

  try {
    const input = await issueSignInChallenge(correlationId, clientKeyForRequest(request));

    return Response.json({ input, correlationId });
  } catch (error) {
    if (error instanceof ChallengeRateLimited) {
      return Response.json(
        { error: 'rate_limited', correlationId },
        {
          status: 429,
          headers: { 'retry-after': String(CHALLENGE_RATE_LIMIT_RETRY_AFTER_SECONDS) },
        },
      );
    }

    captureError(error, { correlationId, route: 'auth.nonce' });

    return Response.json({ error: 'challenge_unavailable', correlationId }, { status: 503 });
  }
}
