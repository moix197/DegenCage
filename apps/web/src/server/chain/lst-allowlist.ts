/**
 * The curated SOL/liquid-staking-token mint list behind decision 8: swaps entirely within
 * this set (SOL↔LST, LST↔LST) are excluded from trade history rather than counted, because
 * they are economically a staking action, not a directional bet. Shared, not duplicated —
 * `server/chain/derive-swaps.ts` uses it for exclusion here in Phase 4; Phase 5's
 * `classify-token.ts` reuses the same set so the exclusion list and the classification list
 * can never diverge.
 *
 * Wrapped SOL is included: it is the mint address native SOL is normalized to throughout
 * this pipeline (`derive-swaps.ts`), so it must be in this set for a plain SOL↔LST swap to
 * be recognized at all.
 */

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** Curated, not exhaustive — the major liquid-staking tokens by TVL as of Phase 0. */
export const LST_MINTS: ReadonlySet<string> = new Set([
  WSOL_MINT,
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL (Marinade)
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // jitoSOL (Jito)
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', // bSOL (BlazeStake)
  '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', // stSOL (Lido)
  'Jupi75mSAcm5DxCzBBdVL3E5W7VuY5aUp6Kbg1EFYuq', // JupSOL (Jupiter)
  '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm', // INF (Sanctum infinity LST)
]);

export function isSolOrLstMint(mint: string): boolean {
  return LST_MINTS.has(mint);
}
