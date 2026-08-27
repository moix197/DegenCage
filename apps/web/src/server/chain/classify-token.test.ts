import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ASSET_TIER_MCAP_THRESHOLDS_USD, classifyToken, classifyTokens } from './classify-token';

const { lookupTokenMcapsMock } = vi.hoisted(() => ({ lookupTokenMcapsMock: vi.fn() }));

vi.mock('./jupiter-tokens', () => ({ lookupTokenMcaps: lookupTokenMcapsMock }));

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MEMECOIN_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

beforeEach(() => {
  vi.clearAllMocks();
  lookupTokenMcapsMock.mockResolvedValue(new Map());
});

describe('classifyToken', () => {
  it('resolves a stablecoin mint to STABLE without any external call', async () => {
    const result = await classifyToken(USDC_MINT);

    expect(result).toEqual({ tier: 'STABLE', classification: 'known' });
    expect(lookupTokenMcapsMock).not.toHaveBeenCalled();
  });

  it('buckets LARGE_CAP at and above its threshold, MID_CAP just below it', async () => {
    lookupTokenMcapsMock.mockResolvedValueOnce(new Map([[MEMECOIN_MINT, ASSET_TIER_MCAP_THRESHOLDS_USD.LARGE_CAP]]));
    expect(await classifyToken(MEMECOIN_MINT)).toEqual({ tier: 'LARGE_CAP', classification: 'known' });

    lookupTokenMcapsMock.mockResolvedValueOnce(new Map([[MEMECOIN_MINT, ASSET_TIER_MCAP_THRESHOLDS_USD.LARGE_CAP - 1]]));
    expect(await classifyToken(MEMECOIN_MINT)).toEqual({ tier: 'MID_CAP', classification: 'known' });
  });

  it('buckets MID_CAP at and above its threshold, SMALL_CAP just below it', async () => {
    lookupTokenMcapsMock.mockResolvedValueOnce(new Map([[MEMECOIN_MINT, ASSET_TIER_MCAP_THRESHOLDS_USD.MID_CAP]]));
    expect(await classifyToken(MEMECOIN_MINT)).toEqual({ tier: 'MID_CAP', classification: 'known' });

    lookupTokenMcapsMock.mockResolvedValueOnce(new Map([[MEMECOIN_MINT, ASSET_TIER_MCAP_THRESHOLDS_USD.MID_CAP - 1]]));
    expect(await classifyToken(MEMECOIN_MINT)).toEqual({ tier: 'SMALL_CAP', classification: 'known' });
  });

  it('buckets SMALL_CAP at and above its threshold, MICRO_CAP just below it', async () => {
    lookupTokenMcapsMock.mockResolvedValueOnce(new Map([[MEMECOIN_MINT, ASSET_TIER_MCAP_THRESHOLDS_USD.SMALL_CAP]]));
    expect(await classifyToken(MEMECOIN_MINT)).toEqual({ tier: 'SMALL_CAP', classification: 'known' });

    lookupTokenMcapsMock.mockResolvedValueOnce(new Map([[MEMECOIN_MINT, ASSET_TIER_MCAP_THRESHOLDS_USD.SMALL_CAP - 1]]));
    expect(await classifyToken(MEMECOIN_MINT)).toEqual({ tier: 'MICRO_CAP', classification: 'known' });
  });

  it('falls back to MICRO_CAP + unknown for an unlisted mint', async () => {
    lookupTokenMcapsMock.mockResolvedValueOnce(new Map());

    expect(await classifyToken(MEMECOIN_MINT)).toEqual({ tier: 'MICRO_CAP', classification: 'unknown' });
  });

  it('falls back to MICRO_CAP + unknown when the mcap lookup has no entry for the mint (missing/null mcap)', async () => {
    // `lookupTokenMcaps` never returns a `null` value — a missing/null mcap and an unlisted
    // mint are the same "no entry" signal from that module, which is exactly what this
    // asserts the fail-closed default treats identically.
    lookupTokenMcapsMock.mockResolvedValueOnce(new Map());

    expect(await classifyToken(MEMECOIN_MINT)).toEqual({ tier: 'MICRO_CAP', classification: 'unknown' });
  });

  it('falls back to MICRO_CAP + unknown with zero network calls when the kill switch is off — expressed here as lookupTokenMcaps returning empty', async () => {
    lookupTokenMcapsMock.mockResolvedValueOnce(new Map());

    const result = await classifyToken(MEMECOIN_MINT);

    expect(result).toEqual({ tier: 'MICRO_CAP', classification: 'unknown' });
    expect(lookupTokenMcapsMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed rather than throwing into the reconcile pipeline when the Jupiter client rejects', async () => {
    lookupTokenMcapsMock.mockRejectedValueOnce(new Error('jupiter unavailable'));

    await expect(classifyToken(MEMECOIN_MINT)).resolves.toEqual({ tier: 'MICRO_CAP', classification: 'unknown' });
  });
});

describe('classifyTokens', () => {
  it('resolves every distinct mint, issuing one batched lookup for the non-stablecoin mints', async () => {
    const mintA = 'MintClassifyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const mintB = 'MintClassifyBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    lookupTokenMcapsMock.mockResolvedValueOnce(
      new Map([
        [mintA, ASSET_TIER_MCAP_THRESHOLDS_USD.LARGE_CAP],
        [mintB, ASSET_TIER_MCAP_THRESHOLDS_USD.SMALL_CAP],
      ]),
    );

    const result = await classifyTokens([USDC_MINT, mintA, mintB, mintA]);

    expect(lookupTokenMcapsMock).toHaveBeenCalledTimes(1);
    expect(lookupTokenMcapsMock).toHaveBeenCalledWith([mintA, mintB]);
    expect(result.get(USDC_MINT)).toEqual({ tier: 'STABLE', classification: 'known' });
    expect(result.get(mintA)).toEqual({ tier: 'LARGE_CAP', classification: 'known' });
    expect(result.get(mintB)).toEqual({ tier: 'SMALL_CAP', classification: 'known' });
  });

  it('never calls the Jupiter lookup when every mint is a stablecoin', async () => {
    await classifyTokens([USDC_MINT]);

    expect(lookupTokenMcapsMock).not.toHaveBeenCalled();
  });
});
