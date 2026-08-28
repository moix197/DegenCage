import { createHash } from 'node:crypto';

import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getBase58Decoder,
  getBase64Codec,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type AddressesByLookupTableAddress,
  type Blockhash,
  type Instruction,
} from '@solana/kit';

import { getMultipleAccounts, simulateTransaction } from '../chain/helius-simulate';
import type { JupiterBuildResponse, JupiterInstruction } from './jupiter-client';

/**
 * Turns a Jupiter `/build` response into the exact unsigned v0 transaction message the user's
 * wallet will be asked to sign, following Jupiter's own documented assembly pattern — with
 * three details that are load-bearing rather than stylistic, because each one fails silently
 * at build time and only surfaces as a mysterious simulate/send failure later:
 *
 *  1. `blockhashWithMetadata.blockhash` arrives as raw bytes (`number[]`), not a base58
 *     string. Embedding it un-encoded produces a garbage blockhash with no error.
 *  2. `/build` never returns a compute-unit *limit* (only a CU price), so the limit must be
 *     measured by simulating a throwaway message with the 1,400,000 maximum and taking
 *     `unitsConsumed * 1.2`. A failed simulation **blocks the quote** — there is no
 *     fall-through to a guessed default, because a wrong CU limit is a failed on-chain swap
 *     that still costs fees.
 *  3. The measuring pass uses `replaceRecentBlockhash: true` (the simulating node may already
 *     be past `/build`'s blockhash); the message the user actually signs must carry
 *     `/build`'s **own** blockhash, never the replaced one, or `expires_at` describes a
 *     lifetime the transaction does not have.
 *
 * The hash returned is over the serialized compiled **message**, before any signature exists.
 * Phase 3's submit path re-derives it by stripping the wallet's signature off the signed bytes
 * and hashing what is left — hashing a whole signed transaction would never match, since
 * signature bytes vary per signer.
 */

export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;
/** Jupiter's documented headroom over measured consumption. */
export const COMPUTE_UNIT_BUFFER = 1.2;

const COMPUTE_BUDGET_PROGRAM = address('ComputeBudget111111111111111111111111111111');
/** `SetComputeUnitLimit` — instruction discriminator 2, then a little-endian `u32`. */
const SET_COMPUTE_UNIT_LIMIT_DISCRIMINATOR = 0x02;

/**
 * Bytes of an address-lookup-table account before its address list starts: a `u32`
 * discriminator, two `u64` slots, a `u8` start index, an optional 32-byte authority, and
 * trailing padding. Fixed by the on-chain program's layout.
 */
const LOOKUP_TABLE_META_SIZE = 56;
const PUBKEY_BYTES = 32;

export class AssembleTransactionError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AssembleTransactionError';
  }
}

function accountRole(account: { isSigner: boolean; isWritable: boolean }): AccountRole {
  if (account.isSigner) {
    return account.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER;
  }

  return account.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY;
}

/** One `/build` instruction (base64 data, `pubkey`/`isSigner`/`isWritable` accounts) in `@solana/kit`'s shape. */
export function toInstruction(instruction: JupiterInstruction): Instruction {
  return {
    programAddress: address(instruction.programId),
    accounts: instruction.accounts.map((account) => ({ address: address(account.pubkey), role: accountRole(account) })),
    data: Uint8Array.from(getBase64Codec().encode(instruction.data)),
  };
}

export function setComputeUnitLimitInstruction(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = SET_COMPUTE_UNIT_LIMIT_DISCRIMINATOR;
  new DataView(data.buffer).setUint32(1, units, true);

  return { programAddress: COMPUTE_BUDGET_PROGRAM, accounts: [], data };
}

/** `unitsConsumed * 1.2`, rounded up, capped at the network maximum. */
export function computeUnitLimitFrom(unitsConsumed: number): number {
  return Math.min(Math.ceil(unitsConsumed * COMPUTE_UNIT_BUFFER), MAX_COMPUTE_UNIT_LIMIT);
}

