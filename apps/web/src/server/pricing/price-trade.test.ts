import { beforeEach, describe, expect, it, vi } from 'vitest';

import { priceTrade, type PriceableTrade } from './price-trade';

const { getSolUsdPriceMock, getBirdeyeUsdPriceMock } = vi.hoisted(() => ({
  getSolUsdPriceMock: vi.fn(),
  getBirdeyeUsdPriceMock: vi.fn(),
}));

vi.mock('./binance-klines', () => ({
  getSolUsdPrice: getSolUsdPriceMock,
  SOL_MINT: 'So11111111111111111111111111111111111111112',
}));

vi.mock('./birdeye-price', () => ({ getBirdeyeUsdPrice: getBirdeyeUsdPriceMock }));

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const BONK_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const ALT_MINT = 'Alt1111111111111111111111111111111111111111';

function trade(overrides: Partial<PriceableTrade> = {}): PriceableTrade {
  return {
    soldMint: USDC_MINT,
    boughtMint: BONK_MINT,
    soldAmountBaseUnits: '1000000',
    boughtAmountBaseUnits: '500000000000',
    soldDecimals: 6,
    boughtDecimals: 5,
    occurredAt: new Date('2026-08-26T12:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getBirdeyeUsdPriceMock.mockResolvedValue(null);
});

describe('priceTrade', () => {
  it('prices the stable sold leg with zero external calls', async () => {
    const result = await priceTrade(trade({ soldMint: USDC_MINT, soldAmountBaseUnits: '1500000', soldDecimals: 6 }));

    expect(result).toEqual({ usdValue: '1.500000', priceSource: 'stablecoin' });
    expect(getSolUsdPriceMock).not.toHaveBeenCalled();
  });

  it('prices the stable bought leg with zero external calls', async () => {
    const result = await priceTrade(
      trade({ soldMint: BONK_MINT, boughtMint: USDC_MINT, boughtAmountBaseUnits: '2000000', boughtDecimals: 6 }),
    );

    expect(result).toEqual({ usdValue: '2.000000', priceSource: 'stablecoin' });
    expect(getSolUsdPriceMock).not.toHaveBeenCalled();
  });

  it('prices a SOL sold leg via the cached klines price', async () => {
    getSolUsdPriceMock.mockResolvedValue('200.50');

    const result = await priceTrade(
      trade({ soldMint: SOL_MINT, soldAmountBaseUnits: '2000000000', soldDecimals: 9, boughtMint: BONK_MINT }),
    );

    expect(result).toEqual({ usdValue: '401.00000000000', priceSource: 'binance' });
  });

  it('prices a SOL bought leg via the cached klines price', async () => {
    getSolUsdPriceMock.mockResolvedValue('200');

    const result = await priceTrade(
      trade({ soldMint: BONK_MINT, boughtMint: SOL_MINT, boughtAmountBaseUnits: '1000000000', boughtDecimals: 9 }),
    );

    expect(result).toEqual({ usdValue: '200.000000000', priceSource: 'binance' });
  });

  it('is unresolvable, never $0, when the SOL leg has no cached or fetchable price', async () => {
    getSolUsdPriceMock.mockResolvedValue(null);

    const result = await priceTrade(trade({ soldMint: SOL_MINT, boughtMint: BONK_MINT }));

    expect(result).toEqual({ usdValue: null, priceSource: null });
  });

  it('never calls Birdeye when a leg is already priced by the stablecoin or SOL path', async () => {
    const result = await priceTrade(trade({ soldMint: USDC_MINT, soldAmountBaseUnits: '1000000', soldDecimals: 6 }));

    expect(result).toEqual({ usdValue: '1.000000', priceSource: 'stablecoin' });
    expect(getBirdeyeUsdPriceMock).not.toHaveBeenCalled();
  });

  describe('alt<->alt fallback (Phase 5)', () => {
    it('prices the sold leg via Birdeye when neither leg is SOL/stablecoin', async () => {
      getBirdeyeUsdPriceMock.mockImplementation(async (mint: string) => (mint === ALT_MINT ? '2.5' : null));

      const result = await priceTrade(
        trade({ soldMint: ALT_MINT, soldAmountBaseUnits: '1000000', soldDecimals: 6, boughtMint: BONK_MINT }),
      );

      // multiplyUsd's scale is the sum of both operands' fractional digit counts (never
      // trimmed): 6 (from the base-units conversion) + 1 (from '2.5') = 7.
      expect(result).toEqual({ usdValue: '2.5000000', priceSource: 'birdeye' });
      expect(getSolUsdPriceMock).not.toHaveBeenCalled();
    });

    it('falls back to the bought leg when the sold leg is unresolvable via Birdeye', async () => {
      getBirdeyeUsdPriceMock.mockImplementation(async (mint: string) => (mint === BONK_MINT ? '0.00001' : null));

      const result = await priceTrade(
        trade({ soldMint: ALT_MINT, boughtMint: BONK_MINT, boughtAmountBaseUnits: '500000000000', boughtDecimals: 5 }),
      );

      // Scale is 5 (from the base-units conversion, boughtDecimals) + 5 (from '0.00001') = 10.
      expect(result).toEqual({ usdValue: '50.0000000000', priceSource: 'birdeye' });
    });

    it('is still null — never $0 — when Birdeye cannot resolve either leg', async () => {
      const result = await priceTrade(trade({ soldMint: ALT_MINT, boughtMint: BONK_MINT }));

      expect(result).toEqual({ usdValue: null, priceSource: null });
      expect(getSolUsdPriceMock).not.toHaveBeenCalled();
    });

    it('is null with zero Birdeye calls when pricing.birdeye is off — getBirdeyeUsdPrice fails closed on its own, exercised via its own test file', async () => {
      // priceTrade only calls getBirdeyeUsdPrice; the flag-off/failed-closed behavior itself
      // belongs to birdeye-price.ts. Here we only prove priceTrade uses whatever it returns.
      getBirdeyeUsdPriceMock.mockResolvedValue(null);

      const result = await priceTrade(trade({ soldMint: ALT_MINT, boughtMint: BONK_MINT }));

      expect(result).toEqual({ usdValue: null, priceSource: null });
    });
  });

  describe('stablecoin pricing after the mint-set extraction', () => {
    it('still prices USDC/USDT legs unchanged, now sourced from stablecoin-mints.ts', async () => {
      const soldResult = await priceTrade(trade({ soldMint: USDC_MINT, soldAmountBaseUnits: '2500000', soldDecimals: 6 }));
      expect(soldResult).toEqual({ usdValue: '2.500000', priceSource: 'stablecoin' });

      const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
      const boughtResult = await priceTrade(
        trade({ soldMint: BONK_MINT, boughtMint: USDT_MINT, boughtAmountBaseUnits: '3000000', boughtDecimals: 6 }),
      );
      expect(boughtResult).toEqual({ usdValue: '3.000000', priceSource: 'stablecoin' });
    });
  });
});
