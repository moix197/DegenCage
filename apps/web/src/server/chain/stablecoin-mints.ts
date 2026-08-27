/**
 * The curated USD-stablecoin mint set — extracted from `pricing/price-trade.ts` (Phase 4) so
 * pricing and classification (`classify-token.ts`) share exactly one list and can never
 * diverge. Same pattern as `lst-allowlist.ts`: one curated, shared set, read by two
 * independent phases.
 */

export const STABLECOIN_MINTS: ReadonlySet<string> = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

export function isStablecoin(mint: string): boolean {
  return STABLECOIN_MINTS.has(mint);
}