/** `/build` hands the blockhash back as raw bytes; every consumer of it wants base58. */
export function decodeBlockhash(blockhashBytes: number[]): Blockhash {
  return getBase58Decoder().decode(Uint8Array.from(blockhashBytes)) as Blockhash;
}

/** The addresses a lookup-table account holds, in index order — everything after the fixed metadata header. */
export function parseLookupTableAddresses(accountDataBase64: string): Address[] {
  const data = Uint8Array.from(getBase64Codec().encode(accountDataBase64));

  if (data.length < LOOKUP_TABLE_META_SIZE || (data.length - LOOKUP_TABLE_META_SIZE) % PUBKEY_BYTES !== 0) {
    throw new AssembleTransactionError(`address lookup table account data is not a whole number of addresses (${data.length} bytes)`);
  }

  const addresses: Address[] = [];

  for (let offset = LOOKUP_TABLE_META_SIZE; offset < data.length; offset += PUBKEY_BYTES) {
    addresses.push(address(getBase58Decoder().decode(data.subarray(offset, offset + PUBKEY_BYTES))));
  }

  return addresses;
}

/**
 * Reads every lookup table `/build` routed through from chain, via our own Helius RPC.
 *
 * The table *contents* are deliberately re-read rather than trusted from
 * `addressesByLookupTableAddress`: a lookup table is what decides which real accounts each
 * compressed index resolves to on chain, so taking Jupiter's word for it would let a wrong (or
 * tampered) map compile a message that touches accounts nobody reviewed. Only the set of table
 * *addresses* comes from the response.
 *
 * Fails closed on every path — flag off, timeout, RPC error, a table that does not exist, or
 * data that does not parse all throw, and the quote is blocked.
 */
export async function resolveLookupTables(
  addressesByLookupTableAddress: Record<string, string[]> | null,
): Promise<AddressesByLookupTableAddress> {
  const tableAddresses = Object.keys(addressesByLookupTableAddress ?? {});

  if (tableAddresses.length === 0) {
    return {};
  }

  const accounts = await getMultipleAccounts(tableAddresses);
  const resolved: AddressesByLookupTableAddress = {};

  tableAddresses.forEach((tableAddress, index) => {
    const account = accounts[index];

    if (!account) {
      throw new AssembleTransactionError(`address lookup table ${tableAddress} does not exist on chain`);
    }

    resolved[address(tableAddress)] = parseLookupTableAddresses(account.data[0]);
  });

  return resolved;
}

/**
 * Everything the swap needs *except* the compute-unit budget, in Jupiter's documented order:
 * setup (ATA creation), the swap itself, cleanup, anything else, then the optional tip.
 */
export function swapInstructions(build: JupiterBuildResponse): Instruction[] {
  return [
    ...build.setupInstructions.map(toInstruction),
    toInstruction(build.swapInstruction),
    ...(build.cleanupInstruction ? [toInstruction(build.cleanupInstruction)] : []),
    ...build.otherInstructions.map(toInstruction),
    ...(build.tipInstruction ? [toInstruction(build.tipInstruction)] : []),
  ];
}

/**
 * Setting the fee payer before lookup-table compression buys no protection, despite reading
 * like it should: kit's compressor exempts an account by signer role alone (`isSignerRole`)
 * and never looks at the message's `feePayer`. The taker survives compression only because it
 * signs every swap instruction. The order is kept because it follows the message's dependency
 * order, not because it guarantees anything.
 */
function compileV0Message(
  instructions: Instruction[],
  feePayer: Address,
  blockhash: Blockhash,
  lastValidBlockHeight: bigint,
  lookupTables: AddressesByLookupTableAddress,
) {
  return pipe(
    createTransactionMessage({ version: 0 }),
    (message) => appendTransactionMessageInstructions(instructions, message),
    (message) => setTransactionMessageFeePayer(feePayer, message),
    (message) => compressTransactionMessageUsingAddressLookupTables(message, lookupTables),
    (message) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, message),
    (message) => compileTransaction(message),
  );
}

