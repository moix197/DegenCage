import type { HeliusTransaction } from './helius-client';
import { isSolOrLstMint, WSOL_MINT } from './lst-allowlist';

/**
 * Nets a transaction's `pre`/`postTokenBalances` (plus the wallet's own native-lamport
 * delta) into a candidate swap — decision 3 ("trades = DEX swaps only, from net token
 * balance deltas") and decision 5 ("one tx = one trade, valued net in→out").
 *
 * Native SOL is normalized onto the wSOL mint address throughout this module. That is what
 * makes wrap/unwrap self-cancel for free: wrapping N SOL debits native lamports by ~N and
 * credits the wSOL token account by ~N, and merging both under one map key nets them to
 * ~0 without any special-cased wrap/unwrap detection.
 *
 * Every transaction produces exactly one `DerivedSwap` — a real trade (`excludedReason:
 * null`, both legs populated) or an excluded candidate (`excludedReason` set, with whichever
 * leg — if any — `derive-swaps.ts` could actually identify). `reconcile-wallet.ts` persists
 * one either way, so excluded swaps can be listed on the status page with their reason.
 */

const NATIVE_SOL_DECIMALS = 9;
/** Comfortably above the ~0.00204 SOL ATA rent-exempt minimum, well below any real trade. */
const RENT_NOISE_LAMPORTS = 3_000_000n;

export type ExcludedReason = 'no_net_change' | 'pure_receive' | 'pure_send' | 'wrap_unwrap' | 'lst_swap' | 'missing_block_time';

export interface DerivedSwap {
  signature: string;
  slot: number;
  transactionIndex: number;
  occurredAt: Date;
  /** `null` for a real trade; set to the exclusion reason otherwise. */
  excludedReason: ExcludedReason | null;
  soldMint: string | null;
  boughtMint: string | null;
  soldAmountBaseUnits: string | null;
  boughtAmountBaseUnits: string | null;
  soldDecimals: number | null;
  boughtDecimals: number | null;
}

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/** Net per-mint balance delta for `walletAddress`, with native SOL merged onto `WSOL_MINT`. */
function computeDeltasByMint(
  tx: HeliusTransaction,
  walletAddress: string,
): { deltas: Map<string, bigint>; decimalsByMint: Map<string, number> } {
  const deltas = new Map<string, bigint>();
  const decimalsByMint = new Map<string, number>();

  for (const pre of tx.meta.preTokenBalances) {
    if (pre.owner !== walletAddress) continue;
    deltas.set(pre.mint, (deltas.get(pre.mint) ?? 0n) - BigInt(pre.uiTokenAmount.amount));
    decimalsByMint.set(pre.mint, pre.uiTokenAmount.decimals);
  }

  for (const post of tx.meta.postTokenBalances) {
    if (post.owner !== walletAddress) continue;
    deltas.set(post.mint, (deltas.get(post.mint) ?? 0n) + BigInt(post.uiTokenAmount.amount));
    decimalsByMint.set(post.mint, post.uiTokenAmount.decimals);
  }

  const accountKeys = tx.transaction.message.accountKeys;
  const walletIndex = accountKeys.indexOf(walletAddress);

  if (walletIndex !== -1) {
    const rawDelta = BigInt(tx.meta.postBalances[walletIndex] ?? 0) - BigInt(tx.meta.preBalances[walletIndex] ?? 0);
    // The fee payer's post-balance already has the fee deducted; add it back so the fee
    // itself is never counted as part of a swap's SOL leg.
    const isFeePayer = walletIndex === 0;
    const adjusted = isFeePayer ? rawDelta + BigInt(tx.meta.fee) : rawDelta;

    deltas.set(WSOL_MINT, (deltas.get(WSOL_MINT) ?? 0n) + adjusted);
    decimalsByMint.set(WSOL_MINT, NATIVE_SOL_DECIMALS);
  }

  return { deltas, decimalsByMint };
}

function pruneNoise(deltas: Map<string, bigint>): Map<string, bigint> {
  const pruned = new Map<string, bigint>();

  for (const [mint, delta] of deltas) {
    if (delta === 0n) continue;
    if (mint === WSOL_MINT && absBigInt(delta) < RENT_NOISE_LAMPORTS) continue;
    pruned.set(mint, delta);
  }

  return pruned;
}

