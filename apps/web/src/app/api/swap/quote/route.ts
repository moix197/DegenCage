import { randomUUID } from 'node:crypto';

import { isAddress } from '@solana/kit';

import { captureError } from '@/observability/error-tracking';
import { resolveSession } from '@/server/auth/session';
import { isFeatureEnabled, TRADE_TERMINAL_FLAG } from '@/server/flags/feature-flags';
import { JUPITER_SWAP_BUILD_FLAG } from '@/server/swap/jupiter-client';
import { createQuote, QuotePreconditionError, type QuoteRequestParams } from '@/server/swap/quote-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The `/trade` terminal's only server call: quote a swap and return the rule-engine's verdict
 * on it, before the wallet is ever asked to sign.
 *
 * Thin by design — validation and error shaping only. Every decision lives in
 * `server/swap/quote-service.ts`. The wallet is taken from `resolveSession()` and never from
 * the body: a body-supplied wallet would make every rule in the product opt-out.
 */

/** Jupiter's own default; the terminal does not expose a slippage control yet. */
const DEFAULT_SLIPPAGE_BPS = 50;
/**
 * 5% — above Jupiter's own "high slippage" warning band, and wide enough for a genuinely
 * illiquid pair, while bounding the gap between the quote the user is shown and what the swap
 * can actually fill at. A request asking for more than this is not a trade that needs a wider
 * tolerance, it is a trade that needs a smaller size. Out-of-range values are **rejected**,
 * never clamped: silently trading something other than what was asked for is the kind of
 * quiet accommodation this product exists to refuse.
 */
const MAX_SLIPPAGE_BPS = 500;

interface QuoteRequestBody {
  inputMint?: unknown;
  outputMint?: unknown;
  amount?: unknown;
  slippageBps?: unknown;
}

type ValidatedBody = Pick<QuoteRequestParams, 'inputMint' | 'outputMint' | 'amount' | 'slippageBps'>;

/** A base-unit amount is a positive integer digit string — never a float, never scientific notation, never `0`. */
function isPositiveBaseUnitAmount(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
}

function validateBody(body: QuoteRequestBody): ValidatedBody | null {
  const { inputMint, outputMint, amount } = body;
  const slippageBps = body.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

  if (typeof inputMint !== 'string' || !isAddress(inputMint)) return null;
  if (typeof outputMint !== 'string' || !isAddress(outputMint)) return null;
  if (inputMint === outputMint) return null;
  if (!isPositiveBaseUnitAmount(amount)) return null;
  if (typeof slippageBps !== 'number' || !Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) return null;

  return { inputMint, outputMint, amount, slippageBps };
}

export async function POST(request: Request): Promise<Response> {
  const correlationId = randomUUID();

  const [terminalEnabled, swapBuildEnabled] = await Promise.all([
    isFeatureEnabled(TRADE_TERMINAL_FLAG),
    isFeatureEnabled(JUPITER_SWAP_BUILD_FLAG),
  ]);

  if (!terminalEnabled || !swapBuildEnabled) {
    return Response.json({ error: 'trade_terminal_disabled', correlationId }, { status: 503 });
  }

  const session = await resolveSession();

  if (!session) {
    return Response.json({ error: 'unauthenticated', correlationId }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as QuoteRequestBody | null;
  const validated = body ? validateBody(body) : null;

  if (!validated) {
    return Response.json({ error: 'invalid_request', correlationId }, { status: 400 });
  }

  try {
    const result = await createQuote({
      ...validated,
      walletId: session.walletId,
      walletAddress: session.walletAddress,
      userId: session.userId,
      correlationId,
    });

    return Response.json({ ...result, correlationId });
  } catch (error) {
    // Nothing binding to evaluate against, or a history we cannot trust — a refusal to quote
    // at all, not a rule decision, so it never reaches the audit trail as one.
    if (error instanceof QuotePreconditionError) {
      return Response.json({ error: error.reason, correlationId }, { status: 409 });
    }

    captureError(error, { correlationId, route: 'swap.quote', failedClosed: true });

    // Fail closed: the caller learns the quote is unavailable. There is no degraded response
    // here — an unavailable rule verdict must never read as permission to trade.
    return Response.json({ error: 'quote_unavailable', correlationId }, { status: 503 });
  }
}
