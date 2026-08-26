import { and, eq } from 'drizzle-orm';

import { captureError } from '../../observability/error-tracking';
import { getDb } from '../db/client';
import { tokenPrices } from '../db/schema';
import { isFeatureEnabled } from '../flags/feature-flags';

/**
 * Shared 1-minute SOL/USDT price cache, backed by Binance's public klines endpoint
 * (decision 19). One row per `(mint, minute)` serves every wallet's reconciliation, so a
 * price is fetched from Binance at most once per minute total, not once per trade.
 *
 * Behind its own kill switch (`PRICING_BINANCE_FLAG`) and fails closed: disabled, an
 * unresolvable minute, or a request error all resolve to `null` — never a guessed or
 * carried-forward price (CLAUDE.md → fail closed; a trade this leaves unpriced becomes
 * `usd_value: null`, never `0`, in `price-trade.ts`).
 */

export const PRICING_BINANCE_FLAG = 'pricing.binance';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';

const BINANCE_SOL_SYMBOL = 'SOLUSDT';
const BINANCE_BASE_URL = 'https://data-api.binance.vision';
const REQUEST_TIMEOUT_MS = 8_000;

/** Floors to the start of the UTC minute — Binance klines are keyed by minute, not second. */
export function minuteBucketUtc(date: Date): Date {
  const bucket = new Date(date);
  bucket.setUTCSeconds(0, 0);
  return bucket;
}

type BinanceKline = [
  number, // open time
  string, // open
  string, // high
  string, // low
  string, // close
  ...unknown[],
];

async function fetchKlineClose(minuteBucket: Date): Promise<string | null> {
  const startTime = minuteBucket.getTime();
  const endTime = startTime + 60_000;
  const url = `${BINANCE_BASE_URL}/api/v3/klines?symbol=${BINANCE_SOL_SYMBOL}&interval=1m&startTime=${startTime}&endTime=${endTime}&limit=1`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      captureError(new Error(`Binance klines responded ${response.status}`), { minuteBucket: minuteBucket.toISOString() });
      return null;
    }

    const rows = (await response.json()) as BinanceKline[];
    const close = rows[0]?.[4];

    return typeof close === 'string' ? close : null;
  } catch (error) {
    captureError(error, { operation: 'fetchKlineClose', minuteBucket: minuteBucket.toISOString(), failedClosed: true });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadCachedPrice(mint: string, minuteBucket: Date): Promise<string | null> {
  const rows = await getDb()
    .select({ usdPrice: tokenPrices.usdPrice })
    .from(tokenPrices)
    .where(and(eq(tokenPrices.mint, mint), eq(tokenPrices.minuteBucketUtc, minuteBucket)))
    .limit(1);

  return rows[0]?.usdPrice ?? null;
}

async function cachePrice(mint: string, minuteBucket: Date, usdPrice: string): Promise<void> {
  await getDb()
    .insert(tokenPrices)
    .values({ mint, minuteBucketUtc: minuteBucket, usdPrice, source: 'binance', fetchedAt: new Date() })
    .onConflictDoNothing();
}

/** SOL's USD price at the minute containing `occurredAt`, cached in Postgres. `null` fails closed. */
export async function getSolUsdPrice(occurredAt: Date): Promise<string | null> {
  if (!(await isFeatureEnabled(PRICING_BINANCE_FLAG))) {
    return null;
  }

  const minuteBucket = minuteBucketUtc(occurredAt);

  try {
    const cached = await loadCachedPrice(SOL_MINT, minuteBucket);

    if (cached !== null) {
      return cached;
    }

    const fetched = await fetchKlineClose(minuteBucket);

    if (fetched === null) {
      return null;
    }

    await cachePrice(SOL_MINT, minuteBucket, fetched);

    return fetched;
  } catch (error) {
    captureError(error, { operation: 'getSolUsdPrice', failedClosed: true });
    return null;
  }
}
