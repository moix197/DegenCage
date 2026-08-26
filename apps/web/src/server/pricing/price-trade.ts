import { getSolUsdPrice, SOL_MINT } from './binance-klines';

/**
 * Leg-selection pricing (decision 19): price only the known SOL/stablecoin leg of a swap.
 * A trade with neither leg priceable is `usd_value: null` — fail closed, never `$0`, never
 * silently folded into the notional sum as zero (CLAUDE.md). Long-tail alt↔alt pricing via
 * Birdeye is Phase 5, not here.
 */

/** USDC and USDT mints — priced at exactly $1 with zero external calls. */
const STABLECOIN_MINTS: ReadonlySet<string> = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

function isStablecoin(mint: string): boolean {
  return STABLECOIN_MINTS.has(mint);
}

export interface PriceableTrade {
  soldMint: string;
  boughtMint: string;
  soldAmountBaseUnits: string;
  boughtAmountBaseUnits: string;
  soldDecimals: number;
  boughtDecimals: number;
  occurredAt: Date;
}

export interface PricedTrade {
  usdValue: string | null;
  priceSource: string | null;
}

/** Exact base-units -> decimal-string conversion via digit-string manipulation — never a float. */
function baseUnitsToDecimalString(amountBaseUnits: string, decimals: number): string {
  const negative = amountBaseUnits.startsWith('-');
  const digits = negative ? amountBaseUnits.slice(1) : amountBaseUnits;
  const padded = digits.padStart(decimals + 1, '0');
  const intPart = padded.slice(0, padded.length - decimals) || '0';
  const fracPart = decimals > 0 ? padded.slice(padded.length - decimals) : '';
  const value = fracPart ? `${intPart}.${fracPart}` : intPart;

  return negative ? `-${value}` : value;
}

function splitDecimal(value: string): { intPart: string; fracPart: string } {
  const [intPart, fracPart = ''] = value.split('.');
  return { intPart: intPart || '0', fracPart };
}

/** Exact decimal-string multiplication via `BigInt` — never a float. Both inputs are non-negative here. */
function multiplyUsd(a: string, b: string): string {
  const da = splitDecimal(a);
  const db = splitDecimal(b);
  const scale = da.fracPart.length + db.fracPart.length;
  const product = (BigInt(da.intPart + da.fracPart) * BigInt(db.intPart + db.fracPart)).toString().padStart(scale + 1, '0');
  const intResult = product.slice(0, product.length - scale) || '0';
  const fracResult = scale > 0 ? product.slice(product.length - scale) : '';

  return scale > 0 ? `${intResult}.${fracResult}` : intResult;
}

/**
 * Prices `trade`'s known leg: a stablecoin leg needs no external call; a SOL leg is priced
 * from the cached Binance klines minute bucket. Neither present (an alt↔alt swap) is
 * unresolvable in Phase 4 and returns `usdValue: null`.
 */
export async function priceTrade(trade: PriceableTrade): Promise<PricedTrade> {
  if (isStablecoin(trade.soldMint)) {
    return { usdValue: baseUnitsToDecimalString(trade.soldAmountBaseUnits, trade.soldDecimals), priceSource: 'stablecoin' };
  }

  if (isStablecoin(trade.boughtMint)) {
    return { usdValue: baseUnitsToDecimalString(trade.boughtAmountBaseUnits, trade.boughtDecimals), priceSource: 'stablecoin' };
  }

  if (trade.soldMint === SOL_MINT) {
    const price = await getSolUsdPrice(trade.occurredAt);
    if (price === null) return { usdValue: null, priceSource: null };

    return {
      usdValue: multiplyUsd(baseUnitsToDecimalString(trade.soldAmountBaseUnits, trade.soldDecimals), price),
      priceSource: 'binance',
    };
  }

  if (trade.boughtMint === SOL_MINT) {
    const price = await getSolUsdPrice(trade.occurredAt);
    if (price === null) return { usdValue: null, priceSource: null };

    return {
      usdValue: multiplyUsd(baseUnitsToDecimalString(trade.boughtAmountBaseUnits, trade.boughtDecimals), price),
      priceSource: 'binance',
    };
  }

  // Alt<->alt: unresolvable until Phase 5's Birdeye fallback.
  return { usdValue: null, priceSource: null };
}
