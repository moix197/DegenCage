import { getBase58Decoder, getBase58Encoder } from '@solana/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assembleSwapTransaction,
  AssembleTransactionError,
  computeUnitLimitFrom,
  decodeBlockhash,
  MAX_COMPUTE_UNIT_LIMIT,
  parseLookupTableAddresses,
  passthroughComputeBudgetInstructions,
  resolveLookupTables,
  setComputeUnitLimitInstruction,
  swapInstructions,
} from './assemble-transaction';
import type { JupiterBuildResponse, JupiterInstruction } from './jupiter-client';

/**
 * The three failure modes this module exists to prevent are all silent at build time:
 * a blockhash left as raw bytes, a compute-unit limit guessed instead of measured, and the
 * simulation's *replaced* blockhash leaking into the message the user signs. Each gets its
 * own case below, plus the fail-closed paths around lookup-table resolution.
 */

const { getMultipleAccountsMock, simulateTransactionMock } = vi.hoisted(() => ({
  getMultipleAccountsMock: vi.fn(),
  simulateTransactionMock: vi.fn(),
}));

vi.mock('../chain/helius-simulate', () => ({
  getMultipleAccounts: getMultipleAccountsMock,
  simulateTransaction: simulateTransactionMock,
}));

const TAKER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const JUPITER_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const LOOKUP_TABLE = 'AddressLookupTab1e1111111111111111111111111';
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
const RENT_SYSVAR = 'SysvarRent111111111111111111111111111111111';
/** A real mainnet blockhash string; `/build` hands the same value back as raw bytes. */
const BLOCKHASH = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';

function instruction(programId: string, pubkeys: string[]): JupiterInstruction {
  return {
    programId,
    accounts: pubkeys.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    data: Buffer.from([1, 2, 3]).toString('base64'),
  };
}

function blockhashBytes(base58: string): number[] {
  return Array.from(getBase58Encoder().encode(base58));
}

/** 56 bytes of metadata header, then one 32-byte address per entry — the on-chain layout. */
function lookupTableAccountData(addresses: string[]): { data: [string, string]; owner: string } {
  const body = Buffer.concat(addresses.map((entry) => Buffer.from(getBase58Encoder().encode(entry))));

  return { data: [Buffer.concat([Buffer.alloc(56), body]).toString('base64'), 'base64'], owner: LOOKUP_TABLE };
}

function buildResponse(overrides: Partial<JupiterBuildResponse> = {}): JupiterBuildResponse {
  return {
    inputMint: SOL,
    outputMint: USDC,
    inAmount: '100000000',
    outAmount: '20000000',
    otherAmountThreshold: '19900000',
    swapMode: 'ExactIn',
    slippageBps: 50,
    priceImpactPct: '0.001',
    routePlan: [],
    computeBudgetInstructions: [instruction('ComputeBudget111111111111111111111111111111', [])],
    setupInstructions: [instruction(TOKEN_PROGRAM, [TAKER])],
    swapInstruction: instruction(JUPITER_PROGRAM, [TAKER, SOL, USDC]),
    cleanupInstruction: instruction(TOKEN_PROGRAM, [TAKER, SOL]),
    otherInstructions: [instruction(TOKEN_PROGRAM, [RENT_SYSVAR])],
    tipInstruction: null,
    addressesByLookupTableAddress: null,
    blockhashWithMetadata: { blockhash: blockhashBytes(BLOCKHASH), lastValidBlockHeight: 300_000_000 },
    ...overrides,
  };
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) continue outer;
    }
    return true;
  }

  return false;
}

beforeEach(() => {
  vi.clearAllMocks();
  getMultipleAccountsMock.mockResolvedValue([]);
  simulateTransactionMock.mockResolvedValue({ err: null, unitsConsumed: 100_000, logs: null });
});

describe('computeUnitLimitFrom', () => {
  it('applies Jupiter’s documented 1.2x buffer, rounded up', () => {
    expect(computeUnitLimitFrom(100_000)).toBe(120_000);
    expect(computeUnitLimitFrom(1)).toBe(2);
  });

  it('caps at the network maximum rather than requesting more than a block allows', () => {
    expect(computeUnitLimitFrom(1_300_000)).toBe(MAX_COMPUTE_UNIT_LIMIT);
    expect(computeUnitLimitFrom(MAX_COMPUTE_UNIT_LIMIT)).toBe(MAX_COMPUTE_UNIT_LIMIT);
  });
});

