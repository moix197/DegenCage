import { beforeEach, describe, expect, it, vi } from 'vitest';

import { priceTrade, type PriceableTrade } from './price-trade';

const { getSolUsdPriceMock } = vi.hoisted(() => ({ getSolUsdPriceMock: vi.fn() }));

vi.mock('./binance-klines', () => ({
  getSolUsdPrice: getSolUsdPriceMock,
  SOL_MINT: 'So11111111111111111111111111111111111111112',
}));

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

  it('is unresolvable for an alt<->alt swap in Phase 4 — no Birdeye fallback yet', async () => {
    const result = await priceTrade(trade({ soldMint: ALT_MINT, boughtMint: BONK_MINT }));

    expect(result).toEqual({ usdValue: null, priceSource: null });
    expect(getSolUsdPriceMock).not.toHaveBeenCalled();
  });
});