function pickLargestMagnitude(entries: [string, bigint][]): [string, bigint] {
  return entries.reduce((largest, entry) => (absBigInt(entry[1]) > absBigInt(largest[1]) ? entry : largest));
}

function classifyDeltas(deltas: Map<string, bigint>): { sold: [string, bigint] | null; bought: [string, bigint] | null } {
  const negatives = [...deltas].filter(([, delta]) => delta < 0n);
  const positives = [...deltas].filter(([, delta]) => delta > 0n);

  return {
    sold: negatives.length > 0 ? pickLargestMagnitude(negatives) : null,
    bought: positives.length > 0 ? pickLargestMagnitude(positives) : null,
  };
}

/** Whether the wallet had any real wSOL SPL token-account entry in this tx (not just the native-lamport merge). */
function touchedWsolTokenAccount(tx: HeliusTransaction, walletAddress: string): boolean {
  return [...tx.meta.preTokenBalances, ...tx.meta.postTokenBalances].some(
    (balance) => balance.owner === walletAddress && balance.mint === WSOL_MINT,
  );
}

function excluded(
  position: Pick<DerivedSwap, 'signature' | 'slot' | 'transactionIndex' | 'occurredAt'>,
  reason: ExcludedReason,
  legs: Partial<Pick<DerivedSwap, 'soldMint' | 'boughtMint' | 'soldAmountBaseUnits' | 'boughtAmountBaseUnits' | 'soldDecimals' | 'boughtDecimals'>> = {},
): DerivedSwap {
  return {
    ...position,
    excludedReason: reason,
    soldMint: null,
    boughtMint: null,
    soldAmountBaseUnits: null,
    boughtAmountBaseUnits: null,
    soldDecimals: null,
    boughtDecimals: null,
    ...legs,
  };
}

export function deriveSwapFromTransaction(tx: HeliusTransaction, walletAddress: string): DerivedSwap {
  const position = {
    signature: tx.transaction.signatures[0] ?? '',
    slot: tx.slot,
    transactionIndex: tx.transactionIndex,
    occurredAt: tx.blockTime !== null ? new Date(tx.blockTime * 1_000) : new Date(0),
  };

  // `occurredAt` drives every time-based stat downstream — a transaction with no chain
  // timestamp cannot be honestly placed in a rolling window, so it is excluded rather than
  // defaulted to the epoch (`.ai/decisions/event-time-vs-observation-time.md`).
  if (tx.blockTime === null) {
    return excluded(position, 'missing_block_time');
  }

  const { deltas: rawDeltas, decimalsByMint } = computeDeltasByMint(tx, walletAddress);
  const deltas = pruneNoise(rawDeltas);

  if (deltas.size === 0) {
    return excluded(position, touchedWsolTokenAccount(tx, walletAddress) ? 'wrap_unwrap' : 'no_net_change');
  }

  const { sold, bought } = classifyDeltas(deltas);

  if (!sold && !bought) {
    return excluded(position, 'no_net_change');
  }

  if (!sold && bought) {
    const [boughtMint, boughtDelta] = bought;
    return excluded(position, 'pure_receive', {
      boughtMint,
      boughtAmountBaseUnits: boughtDelta.toString(),
      boughtDecimals: decimalsByMint.get(boughtMint) ?? 0,
    });
  }

  if (sold && !bought) {
    const [soldMint, soldDelta] = sold;
    return excluded(position, 'pure_send', {
      soldMint,
      soldAmountBaseUnits: (-soldDelta).toString(),
      soldDecimals: decimalsByMint.get(soldMint) ?? 0,
    });
  }

  const [soldMint, soldDelta] = sold!;
  const [boughtMint, boughtDelta] = bought!;
  const soldAmountBaseUnits = (-soldDelta).toString();
  const boughtAmountBaseUnits = boughtDelta.toString();
  const soldDecimals = decimalsByMint.get(soldMint) ?? 0;
  const boughtDecimals = decimalsByMint.get(boughtMint) ?? 0;

  if (isSolOrLstMint(soldMint) && isSolOrLstMint(boughtMint)) {
    return excluded(position, 'lst_swap', { soldMint, boughtMint, soldAmountBaseUnits, boughtAmountBaseUnits, soldDecimals, boughtDecimals });
  }

  return {
    ...position,
    excludedReason: null,
    soldMint,
    boughtMint,
    soldAmountBaseUnits,
    boughtAmountBaseUnits,
    soldDecimals,
    boughtDecimals,
  };
}
