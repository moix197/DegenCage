import { captureError } from '../../observability/error-tracking';
import { logger } from '../../observability/logger';
import { isFeatureEnabled } from '../flags/feature-flags';

/**
 * Thin wrapper around Helius' `getTransactionsForAddress` JSON-RPC method (decision 18),
 * verified live against the free-tier key on 2026-08-26 before any of this pipeline was
 * written — see the Phase 4 plan's Verification-first step. Confirmed on that call: HTTP
 * 200, a populated `result.data` array, and each transaction's `meta.preTokenBalances` /
 * `meta.postTokenBalances` present with the documented shape.
 *
 * Behind its own kill switch (`CHAIN_HELIUS_FLAG`) and fails closed: a disabled flag or any
 * request error throws rather than returning an empty transaction list, which would read as
 * "wallet has no trades" instead of "we could not check" (CLAUDE.md → fail closed).
 */

export const CHAIN_HELIUS_FLAG = 'chain.helius';

export interface HeliusTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

export interface HeliusTransactionMeta {
  fee: number;
  preBalances: number[];
  postBalances: number[];
  preTokenBalances: HeliusTokenBalance[];
  postTokenBalances: HeliusTokenBalance[];
}

export interface HeliusTransaction {
  slot: number;
  transactionIndex: number;
  blockTime: number | null;
  transaction: { signatures: string[]; message: { accountKeys: string[] } };
  meta: HeliusTransactionMeta;
}

export class HeliusClientError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'HeliusClientError';
  }
}

const HELIUS_RPC_BASE = 'https://mainnet.helius-rpc.com';
const REQUEST_TIMEOUT_MS = 15_000;
/** Safety bound on how many Helius response pages one call will follow — no unbounded loop against an external API (CLAUDE.md). */
const MAX_PAGES = 50;
const PAGE_LIMIT = 100;

function requireApiKey(): string {
  const key = process.env.HELIUS_API_KEY;

  if (!key) {
    throw new HeliusClientError('HELIUS_API_KEY is not set');
  }

  return key;
}

interface HeliusRpcResponse {
  result?: { data: HeliusTransaction[]; paginationToken: string | null };
  error?: { code: number; message: string };
}

/**
 * Which range of history to pull: `minSlot` for incremental reconciliation (resuming from
 * the wallet's `reconciled_through_slot` cursor), or `sinceUnixSeconds` for the 90-day
 * baseline backfill on first connect (decision 9) — Helius has no slot cursor to resume
 * from on a wallet that has never been reconciled, only a point in time.
 */
export interface TransactionsForAddressFilter {
  minSlot?: number;
  sinceUnixSeconds?: number;
}

async function fetchOnePage(
  address: string,
  filter: TransactionsForAddressFilter,
  paginationToken: string | undefined,
): Promise<{ data: HeliusTransaction[]; paginationToken: string | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${HELIUS_RPC_BASE}/?api-key=${requireApiKey()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransactionsForAddress',
        params: [
          address,
          {
            transactionDetails: 'full',
            sortOrder: 'asc',
            limit: PAGE_LIMIT,
            commitment: 'finalized',
            maxSupportedTransactionVersion: 0,
            ...(paginationToken ? { paginationToken } : {}),
            filters: {
              tokenAccounts: 'balanceChanged',
              ...(filter.minSlot !== undefined ? { slot: { gte: filter.minSlot } } : {}),
              ...(filter.sinceUnixSeconds !== undefined ? { blockTime: { gte: filter.sinceUnixSeconds } } : {}),
            },
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new HeliusClientError(`Helius responded ${response.status}`);
    }

    const json = (await response.json()) as HeliusRpcResponse;

    if (json.error) {
      throw new HeliusClientError(`Helius RPC error ${json.error.code}: ${json.error.message}`);
    }

    if (!json.result) {
      throw new HeliusClientError('Helius response had no result');
    }

    return json.result;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetches every transaction for `address` matching `filter` (inclusive lower bound),
 * following `paginationToken` until Helius reports no more or `MAX_PAGES` is reached.
 *
 * Fails closed: gated by `isFeatureEnabled(CHAIN_HELIUS_FLAG)`, and any request error
 * throws `HeliusClientError` rather than resolving to an empty/partial list silently.
 */
export async function getTransactionsForAddress(
  address: string,
  filter: TransactionsForAddressFilter = {},
): Promise<HeliusTransaction[]> {
  if (!(await isFeatureEnabled(CHAIN_HELIUS_FLAG))) {
    throw new HeliusClientError('chain.helius is disabled');
  }

  const collected: HeliusTransaction[] = [];
  let paginationToken: string | undefined;

  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await fetchOnePage(address, filter, paginationToken);
      collected.push(...result.data);

      if (!result.paginationToken) {
        return collected;
      }

      paginationToken = result.paginationToken;
    }

    logger.warn('helius pagination hit MAX_PAGES — history may be truncated', { address, maxPages: MAX_PAGES });

    return collected;
  } catch (error) {
    captureError(error, { operation: 'getTransactionsForAddress', address, failedClosed: true });

    throw error instanceof HeliusClientError ? error : new HeliusClientError('helius request failed', error);
  }
}
