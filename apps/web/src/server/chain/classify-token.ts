import type { AssetTier } from '@degencage/rules';

import { captureError } from '../../observability/error-tracking';
import { logger } from '../../observability/logger';
import { isStablecoin } from './stablecoin-mints';
import { lookupTokenMcaps } from './jupiter-tokens';

/**
 * Buckets a mint into a market-cap `AssetTier` (Phase 5 — supersedes decision 7's
 * identity-based tiers). `STABLE` is decided from the curated set with zero external calls;
 * everything else is decided from Jupiter Tokens v2's `mcap` field
 * (`jupiter-tokens.ts`), comma-batched once per reconcile batch via `classifyTokens`.
 *
 * Fail-closed default doubles as the kill-switch fallback: an unlisted mint, a missing/null
 * `mcap`, or the `classification.jupiter_mcap` flag being off all bucket `MICRO_CAP` with
 * `classification: 'unknown'` — this function never throws into the reconcile pipeline
 * (`reconcile-wallet.ts` calls it unconditionally for every real trade).
 */

/**
 * Named and exported so the boundaries are tunable without touching the bucketing logic
 * itself. Boundaries are inclusive on their lower bound (`mcap >= threshold`).
 */
export const ASSET_TIER_MCAP_THRESHOLDS_USD = {
  LARGE_CAP: 1_000_000_000,
  MID_CAP: 100_000_000,
  SMALL_CAP: 10_000_000,
} as const;

export interface TokenClassification {
  tier: AssetTier;
  /** `unknown` whenever the tier was assigned by the fail-closed default rather than a real mcap read. */
  classification: 'known' | 'unknown';
}

const MICRO_CAP_UNKNOWN: TokenClassification = { tier: 'MICRO_CAP', classification: 'unknown' };

function tierFromMcap(mcap: number): AssetTier {
  if (mcap >= ASSET_TIER_MCAP_THRESHOLDS_USD.LARGE_CAP) return 'LARGE_CAP';
  if (mcap >= ASSET_TIER_MCAP_THRESHOLDS_USD.MID_CAP) return 'MID_CAP';
  if (mcap >= ASSET_TIER_MCAP_THRESHOLDS_USD.SMALL_CAP) return 'SMALL_CAP';
  return 'MICRO_CAP';
}

/**
 * Classifies every distinct mint in `mints` in one pass, issuing at most one batched Jupiter
 * request (via `lookupTokenMcaps`) for whichever mints aren't stablecoins. Returns an entry
 * for every mint given — never throws, so a caller can await it unconditionally.
 */
export async function classifyTokens(mints: string[]): Promise<Map<string, TokenClassification>> {
  const result = new Map<string, TokenClassification>();
  const distinctMints = [...new Set(mints)];
  const toLookup: string[] = [];

  for (const mint of distinctMints) {
    if (isStablecoin(mint)) {
      result.set(mint, { tier: 'STABLE', classification: 'known' });
    } else {
      toLookup.push(mint);
    }
  }

  if (toLookup.length > 0) {
    // `lookupTokenMcaps` already fails closed internally, but this call is defended again
    // here so a client bug or a mocked/unexpected rejection can never throw into the
    // reconcile pipeline (`reconcile-wallet.ts` awaits this unconditionally for every trade).
    let mcaps: Map<string, number>;

    try {
      mcaps = await lookupTokenMcaps(toLookup);
    } catch (error) {
      captureError(error, { operation: 'classifyTokens', mintCount: toLookup.length, failedClosed: true });
      mcaps = new Map();
    }

    for (const mint of toLookup) {
      const mcap = mcaps.get(mint);
      result.set(mint, mcap === undefined ? MICRO_CAP_UNKNOWN : { tier: tierFromMcap(mcap), classification: 'known' });
    }
  }

  logger.debug('tokens classified', {
    mintCount: distinctMints.length,
    tiers: [...result.entries()].map(([mint, { tier, classification }]) => ({ mint, tier, classification })),
  });

  return result;
}

/** Convenience single-mint form of `classifyTokens`, for callers classifying one mint at a time. */
export async function classifyToken(mint: string): Promise<TokenClassification> {
  const result = await classifyTokens([mint]);
  return result.get(mint) ?? MICRO_CAP_UNKNOWN;
}
