import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ASSET_TIER_MCAP_THRESHOLDS_USD, classifyToken, classifyTokens } from './classify-token';
import { lookupTokenMcaps } from './jupiter-tokens';

const { isFeatureEnabledMock } = vi.hoisted(() => ({ isFeatureEnabledMock: vi.fn() }));

vi.mock('../flags/feature-flags', () => ({ isFeatureEnabled: isFeatureEnabledMock }));

// Wraps the *real* `lookupTokenMcaps` (and therefore the real `fetchMcaps` JSON-parsing
// guard at `jupiter-tokens.ts`) by default, so every test below exercises the genuine
// end-to-end pipeline through a mocked `fetch` rather than a fake pre-resolved map — the
// thing the previous version of this file failed to do (it mocked `lookupTokenMcaps`
// wholesale, so a `mcap: null`/absent JSON field was never actually parsed by anything).
// Individual tests may still override this per-call (`mockRejectedValueOnce`, etc.) to
// exercise `classify-token.ts`'s own defensive catch around a misbehaving client.
vi.mock('./jupiter-tokens', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./jupiter-tokens')>();
  return { ...actual, lookupTokenMcaps: vi.fn(actual.lookupTokenMcaps) };
});

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function jupiterResponse(items: Array<{ id: string } & Record<string, unknown>>): Response {
  return { ok: true, json: async () => items } as unknown as Response;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(lookupTokenMcaps).mockClear();
  isFeatureEnabledMock.mockResolvedValue(true);
});

describe('classifyToken', () => {
  it('resolves a stablecoin mint to STABLE without any external call', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const result = await classifyToken(USDC_MINT);

    expect(result).toEqual({ tier: 'STABLE', classification: 'known' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isFeatureEnabledMock).not.toHaveBeenCalled();
  });

  it('buckets LARGE_CAP at and above its threshold, MID_CAP just below it', async () => {
    const atThreshold = 'MintLargeAtThresholdAAAAAAAAAAAAAAAAAAAAAAA';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jupiterResponse([{ id: atThreshold, mcap: ASSET_TIER_MCAP_THRESHOLDS_USD.LARGE_CAP }]),
    );
    expect(await classifyToken(atThreshold)).toEqual({ tier: 'LARGE_CAP', classification: 'known' });

    const justBelow = 'MintLargeJustBelowAAAAAAAAAAAAAAAAAAAAAAAAAA';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jupiterResponse([{ id: justBelow, mcap: ASSET_TIER_MCAP_THRESHOLDS_USD.LARGE_CAP - 1 }]),
    );
    expect(await classifyToken(justBelow)).toEqual({ tier: 'MID_CAP', classification: 'known' });
  });

  it('buckets MID_CAP at and above its threshold, SMALL_CAP just below it', async () => {
    const atThreshold = 'MintMidAtThresholdAAAAAAAAAAAAAAAAAAAAAAAAAA';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jupiterResponse([{ id: atThreshold, mcap: ASSET_TIER_MCAP_THRESHOLDS_USD.MID_CAP }]),
    );
    expect(await classifyToken(atThreshold)).toEqual({ tier: 'MID_CAP', classification: 'known' });

    const justBelow = 'MintMidJustBelowAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jupiterResponse([{ id: justBelow, mcap: ASSET_TIER_MCAP_THRESHOLDS_USD.MID_CAP - 1 }]),
    );
    expect(await classifyToken(justBelow)).toEqual({ tier: 'SMALL_CAP', classification: 'known' });
  });

  it('buckets SMALL_CAP at and above its threshold, MICRO_CAP just below it', async () => {
    const atThreshold = 'MintSmallAtThresholdAAAAAAAAAAAAAAAAAAAAAAAA';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jupiterResponse([{ id: atThreshold, mcap: ASSET_TIER_MCAP_THRESHOLDS_USD.SMALL_CAP }]),
    );
    expect(await classifyToken(atThreshold)).toEqual({ tier: 'SMALL_CAP', classification: 'known' });

    // Below the SMALL_CAP threshold with a real mcap read is genuinely MICRO_CAP, and — unlike
    // the fail-closed default below — `classification: 'known'`, since Jupiter did list it.
    const justBelow = 'MintSmallJustBelowAAAAAAAAAAAAAAAAAAAAAAAAAA';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jupiterResponse([{ id: justBelow, mcap: ASSET_TIER_MCAP_THRESHOLDS_USD.SMALL_CAP - 1 }]),
    );
    expect(await classifyToken(justBelow)).toEqual({ tier: 'MICRO_CAP', classification: 'known' });
  });

  it('falls back to MICRO_CAP + unknown when Jupiter lists nothing for the mint at all', async () => {
    const mint = 'MintUnlistedAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jupiterResponse([]));

    expect(await classifyToken(mint)).toEqual({ tier: 'MICRO_CAP', classification: 'unknown' });
  });

  it('falls back to MICRO_CAP + unknown for a response element with mcap explicitly null', async () => {
    const mint = 'MintNullMcapAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    // A genuine JSON element with `mcap: null` reaches `fetchMcaps`' own
    // `typeof item.mcap === 'number'` guard (jupiter-tokens.ts) — this is the exact case the
    // previous version of this test never exercised because it mocked `lookupTokenMcaps`
    // wholesale instead of feeding it a real response.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jupiterResponse([{ id: mint, mcap: null }]));

    expect(await classifyToken(mint)).toEqual({ tier: 'MICRO_CAP', classification: 'unknown' });
  });

  it('falls back to MICRO_CAP + unknown for a response element with the mcap field entirely absent', async () => {
    const mint = 'MintAbsentMcapAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jupiterResponse([{ id: mint }]));

    expect(await classifyToken(mint)).toEqual({ tier: 'MICRO_CAP', classification: 'unknown' });
  });

  it('falls back to MICRO_CAP + unknown with zero network calls when classification.jupiter_mcap is off', async () => {
    isFeatureEnabledMock.mockResolvedValue(false);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const mint = 'MintFlagOffAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    const result = await classifyToken(mint);

    expect(result).toEqual({ tier: 'MICRO_CAP', classification: 'unknown' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed rather than throwing into the reconcile pipeline when the Jupiter client itself rejects', async () => {
    const mint = 'MintClientRejectsAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    vi.mocked(lookupTokenMcaps).mockRejectedValueOnce(new Error('jupiter unavailable'));

    await expect(classifyToken(mint)).resolves.toEqual({ tier: 'MICRO_CAP', classification: 'unknown' });
  });
});

describe('classifyTokens', () => {
  it('resolves every distinct mint, issuing one batched lookup for the non-stablecoin mints', async () => {
    const mintA = 'MintClassifyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const mintB = 'MintClassifyBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jupiterResponse([
        { id: mintA, mcap: ASSET_TIER_MCAP_THRESHOLDS_USD.LARGE_CAP },
        { id: mintB, mcap: ASSET_TIER_MCAP_THRESHOLDS_USD.SMALL_CAP },
      ]),
    );

    const result = await classifyTokens([USDC_MINT, mintA, mintB, mintA]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain(`${mintA},${mintB}`);
    expect(result.get(USDC_MINT)).toEqual({ tier: 'STABLE', classification: 'known' });
    expect(result.get(mintA)).toEqual({ tier: 'LARGE_CAP', classification: 'known' });
    expect(result.get(mintB)).toEqual({ tier: 'SMALL_CAP', classification: 'known' });
  });

  it('never calls the Jupiter lookup when every mint is a stablecoin', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await classifyTokens([USDC_MINT]);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
