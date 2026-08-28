import { randomUUID } from 'node:crypto';

import { captureError } from '@/observability/error-tracking';
import { resolveSession } from '@/server/auth/session';
import { isFeatureEnabled, TRADE_TERMINAL_FLAG } from '@/server/flags/feature-flags';
import { submitSignedSwap, SubmitRejectedError, type SubmitRejectionReason } from '@/server/swap/submit-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The terminal's second and last server call: the signed bytes come back here to be verified
 * against the intent the server itself approved, and only then broadcast (or, with
 * `chain.broadcast` off, simulated).
 *
 * Thin by design, exactly like `api/swap/quote/route.ts` — validation and error shaping only.
 * Every check lives in `server/swap/submit-service.ts`. The wallet identity comes from
 * `resolveSession()` and never from the body: a body-supplied wallet would let anyone submit
 * against anyone's intent, which is the one thing decision 13 exists to prevent.
 */

/** A v0 swap transaction is ~1.2KB of bytes; base64 of the 1232-byte packet limit is ~1644 chars. Anything larger is not a Solana transaction. */
const MAX_SIGNED_TRANSACTION_CHARS = 4_096;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

interface SubmitRequestBody {
  intentId?: unknown;
  signedTransaction?: unknown;
}

interface ValidatedBody {
  intentId: string;
  signedTransaction: string;
}

function validateBody(body: SubmitRequestBody): ValidatedBody | null {
  const { intentId, signedTransaction } = body;

  if (typeof intentId !== 'string' || !UUID_PATTERN.test(intentId)) return null;
  if (typeof signedTransaction !== 'string') return null;
  if (signedTransaction.length === 0 || signedTransaction.length > MAX_SIGNED_TRANSACTION_CHARS) return null;
  if (!BASE64_PATTERN.test(signedTransaction)) return null;

  return { intentId, signedTransaction };
}

/**
 * A wallet mismatch is an authorization failure — someone is submitting against an intent that
 * is not theirs — so it answers `403`, distinct from the `409`s that mean "this intent is no
 * longer in a state that can be submitted".
 */
function statusForRejection(reason: SubmitRejectionReason): number {
  return reason === 'wallet_mismatch' ? 403 : 409;
}

export async function POST(request: Request): Promise<Response> {
  const correlationId = randomUUID();

  if (!(await isFeatureEnabled(TRADE_TERMINAL_FLAG))) {
    return Response.json({ error: 'trade_terminal_disabled', correlationId }, { status: 503 });
  }

  const session = await resolveSession();

  if (!session) {
    return Response.json({ error: 'unauthenticated', correlationId }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as SubmitRequestBody | null;
  const validated = body ? validateBody(body) : null;

  if (!validated) {
    return Response.json({ error: 'invalid_request', correlationId }, { status: 400 });
  }

  try {
    const result = await submitSignedSwap({
      intentId: validated.intentId,
      signedTransactionBase64: validated.signedTransaction,
      walletId: session.walletId,
      walletAddress: session.walletAddress,
      userId: session.userId,
      correlationId,
    });

    return Response.json({ ...result, correlationId });
  } catch (error) {
    // Every rejection already left the intent in a non-broadcast state and recorded
    // `trade.intent_failed`; this only chooses the status code.
    if (error instanceof SubmitRejectedError) {
      return Response.json({ error: error.reason, correlationId }, { status: statusForRejection(error.reason) });
    }

    captureError(error, { correlationId, route: 'swap.submit', failedClosed: true });

    // Fail closed: an unavailable verification is never permission to have broadcast.
    return Response.json({ error: 'submit_unavailable', correlationId }, { status: 503 });
  }
}
