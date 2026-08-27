import { captureError } from '../../observability/error-tracking';
import { isFeatureEnabled } from '../flags/feature-flags';

/**
 * Long-tail mint pricing via Birdeye's historical price endpoint (decision 19's alt↔alt
 * fallback, deferred to Phase 5). Behind its own kill switch and fails closed exactly like
 * `binance-klines.ts`: disabled, a missing API key, a timeout, a non-200, or a mint Birdeye
 * has no price for all resolve to `null` — never a guessed or carried-forward price
 * (CLAUDE.md → fail closed).
 *
 * No cache table of its own (unlike the shared `token_prices` minute cache for SOL): a
 * long-tail mint's price is looked up per trade rather than per minute across every wallet,
 * since alt↔alt volume is the tail, not the majority, of what this pipeline prices.
 */

export const PRICING_BIRDEYE_FLAG = 'pricing.birdeye';

const BIRDEYE_BASE_URL = 'https://public-api.birdeye.so';
const REQUEST_TIMEOUT_MS = 8_000;

function requireApiKey(): string {
  const key = process.env.BIRDEYE_API_KEY;

  if (!key) {
    throw new Error('BIRDEYE_API_KEY is not set');
  }

  return key;
}

interface BirdeyeHistoricalPriceResponse {
  data?: { value?: number } | null;
}

async function fetchHistoricalPrice(mint: string, unixSeconds: number): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const url = `${BIRDEYE_BASE_URL}/defi/historical_price_unix?address=${mint}&unixtime=${unixSeconds}`;
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'X-API-KEY': requireApiKey(), 'x-chain': 'solana' },
    });

    if (!response.ok) {
      captureError(new Error(`Birdeye historical_price_unix responded ${response.status}`), { mint, unixSeconds });
      return null;
    }

    const json = (await response.json()) as BirdeyeHistoricalPriceResponse;
    const value = json.data?.value;

    return typeof value === 'number' ? value.toString() : null;
  } catch (error) {
    captureError(error, { operation: 'fetchHistoricalPrice', mint, failedClosed: true });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** `mint`'s USD price at `occurredAt`, via Birdeye. `null` fails closed — see module doc. */
export async function getBirdeyeUsdPrice(mint: string, occurredAt: Date): Promise<string | null> {
  if (!(await isFeatureEnabled(PRICING_BIRDEYE_FLAG))) {
    return null;
  }

  return fetchHistoricalPrice(mint, Math.floor(occurredAt.getTime() / 1_000));
}
