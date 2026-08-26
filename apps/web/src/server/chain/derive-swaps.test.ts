import { describe, expect, it } from 'vitest';

import { deriveSwapFromTransaction } from './derive-swaps';
import type { HeliusTransaction, HeliusTokenBalance } from './helius-client';
import { WSOL_MINT } from './lst-allowlist';

const WALLET = 'WaLLeT1111111111111111111111111111111111111';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const MSOL_MINT = 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So';

const BLOCK_TIME = 1_787_781_679;

function tokenBalance(overrides: Partial<HeliusTokenBalance> & { mint: string; amount: string; decimals: number }): HeliusTokenBalance {
  return {
    accountIndex: overrides.accountIndex ?? 1,
    mint: overrides.mint,
    owner: overrides.owner ?? WALLET,
    uiTokenAmount: { amount: overrides.amount, decimals: overrides.decimals },
  };
}

interface TxOptions {
  /** Whether `WALLET` (always `accountKeys[0]`) paid this transaction's fee. */
  isFeePayer?: boolean;
  fee?: number;
  preLamports?: number;
  postLamports?: number;
  preTokenBalances?: HeliusTokenBalance[];
  postTokenBalances?: HeliusTokenBalance[];
  blockTime?: number | null;
}

function tx({
  isFeePayer = true,
  fee = 5_000,
  preLamports = 10_000_000_000,
  postLamports,
  preTokenBalances = [],
  postTokenBalances = [],
  blockTime = BLOCK_TIME,
}: TxOptions): HeliusTransaction {
  const accountKeys = [WALLET, 'Other1111111111111111111111111111111111111'];
  // Default: the wallet is the fee payer and nothing else touches its native balance, so
  // after `derive-swaps.ts` adds the fee back the net SOL delta lands on exactly 0.
  const resolvedPostLamports = postLamports ?? preLamports - (isFeePayer ? fee : 0);

  return {
    slot: 441_960_734,
    transactionIndex: 12,
    blockTime,
    transaction: { signatures: ['sig-' + Math.random().toString(36).slice(2)], message: { accountKeys } },
    meta: {
      fee,
      preBalances: [preLamports, 0],
      postBalances: [resolvedPostLamports, 0],
      preTokenBalances,
      postTokenBalances,
    },
  };
}

