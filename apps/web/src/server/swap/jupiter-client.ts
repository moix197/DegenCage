import { captureError } from '../../observability/error-tracking';
import { isFeatureEnabled } from '../flags/feature-flags';

/**
 * Thin client for Jupiter Swap v2's `build` endpoint — one call returning both a quote and
 * the raw instructions needed to assemble a v0 swap transaction ourselves
 * (`server/swap/assemble-transaction.ts`). Same external-client shape as
 * `chain/helius-client.ts` and `chain/jupiter-tokens.ts`: module-level flag, `BASE_URL`,
 * `REQUEST_TIMEOUT_MS`, one `AbortController`, `isFeatureEnabled` first, no retries.
 *
 * Unlike `lookupTokenMcaps` — which resolves to "no entry" so classification can fall back —
 * this **always throws** on failure. It sits pre-trade: a permissive resolve here would let a
 * quote proceed without the route it is supposed to be quoting.
 *
 * Two documented gaps in `/build` shape the error handling below (confirmed against
 * Jupiter's own docs, not assumed):
 *  - it does **not** document a taker-balance pre-check (contrast `/order`, which reports one
 *    via `errorCode: 1`), so insufficient balance may only surface at simulate/send time;
 *  - the only documented failure shape is `400 { "error": string }`.
 * So any non-200 is surfaced with whatever body came back, and a 200 is never treated as
 * proof the swap will actually execute — `assemble-transaction.ts`'s simulation is.
 */

export const JUPITER_SWAP_BUILD_FLAG = 'jupiter.swap_build';

const BASE_URL = 'https://api.jup.ag';
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * How long the blockhash `/build` returns stays valid, in slots. Passed explicitly rather
 * than left to Jupiter's default so `quote-service.ts` can derive `trade_intents.expires_at`
 * from a number we chose — the response carries `lastValidBlockHeight` but no wall-clock
 * expiry, and no current block height to measure it against.
 */
export const BLOCKHASH_SLOTS_TO_EXPIRY = 150;

export class JupiterBuildError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'JupiterBuildError';
  }
}

export interface JupiterInstructionAccount {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

export interface JupiterInstruction {
  programId: string;
  accounts: JupiterInstructionAccount[];
  /** Base64-encoded instruction data. */
  data: string;
}

export interface JupiterRoutePlanStep {
  swapInfo: { ammKey: string; label: string; inputMint: string; outputMint: string; inAmount: string; outAmount: string };
  percent: number;
}

export interface JupiterBlockhashWithMetadata {
  /** Raw bytes, **not** a base58 string — `assemble-transaction.ts` encodes it before use. */
  blockhash: number[];
  lastValidBlockHeight: number;
  fetchedAt?: { secs_since_epoch: number; nanos_since_epoch: number };
}

export interface JupiterBuildResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  /** Minimum output after slippage — the guaranteed floor, unlike the optimistic `outAmount`. */
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: JupiterRoutePlanStep[];
  computeBudgetInstructions: JupiterInstruction[];
  setupInstructions: JupiterInstruction[];
  swapInstruction: JupiterInstruction;
  cleanupInstruction: JupiterInstruction | null;
  otherInstructions: JupiterInstruction[];
  tipInstruction: JupiterInstruction | null;
  addressesByLookupTableAddress: Record<string, string[]> | null;
  blockhashWithMetadata: JupiterBlockhashWithMetadata;
}

export interface BuildSwapParams {
  inputMint: string;
  outputMint: string;
  /** Base units of `inputMint`, as a decimal-digit string. */
  amount: string;
  /** The wallet that will sign — baked into the returned instructions (ATA derivation, transfer authority). */
  taker: string;
  slippageBps: number;
}

function requireApiKey(): string {
  const key = process.env.JUPITER_API_KEY;

  if (!key) {
    throw new JupiterBuildError('JUPITER_API_KEY is not set');
  }

  return key;
}

/** `400 { "error": string }` is the only documented failure body; anything else is surfaced raw rather than guessed at. */
async function describeFailure(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');

  try {
    const parsed = JSON.parse(body) as { error?: unknown };

    if (typeof parsed.error === 'string') {
      return parsed.error;
    }
  } catch {
    // Not JSON — fall through to the raw body below.
  }

  return body.slice(0, 200);
}

function buildUrl(params: BuildSwapParams): string {
  // No `platformFeeBps`/`feeAccount`: DegenCage charges no platform fee (decision 10).
  const query = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount,
    taker: params.taker,
    slippageBps: String(params.slippageBps),
    blockhashSlotsToExpiry: String(BLOCKHASH_SLOTS_TO_EXPIRY),
  });

  return `${BASE_URL}/swap/v2/build?${query.toString()}`;
}

/**
 * Fetches a quote plus raw swap instructions for `params`.
 *
 * Fails closed: gated by `isFeatureEnabled(JUPITER_SWAP_BUILD_FLAG)`, and a disabled flag, a
 * missing key, a timeout, a non-200 or an unparseable body all throw `JupiterBuildError` —
 * never a partial or permissive result. No retries: this runs inside a user-facing quote
 * request against a 1 RPS shared bucket, so a retry storm would only turn a slow call into a
 * rate-limited one.
 *
 * @param correlationId - The caller's trade-intent correlation id, carried on a captured
 *   failure so this integration boundary does not break the id's UI → rule engine → Jupiter →
 *   chain chain (CLAUDE.md → Observability). Optional only because a handful of call sites this
 *   plan does not own yet have none to pass.
 */
export async function buildSwap(params: BuildSwapParams, correlationId?: string): Promise<JupiterBuildResponse> {
  if (!(await isFeatureEnabled(JUPITER_SWAP_BUILD_FLAG))) {
    throw new JupiterBuildError('jupiter.swap_build is disabled');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(buildUrl(params), {
      signal: controller.signal,
      headers: { 'x-api-key': requireApiKey() },
    });

    if (!response.ok) {
      throw new JupiterBuildError(`Jupiter /swap/v2/build responded ${response.status}: ${await describeFailure(response)}`, response.status);
    }

    return (await response.json()) as JupiterBuildResponse;
  } catch (error) {
    captureError(error, {
      operation: 'buildSwap',
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      ...(correlationId !== undefined ? { correlationId } : {}),
      failedClosed: true,
    });

    throw error instanceof JupiterBuildError ? error : new JupiterBuildError('jupiter build request failed', undefined, error);
  } finally {
    clearTimeout(timeout);
  }
}