describe('decodeBlockhash', () => {
  it('base58-encodes the raw byte array /build returns, round-tripping the original hash', () => {
    expect(decodeBlockhash(blockhashBytes(BLOCKHASH))).toBe(BLOCKHASH);
  });
});

describe('swapInstructions', () => {
  it('orders setup, swap, cleanup, other, then tip — and never the compute-budget instructions', () => {
    const build = buildResponse({ tipInstruction: instruction('11111111111111111111111111111111', [TAKER]) });

    const programs = swapInstructions(build).map((entry) => entry.programAddress);

    expect(programs).toEqual([TOKEN_PROGRAM, JUPITER_PROGRAM, TOKEN_PROGRAM, TOKEN_PROGRAM, '11111111111111111111111111111111']);
  });

  it('omits a null cleanup and a null tip instead of emitting a placeholder', () => {
    expect(swapInstructions(buildResponse({ cleanupInstruction: null })).length).toBe(3);
  });
});

describe('passthroughComputeBudgetInstructions', () => {
  it('drops a CU limit Jupiter returned — ours is measured, and two of them is DuplicateInstruction', () => {
    const build = buildResponse({
      computeBudgetInstructions: [
        { programId: COMPUTE_BUDGET_PROGRAM, accounts: [], data: Buffer.from(setComputeUnitLimitInstruction(900_000).data as Uint8Array).toString('base64') },
        // Discriminator 3: `SetComputeUnitPrice`, which is Jupiter's to decide and is kept.
        { programId: COMPUTE_BUDGET_PROGRAM, accounts: [], data: Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0]).toString('base64') },
      ],
    });

    const passed = passthroughComputeBudgetInstructions(build);

    expect(passed).toHaveLength(1);
    expect(passed[0]!.data![0]).toBe(3);
  });

  it('keeps every compute-budget instruction when none of them is a limit', () => {
    expect(passthroughComputeBudgetInstructions(buildResponse())).toHaveLength(1);
  });

  it('emits exactly one SetComputeUnitLimit into the signed message', async () => {
    simulateTransactionMock.mockResolvedValue({ err: null, unitsConsumed: 250_000, logs: null });
    const build = buildResponse({
      computeBudgetInstructions: [
        { programId: COMPUTE_BUDGET_PROGRAM, accounts: [], data: Buffer.from(setComputeUnitLimitInstruction(900_000).data as Uint8Array).toString('base64') },
      ],
    });

    const assembled = await assembleSwapTransaction(build, TAKER);
    const messageBytes = new Uint8Array(Buffer.from(assembled.messageBase64, 'base64'));

    expect(containsBytes(messageBytes, setComputeUnitLimitInstruction(300_000).data as Uint8Array)).toBe(true);
    expect(containsBytes(messageBytes, setComputeUnitLimitInstruction(900_000).data as Uint8Array)).toBe(false);
  });
});

describe('parseLookupTableAddresses', () => {
  it('reads addresses from after the fixed 56-byte metadata header', () => {
    const account = lookupTableAccountData([SOL, USDC]);

    expect(parseLookupTableAddresses(account.data[0])).toEqual([SOL, USDC]);
  });

  it('throws rather than truncating when the account data is not a whole number of addresses', () => {
    const malformed = Buffer.concat([Buffer.alloc(56), Buffer.alloc(17)]).toString('base64');

    expect(() => parseLookupTableAddresses(malformed)).toThrow(AssembleTransactionError);
  });
});

describe('resolveLookupTables', () => {
  it('makes no RPC call when the quote routes through no lookup table', async () => {
    await expect(resolveLookupTables(null)).resolves.toEqual({});
    expect(getMultipleAccountsMock).not.toHaveBeenCalled();
  });

  it('reads the table contents from chain rather than trusting the addresses /build supplied', async () => {
    getMultipleAccountsMock.mockResolvedValue([lookupTableAccountData([SOL, USDC])]);

    const resolved = await resolveLookupTables({ [LOOKUP_TABLE]: [RENT_SYSVAR] });

    expect(getMultipleAccountsMock).toHaveBeenCalledWith([LOOKUP_TABLE]);
    expect(resolved[LOOKUP_TABLE as keyof typeof resolved]).toEqual([SOL, USDC]);
  });

  it('throws when the RPC is unavailable (flag off, timeout) instead of compiling without the table', async () => {
    getMultipleAccountsMock.mockRejectedValue(new Error('chain.helius is disabled'));

    await expect(resolveLookupTables({ [LOOKUP_TABLE]: [] })).rejects.toThrow(/chain.helius is disabled/);
  });

  it('throws when a referenced lookup table does not exist on chain', async () => {
    getMultipleAccountsMock.mockResolvedValue([null]);

    await expect(resolveLookupTables({ [LOOKUP_TABLE]: [] })).rejects.toThrow(AssembleTransactionError);
  });
});

