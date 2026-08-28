import { getSolUsdPrice, SOL_MINT } from './binance-klines';
import { getBirdeyeUsdPrice } from './birdeye-price';
import { isStablecoin } from '../chain/stablecoin-mints';

/**
 * Leg-selection pricing (decision 19): price only the known SOL/stablecoin leg of a swap,
 * falling back to Birdeye long-tail pricing (Phase 5) when neither leg is SOL/stablecoin. A
 * trade priceable by none of these is `usd_value: null` — fail closed, never `$0`, never
 * silently folded into the notional sum as zero (CLAUDE.md).
 */

/**
 * Which leg denominates the result, when the caller must decide rather than let the search
 * order below decide for it. Pre-trade callers always name one (see
 * `.ai/decisions/pre-trade-slippage-pricing.md`): only the caller knows whether the limit
 * being evaluated is a ceiling (a bigger number must be *more* likely to block, so it prices
 * the sold leg, whose amount an exact-in swap fixes) or a floor (a *smaller* proceeds figure
 * is the one that blocks, so it prices the bought leg's guaranteed minimum). Omitted keeps the
 * inferred search order, which is what post-execution reconciliation wants: by then both
 * amounts are real on-chain facts, so the most liquid leg is simply the most accurate one.
 */
export type PricedLeg = 'sold' | 'bought';

export interface PriceableTrade {
  soldMint: string;
  boughtMint: string;
  soldAmountBaseUnits: string;
  boughtAmountBaseUnits: string;
  soldDecimals: number;
  boughtDecimals: number;
  occurredAt: Date;
  /** Omit to infer from liquidity (see `PricedLeg`) — every pre-trade caller must name one. */
  leg?: PricedLeg;
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
 * Prices exactly the leg the caller named, through whichever source that mint has: face value
 * for a stablecoin, Binance for SOL, Birdeye for anything else. No fallback to the *other*
 * leg — that is the point of naming one, since the other leg is the one the caller decided
 * must not be able to move the number.
 */
async function priceNamedLeg(mint: string, amountBaseUnits: string, decimals: number, occurredAt: Date): Promise<PricedTrade> {
  if (isStablecoin(mint)) {
    return { usdValue: baseUnitsToDecimalString(amountBaseUnits, decimals), priceSource: 'stablecoin' };
  }

  const isSol = mint === SOL_MINT;
  const price = isSol ? await getSolUsdPrice(occurredAt) : await getBirdeyeUsdPrice(mint, occurredAt);

  if (price === null) return { usdValue: null, priceSource: null };

  return {
    usdValue: multiplyUsd(baseUnitsToDecimalString(amountBaseUnits, decimals), price),
    priceSource: isSol ? 'binance' : 'birdeye',
  };
}

/**
 * Prices `trade`'s known leg: a stablecoin leg needs no external call; a SOL leg is priced
 * from the cached Binance klines minute bucket. Neither present (an alt↔alt swap) is
 * unresolvable in Phase 4 and returns `usdValue: null`.
 *
 * `trade.leg`, when set, overrides all of that and prices only the named leg.
 */
export async function priceTrade(trade: PriceableTrade): Promise<PricedTrade> {
  if (trade.leg === 'sold') {
    return priceNamedLeg(trade.soldMint, trade.soldAmountBaseUnits, trade.soldDecimals, trade.occurredAt);
  }

  if (trade.leg === 'bought') {
    return priceNamedLeg(trade.boughtMint, trade.boughtAmountBaseUnits, trade.boughtDecimals, trade.occurredAt);
  }

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

  // Alt<->alt: neither leg is SOL/stablecoin. Try Birdeye for each leg in turn — this is a
  // best-effort fallback, not a true liquidity comparison (a cheap batched liquidity signal
  // isn't available here), so the sold leg is tried first and the bought leg only if that
  // fails; whichever resolves first is priced and used.
  const soldPrice = await getBirdeyeUsdPrice(trade.soldMint, trade.occurredAt);

  if (soldPrice !== null) {
    return {
      usdValue: multiplyUsd(baseUnitsToDecimalString(trade.soldAmountBaseUnits, trade.soldDecimals), soldPrice),
      priceSource: 'birdeye',
    };
  }

  const boughtPrice = await getBirdeyeUsdPrice(trade.boughtMint, trade.occurredAt);

  if (boughtPrice !== null) {
    return {
      usdValue: multiplyUsd(baseUnitsToDecimalString(trade.boughtAmountBaseUnits, trade.boughtDecimals), boughtPrice),
      priceSource: 'birdeye',
    };
  }

  return { usdValue: null, priceSource: null };
}
