import { captureError } from '../../observability/error-tracking';
import { isFeatureEnabled } from '../flags/feature-flags';
import { CHAIN_HELIUS_FLAG } from './helius-client';

/**
 * The read-side Helius JSON-RPC calls the pre-trade path needs, alongside
 * `helius-client.ts`'s `getTransactionsForAddress`: `simulateTransaction` (compute-unit
 * measurement, and Phase 3's dry-run verification) and `getMultipleAccounts` (resolving the
 * address lookup tables `/build` routes through).
 *
 * Same integration, same kill switch (`CHAIN_HELIUS_FLAG`) — not a new one — and the same
 * fail-closed contract: a disabled flag, a missing key, a timeout, a non-200 or an RPC-level
 * error all throw. `assemble-transaction.ts` turns any of those into a blocked quote; none of
 * them may fall through to a guessed compute-unit limit or a partially-resolved lookup table.
 */

/** Same host and key as `helius-client.ts`; that module keeps its own copy private, so this is the RPC config repeated rather than a second endpoint. */
const HELIUS_RPC_BASE = 'https://mainnet.helius-rpc.com';
const REQUEST_TIMEOUT_MS = 15_000;

export class HeliusRpcError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'HeliusRpcError';
  }
}

function requireApiKey(): string {
  const key = process.env.HELIUS_API_KEY;

  if (!key) {
    throw new HeliusRpcError('HELIUS_API_KEY is not set');
  }

  return key;
}

interface HeliusRpcEnvelope<TResult> {
  result?: TResult;
  error?: { code: number; message: string };
}

/**
 * One JSON-RPC round trip. Flag-gated and timeout-bounded, with no retries — every caller
 * here runs inside a user-facing quote request, where a retry only turns a slow block into a
 * slower one.
 *
 * @param correlationId - The caller's trade-intent correlation id, carried on a captured
 *   failure so this integration boundary does not break the UI → rule engine → Jupiter → chain
 *   chain (CLAUDE.md → Observability). Optional only because a handful of call sites this plan
 *   does not own yet have none to pass.
 */
async function heliusRpc<TResult>(method: string, params: unknown[], correlationId?: string): Promise<TResult> {
  if (!(await isFeatureEnabled(CHAIN_HELIUS_FLAG))) {
    throw new HeliusRpcError('chain.helius is disabled');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${HELIUS_RPC_BASE}/?api-key=${requireApiKey()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });

    if (!response.ok) {
      throw new HeliusRpcError(`Helius responded ${response.status} for ${method}`);
    }

    const json = (await response.json()) as HeliusRpcEnvelope<TResult>;

    if (json.error) {
      throw new HeliusRpcError(`Helius RPC error ${json.error.code} for ${method}: ${json.error.message}`);
    }

    if (json.result === undefined) {
      throw new HeliusRpcError(`Helius response for ${method} had no result`);
    }

    return json.result;
  } catch (error) {
    captureError(error, { operation: 'heliusRpc', method, ...(correlationId !== undefined ? { correlationId } : {}), failedClosed: true });

    throw error instanceof HeliusRpcError ? error : new HeliusRpcError(`helius ${method} request failed`, error);
  } finally {
    clearTimeout(timeout);
  }
}

export interface SimulationResult {
  /** Non-null means the simulated transaction itself failed on chain — a block, never a warning. */
  err: unknown;
  /** Compute units the simulation actually consumed; `null` when Helius did not report any. */
  unitsConsumed: number | null;
  logs: string[] | null;
}

export interface SimulateTransactionOptions {
  /**
   * Swaps in a blockhash the validator knows is current before simulating. Required for the
   * compute-unit measurement pass, where the blockhash `/build` returned may already be too
   * old for the simulating node — the *real* message is always built with `/build`'s own
   * blockhash instead (`assemble-transaction.ts`).
   */
  replaceRecentBlockhash?: boolean;
}

/**
 * Simulates an unsigned, base64-encoded wire transaction. `sigVerify` is never set: the
 * message has no signature yet at quote time, which is the whole point of simulating here.
 */
export async function simulateTransaction(
  base64WireTransaction: string,
  { replaceRecentBlockhash = true }: SimulateTransactionOptions = {},
  correlationId?: string,
): Promise<SimulationResult> {
  const result = await heliusRpc<{ value: { err: unknown; unitsConsumed?: number | null; logs?: string[] | null } }>(
    'simulateTransaction',
    [base64WireTransaction, { encoding: 'base64', commitment: 'confirmed', sigVerify: false, replaceRecentBlockhash }],
    correlationId,
  );

  return {
    err: result.value.err,
    unitsConsumed: typeof result.value.unitsConsumed === 'number' ? result.value.unitsConsumed : null,
    logs: result.value.logs ?? null,
  };
}

export interface HeliusAccount {
  /** `[base64Data, 'base64']`, per the JSON-RPC encoding we request. */
  data: [string, string];
  owner: string;
}

/**
 * Reads `addresses` in one round trip. A `null` entry means the account does not exist —
 * returned as-is so the caller can decide (for a lookup table, that is a hard block).
 */
export async function getMultipleAccounts(addresses: string[], correlationId?: string): Promise<(HeliusAccount | null)[]> {
  const result = await heliusRpc<{ value: (HeliusAccount | null)[] }>(
    'getMultipleAccounts',
    [addresses, { encoding: 'base64', commitment: 'confirmed' }],
    correlationId,
  );

  return result.value;
}
