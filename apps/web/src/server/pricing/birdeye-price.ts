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

/**
 * Converts a raw JSON number to a plain fixed-notation decimal string — never exponential.
 * `Number.prototype.toString()` switches to exponential notation below 1e-6 (and above
 * 1e21), and `price-trade.ts`'s `multiplyUsd`/`baseUnitsToDecimalString` feed this string
 * straight into `BigInt(...)`, which throws on an exponent (`BigInt('12345e-7')`). Sub-1e-6
 * prices are exactly what the long-tail MICRO_CAP mints this fallback targets tend to have,
 * so this conversion is load-bearing, not defensive.
 *
 * `null` for non-finite input (`NaN`/`Infinity`) — fails closed exactly like every other
 * unresolvable price in this module, never a guessed number.
 */
function toFixedDecimalString(value: number): string | null {
  if (!Number.isFinite(value)) {
    return null;
  }

  const raw = value.toString();
  const exponentIndex = raw.search(/e/i);

  if (exponentIndex === -1) {
    return raw;
  }

  const mantissa = raw.slice(0, exponentIndex);
  const exponent = Number.parseInt(raw.slice(exponentIndex + 1), 10);
  const negative = mantissa.startsWith('-');
  const [intPart = '', fracPart = ''] = (negative ? mantissa.slice(1) : mantissa).split('.');
  const digits = intPart + fracPart;
  // Where the decimal point lands once `digits` is shifted by `exponent` places, measured
  // from the point's original position right after `intPart`.
  const pointIndex = intPart.length + exponent;

  let magnitude: string;

  if (pointIndex <= 0) {
    magnitude = `0.${'0'.repeat(-pointIndex)}${digits}`;
  } else if (pointIndex >= digits.length) {
    magnitude = digits + '0'.repeat(pointIndex - digits.length);
  } else {
    magnitude = `${digits.slice(0, pointIndex)}.${digits.slice(pointIndex)}`;
  }

  return negative ? `-${magnitude}` : magnitude;
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

    return typeof value === 'number' ? toFixedDecimalString(value) : null;
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