describe('assembleSwapTransaction', () => {
  it('measures compute units with replaceRecentBlockhash and the maximum limit', async () => {
    await assembleSwapTransaction(buildResponse(), TAKER);

    expect(simulateTransactionMock).toHaveBeenCalledTimes(1);
    expect(simulateTransactionMock.mock.calls[0]![1]).toEqual({ replaceRecentBlockhash: true });
  });

  it('applies the measured limit, not a guess, to the message the user will sign', async () => {
    simulateTransactionMock.mockResolvedValue({ err: null, unitsConsumed: 250_000, logs: null });

    const assembled = await assembleSwapTransaction(buildResponse(), TAKER);
    const messageBytes = new Uint8Array(Buffer.from(assembled.messageBase64, 'base64'));

    expect(assembled.computeUnitLimit).toBe(300_000);
    expect(containsBytes(messageBytes, setComputeUnitLimitInstruction(300_000).data as Uint8Array)).toBe(true);
    expect(containsBytes(messageBytes, setComputeUnitLimitInstruction(MAX_COMPUTE_UNIT_LIMIT).data as Uint8Array)).toBe(false);
  });

  it('blocks — never falls back to a default limit — when the simulation reports an error', async () => {
    simulateTransactionMock.mockResolvedValue({ err: { InstructionError: [0, 'Custom'] }, unitsConsumed: 100_000, logs: null });

    await expect(assembleSwapTransaction(buildResponse(), TAKER)).rejects.toThrow(AssembleTransactionError);
  });

  it('blocks when the simulation reports no unitsConsumed at all', async () => {
    simulateTransactionMock.mockResolvedValue({ err: null, unitsConsumed: null, logs: null });

    await expect(assembleSwapTransaction(buildResponse(), TAKER)).rejects.toThrow(/unitsConsumed/);
  });

  it('blocks when the compute-unit simulation itself is unavailable', async () => {
    simulateTransactionMock.mockRejectedValue(new Error('chain.helius is disabled'));

    await expect(assembleSwapTransaction(buildResponse(), TAKER)).rejects.toThrow(/chain.helius is disabled/);
  });

  it('compiles the final message with /build’s own blockhash, not the one simulation replaced', async () => {
    const assembled = await assembleSwapTransaction(buildResponse(), TAKER);
    const messageBytes = new Uint8Array(Buffer.from(assembled.messageBase64, 'base64'));
    const expected = new Uint8Array(getBase58Encoder().encode(BLOCKHASH));

    expect(assembled.blockhash).toBe(BLOCKHASH);
    expect(containsBytes(messageBytes, expected)).toBe(true);
  });

  it('hashes the compiled message bytes, so the same quote hashes identically and a changed one does not', async () => {
    const first = await assembleSwapTransaction(buildResponse(), TAKER);
    const second = await assembleSwapTransaction(buildResponse(), TAKER);
    simulateTransactionMock.mockResolvedValue({ err: null, unitsConsumed: 400_000, logs: null });
    const different = await assembleSwapTransaction(buildResponse(), TAKER);

    expect(first.txMessageHash).toBe(second.txMessageHash);
    expect(first.txMessageHash).not.toBe(different.txMessageHash);
    expect(first.txMessageHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('compresses the message against the chain-resolved lookup table', async () => {
    const tableAddresses = [RENT_SYSVAR, TOKEN_PROGRAM];
    getMultipleAccountsMock.mockResolvedValue([lookupTableAccountData(tableAddresses)]);

    const assembled = await assembleSwapTransaction(buildResponse({ addressesByLookupTableAddress: { [LOOKUP_TABLE]: tableAddresses } }), TAKER);
    const messageBytes = new Uint8Array(Buffer.from(assembled.messageBase64, 'base64'));

    // The table's own address is now in the message (as a lookup), while an address it covers
    // is no longer carried inline.
    expect(containsBytes(messageBytes, new Uint8Array(getBase58Encoder().encode(LOOKUP_TABLE)))).toBe(true);
    expect(containsBytes(messageBytes, new Uint8Array(getBase58Encoder().encode(RENT_SYSVAR)))).toBe(false);
    expect(getBase58Decoder().decode(new Uint8Array(getBase58Encoder().encode(LOOKUP_TABLE)))).toBe(LOOKUP_TABLE);
  });
});