/**
 * Pass 1: measure. A throwaway message carrying the maximum CU limit is simulated purely to
 * read `unitsConsumed`; its blockhash is replaced by the node and is never reused.
 */
async function measureComputeUnits(
  instructions: Instruction[],
  feePayer: Address,
  blockhash: Blockhash,
  lastValidBlockHeight: bigint,
  lookupTables: AddressesByLookupTableAddress,
): Promise<number> {
  const probe = compileV0Message(
    [setComputeUnitLimitInstruction(MAX_COMPUTE_UNIT_LIMIT), ...instructions],
    feePayer,
    blockhash,
    lastValidBlockHeight,
    lookupTables,
  );

  const simulation = await simulateTransaction(getBase64EncodedWireTransaction(probe), { replaceRecentBlockhash: true });

  if (simulation.err !== null && simulation.err !== undefined) {
    throw new AssembleTransactionError(`swap simulation failed: ${JSON.stringify(simulation.err)}`);
  }

  if (simulation.unitsConsumed === null) {
    throw new AssembleTransactionError('swap simulation reported no unitsConsumed');
  }

  return simulation.unitsConsumed;
}

/**
 * Jupiter's own compute-budget instructions, minus any `SetComputeUnitLimit`. The limit is
 * ours to set — measured by simulation, not guessed — and a message carrying two of them is
 * rejected on chain as `DuplicateInstruction`, which would fail the swap after the user
 * signed it. Everything else `/build` returns there (the CU *price*, discriminator 3) is
 * passed through untouched.
 */
export function passthroughComputeBudgetInstructions(build: JupiterBuildResponse): Instruction[] {
  return build.computeBudgetInstructions
    .map(toInstruction)
    .filter((instruction) => instruction.data?.[0] !== SET_COMPUTE_UNIT_LIMIT_DISCRIMINATOR);
}

export interface AssembledTransaction {
  /** The compiled message bytes, base64 — what the wallet is handed to sign in Phase 3. */
  messageBase64: string;
  /** SHA-256 of those bytes, hex. Submit re-derives this from the signed bytes with the signature stripped. */
  txMessageHash: string;
  computeUnitLimit: number;
  blockhash: string;
  lastValidBlockHeight: number;
}

/**
 * Resolves lookup tables, measures compute units, then compiles the real message the user will
 * sign — in that order, because the measurement pass cannot use the final CU limit and the
 * final message must not use the measurement pass's replaced blockhash.
 *
 * Every failure throws. Nothing here degrades to a partially-assembled or best-effort
 * transaction: `quote-service.ts` only ever calls this for a trade the rules already allowed,
 * and a throw there blocks the quote outright.
 */
export async function assembleSwapTransaction(build: JupiterBuildResponse, taker: string): Promise<AssembledTransaction> {
  const feePayer = address(taker);
  const blockhash = decodeBlockhash(build.blockhashWithMetadata.blockhash);
  const lastValidBlockHeight = BigInt(build.blockhashWithMetadata.lastValidBlockHeight);
  const lookupTables = await resolveLookupTables(build.addressesByLookupTableAddress);
  const instructions = swapInstructions(build);

  const unitsConsumed = await measureComputeUnits(instructions, feePayer, blockhash, lastValidBlockHeight, lookupTables);
  const computeUnitLimit = computeUnitLimitFrom(unitsConsumed);

  const compiled = compileV0Message(
    [setComputeUnitLimitInstruction(computeUnitLimit), ...passthroughComputeBudgetInstructions(build), ...instructions],
    feePayer,
    blockhash,
    lastValidBlockHeight,
    lookupTables,
  );

  const messageBytes = Buffer.from(compiled.messageBytes);

  return {
    messageBase64: messageBytes.toString('base64'),
    txMessageHash: createHash('sha256').update(messageBytes).digest('hex'),
    computeUnitLimit,
    blockhash,
    lastValidBlockHeight: build.blockhashWithMetadata.lastValidBlockHeight,
  };
}