describe('deriveSwapFromTransaction', () => {
  it('derives a swap from a simple net token-balance delta (sell USDC, buy BONK)', () => {
    const result = deriveSwapFromTransaction(
      tx({
        preTokenBalances: [tokenBalance({ mint: USDC_MINT, amount: '1000000000', decimals: 6 })],
        postTokenBalances: [tokenBalance({ mint: BONK_MINT, amount: '500000000000', decimals: 5 })],
      }),
      WALLET,
    );

    expect(result.excludedReason).toBeNull();
    expect(result.soldMint).toBe(USDC_MINT);
    expect(result.boughtMint).toBe(BONK_MINT);
    expect(result.soldAmountBaseUnits).toBe('1000000000');
    expect(result.boughtAmountBaseUnits).toBe('500000000000');
    expect(result.soldDecimals).toBe(6);
    expect(result.boughtDecimals).toBe(5);
    expect(result.occurredAt).toEqual(new Date(BLOCK_TIME * 1_000));
  });

  it('collapses a multi-hop route into one net trade (decision 5)', () => {
    // Routed A -> USDC (intermediate hop) -> BONK: USDC nets to ~0 across the whole tx.
    const result = deriveSwapFromTransaction(
      tx({
        preTokenBalances: [
          tokenBalance({ mint: USDC_MINT, amount: '0', decimals: 6, accountIndex: 1 }),
          tokenBalance({ mint: 'ALT1111111111111111111111111111111111111', amount: '2000000', decimals: 6, accountIndex: 2 }),
        ],
        postTokenBalances: [
          tokenBalance({ mint: USDC_MINT, amount: '0', decimals: 6, accountIndex: 1 }),
          tokenBalance({ mint: 'ALT1111111111111111111111111111111111111', amount: '0', decimals: 6, accountIndex: 2 }),
          tokenBalance({ mint: BONK_MINT, amount: '9000000000', decimals: 5, accountIndex: 3 }),
        ],
      }),
      WALLET,
    );

    expect(result.excludedReason).toBeNull();
    expect(result.soldMint).toBe('ALT1111111111111111111111111111111111111');
    expect(result.boughtMint).toBe(BONK_MINT);
  });

  it('excludes a pure receive — no negative leg at all', () => {
    const result = deriveSwapFromTransaction(
      tx({
        isFeePayer: false,
        postTokenBalances: [tokenBalance({ mint: BONK_MINT, amount: '1000000000', decimals: 5 })],
      }),
      WALLET,
    );

    expect(result.excludedReason).toBe('pure_receive');
  });

  it('excludes a pure send — no positive leg at all', () => {
    const result = deriveSwapFromTransaction(
      tx({
        preTokenBalances: [tokenBalance({ mint: BONK_MINT, amount: '1000000000', decimals: 5 })],
        postTokenBalances: [tokenBalance({ mint: BONK_MINT, amount: '0', decimals: 5 })],
      }),
      WALLET,
    );

    expect(result.excludedReason).toBe('pure_send');
  });

  it('excludes a self-transfer that nets to zero across the wallet\'s own accounts', () => {
    const result = deriveSwapFromTransaction(
      tx({
        preTokenBalances: [tokenBalance({ mint: BONK_MINT, amount: '1000000000', decimals: 5, accountIndex: 1 })],
        postTokenBalances: [
          tokenBalance({ mint: BONK_MINT, amount: '0', decimals: 5, accountIndex: 1 }),
          tokenBalance({ mint: BONK_MINT, amount: '1000000000', decimals: 5, accountIndex: 2 }),
        ],
      }),
      WALLET,
    );

    expect(result.excludedReason).toBe('no_net_change');
  });

  it('excludes a SOL <-> wSOL wrap, tagging it distinctly from generic noise', () => {
    const wrapped = 5_000_000_000; // 5 SOL
    const rent = 2_039_280; // ATA rent-exempt minimum
    const result = deriveSwapFromTransaction(
      tx({
        preLamports: 10_000_000_000,
        postLamports: 10_000_000_000 - wrapped - rent - 5_000,
        postTokenBalances: [tokenBalance({ mint: WSOL_MINT, amount: String(wrapped), decimals: 9 })],
      }),
      WALLET,
    );

    expect(result.excludedReason).toBe('wrap_unwrap');
  });

  it('excludes rent-only noise (no wSOL touched) as no_net_change, not a phantom trade', () => {
    const rent = 2_039_280;
    const result = deriveSwapFromTransaction(
      tx({ preLamports: 10_000_000_000, postLamports: 10_000_000_000 - rent - 5_000 }),
      WALLET,
    );

    expect(result.excludedReason).toBe('no_net_change');
  });

  it('excludes a SOL <-> LST swap via the curated allowlist (decision 8)', () => {
    const result = deriveSwapFromTransaction(
      tx({
        preLamports: 10_000_000_000,
        postLamports: 5_000_000_000 - 5_000,
        postTokenBalances: [tokenBalance({ mint: MSOL_MINT, amount: '4800000000', decimals: 9 })],
      }),
      WALLET,
    );

    expect(result.excludedReason).toBe('lst_swap');
  });

  it('excludes an LST <-> LST swap too', () => {
    const result = deriveSwapFromTransaction(
      tx({
        preTokenBalances: [tokenBalance({ mint: MSOL_MINT, amount: '1000000000', decimals: 9 })],
        postTokenBalances: [tokenBalance({ mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', amount: '980000000', decimals: 9 })],
      }),
      WALLET,
    );

    expect(result.excludedReason).toBe('lst_swap');
  });

  it('still derives a real, small SOL-leg swap above the rent-noise threshold', () => {
    const solSpent = 100_000_000; // 0.1 SOL — comfortably above the rent-noise floor
    const result = deriveSwapFromTransaction(
      tx({
        preLamports: 10_000_000_000,
        postLamports: 10_000_000_000 - solSpent - 5_000,
        postTokenBalances: [tokenBalance({ mint: BONK_MINT, amount: '20000000000', decimals: 5 })],
      }),
      WALLET,
    );

    expect(result.excludedReason).toBeNull();
    expect(result.soldMint).toBe(WSOL_MINT);
    expect(result.soldAmountBaseUnits).toBe(String(solSpent));
    expect(result.boughtMint).toBe(BONK_MINT);
  });

  it('excludes a transaction with no block time rather than defaulting its occurredAt', () => {
    const result = deriveSwapFromTransaction(tx({ blockTime: null }), WALLET);

    expect(result.excludedReason).toBe('missing_block_time');
  });
});
