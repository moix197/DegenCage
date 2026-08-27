import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getBirdeyeUsdPrice } from './birdeye-price';
import { priceTrade, type PriceableTrade } from './price-trade';

const { isFeatureEnabledMock, captureErrorMock } = vi.hoisted(() => ({
  isFeatureEnabledMock: vi.fn(),
  captureErrorMock: vi.fn(),
}));

vi.mock('../flags/feature-flags', () => ({ isFeatureEnabled: isFeatureEnabledMock }));
vi.mock('../../observability/error-tracking', () => ({ captureError: captureErrorMock }));

const MINT = 'MintBirdeyeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER_MINT = 'MintBirdeyeOtherAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function birdeyeResponse(value: unknown): Response {
  return { ok: true, json: async () => ({ data: { value } }) } as unknown as Response;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubEnv('BIRDEYE_API_KEY', 'test-birdeye-key');
  isFeatureEnabledMock.mockResolvedValue(true);
});

describe('getBirdeyeUsdPrice', () => {
  it('returns fixed-notation decimal strings for sub-1e-6 prices — never exponential notation', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(birdeyeResponse(1.2345e-7));

    const result = await getBirdeyeUsdPrice(MINT, new Date('2026-08-26T12:00:00Z'));

    expect(result).toBe('0.00000012345');
    expect(result).not.toMatch(/e/i);
  });

  it('handles a bare (mantissa-only) sub-1e-6 exponential value', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(birdeyeResponse(5e-7));

    const result = await getBirdeyeUsdPrice(MINT, new Date());

    expect(result).toBe('0.0000005');
  });

  it('rejects NaN explicitly, resolving null rather than throwing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(birdeyeResponse(Number.NaN));

    await expect(getBirdeyeUsdPrice(MINT, new Date())).resolves.toBeNull();
  });

  it('rejects Infinity explicitly, resolving null rather than throwing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(birdeyeResponse(Number.POSITIVE_INFINITY));

    await expect(getBirdeyeUsdPrice(MINT, new Date())).resolves.toBeNull();
  });

  it('is null with zero network calls when pricing.birdeye is off', async () => {
    isFeatureEnabledMock.mockResolvedValue(false);
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const result = await getBirdeyeUsdPrice(MINT, new Date());

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is null, not a throw, on a non-200 response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 500 } as unknown as Response);

    const result = await getBirdeyeUsdPrice(MINT, new Date());

    expect(result).toBeNull();
    expect(captureErrorMock).toHaveBeenCalled();
  });

  it('is null, not a throw, when the request itself throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    const result = await getBirdeyeUsdPrice(MINT, new Date());

    expect(result).toBeNull();
    expect(captureErrorMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ failedClosed: true }));
  });
});

describe('priceTrade alt<->alt fallback — sub-1e-6 round trip (regression)', () => {
  it('round-trips a sub-1e-6 Birdeye price through priceTrade without throwing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(birdeyeResponse(1.2345e-7));

    const trade: PriceableTrade = {
      soldMint: MINT,
      boughtMint: OTHER_MINT,
      soldAmountBaseUnits: '1000000000',
      boughtAmountBaseUnits: '500000',
      soldDecimals: 6,
      boughtDecimals: 5,
      occurredAt: new Date('2026-08-26T12:00:00Z'),
    };

    const result = await priceTrade(trade);

    expect(result.priceSource).toBe('birdeye');
    expect(result.usdValue).not.toBeNull();
    expect(result.usdValue).not.toMatch(/e/i);
  });
});
