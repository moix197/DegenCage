import { captureError } from '../../observability/error-tracking';
import { logger } from '../../observability/logger';
import { isFeatureEnabled } from '../flags/feature-flags';
import { CHAIN_HELIUS_FLAG } from './helius-client';
import { simulateTransaction } from './helius-simulate';

/**
 * The one place a signed transaction can leave this process for the network — and the kill
 * switch that decides whether it actually does.
 *
 * The call site is identical either way: `submit-service.ts` calls
 * `broadcastSignedTransaction` once, and this module decides between *simulating* the signed
 * bytes and *sending* them based on `chain.broadcast`. That is deliberate. Phase 6's job is to
 * flip a flag row, not to edit code — a send path that only exists once someone changes an
 * `if` is a path nothing has ever exercised, which is the worst possible thing to discover
 * with real money in flight.
 *
 * Fail closed in both modes. A dry run whose simulation reports an error is a *failure*, not a
 * warning: the wallet signed something the chain would reject, and `submit-service.ts` marks
 * the intent failed rather than reporting a verified transaction. A send that does not return
 * a signature throws for the same reason.
 */

/**
 * The kill switch this whole plan is built around (decision 14). Seeded **disabled** in
 * `server/db/seed.ts`: every phase before Phase 6 exercises the full pipeline — compile, sign,
 * verify, simulate — without a single lamport moving. Off is not a degraded mode, it is the
 * designed one until a human decides otherwise.
 */
export const CHAIN_BROADCAST_FLAG = 'chain.broadcast';

export class BroadcastError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'BroadcastError';
  }
}

/**
 * Same host and key as `helius-client.ts` / `helius-simulate.ts`. Repeated rather than shared
 * because this is the *write* side of that RPC: the only function in the codebase that can
 * move funds lives in one file, behind one flag, with no shared helper that a future refactor
 * could widen. The read-side wrapper deliberately has no `sendTransaction` for the same reason.
 */
const HELIUS_RPC_BASE = 'https://mainnet.helius-rpc.com';
const REQUEST_TIMEOUT_MS = 15_000;

export interface BroadcastResult {
  /** `true` when `chain.broadcast` was off and the bytes were simulated instead of sent. */
  dryRun: boolean;
  /** The signature the network acknowledged. `null` on a dry run — nothing was sent, so nothing was acknowledged. */
  networkSignature: string | null;
  logs: string[] | null;
}

function requireApiKey(): string {
  const key = process.env.HELIUS_API_KEY;

  if (!key) {
    throw new BroadcastError('HELIUS_API_KEY is not set');
  }

  return key;
}

/**
 * The real send. `skipPreflight: false` keeps the validator's own simulation in front of the
 * broadcast, and `maxRetries: 0` keeps the RPC from rebroadcasting on our behalf — an
 * unbounded retry against an external API is exactly what CLAUDE.md forbids, and a
 * rebroadcast we did not ask for is a rebroadcast our audit trail cannot explain.
 */
async function sendToNetwork(base64WireTransaction: string, correlationId?: string): Promise<string> {
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
        method: 'sendTransaction',
        params: [base64WireTransaction, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 }],
      }),
    });

    if (!response.ok) {
      throw new BroadcastError(`Helius responded ${response.status} for sendTransaction`);
    }

    const json = (await response.json()) as { result?: string; error?: { code: number; message: string } };

    if (json.error) {
      throw new BroadcastError(`Helius RPC error ${json.error.code} for sendTransaction: ${json.error.message}`);
    }

    if (typeof json.result !== 'string') {
      throw new BroadcastError('Helius sendTransaction returned no signature');
    }

    return json.result;
  } catch (error) {
    captureError(error, { operation: 'sendTransaction', ...(correlationId !== undefined ? { correlationId } : {}), failedClosed: true });

    throw error instanceof BroadcastError ? error : new BroadcastError('helius sendTransaction request failed', error);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Verifies the signed bytes against the chain without sending them.
 *
 * `replaceRecentBlockhash` is **false** here, unlike the compute-unit measurement pass in
 * `assemble-transaction.ts`: the point of the dry run is to confirm the transaction the user
 * actually signed — including the blockhash it is bound to — still executes. Swapping in a
 * fresh blockhash would simulate a transaction that does not exist.
 */
async function simulateOnly(base64WireTransaction: string, correlationId?: string): Promise<BroadcastResult> {
  const simulation = await simulateTransaction(base64WireTransaction, { replaceRecentBlockhash: false }, correlationId);

  if (simulation.err !== null && simulation.err !== undefined) {
    throw new BroadcastError(`signed transaction failed simulation: ${JSON.stringify(simulation.err)}`);
  }

  return { dryRun: true, networkSignature: null, logs: simulation.logs };
}

/**
 * Broadcast a signed transaction — or, with `chain.broadcast` off, verify it by simulation and
 * say so.
 *
 * @param correlationId - The caller's trade-intent correlation id, carried on every log line
 *   this function emits (including the simulate/send call it makes) so the id keeps flowing
 *   UI → rule engine → Jupiter → chain (CLAUDE.md → Observability). Optional only because a
 *   handful of call sites this plan does not own yet have none to pass.
 * @throws BroadcastError when the flag is on but `chain.helius` is off (the integration this
 *   rides on is itself killed), when the simulation reports an error, or when the send fails.
 *   Never resolves permissively: `submit-service.ts` turns any throw here into a `failed`
 *   intent, and there is no outcome where an unverified transaction reads as submitted.
 */
export async function broadcastSignedTransaction(base64WireTransaction: string, correlationId?: string): Promise<BroadcastResult> {
  const broadcastEnabled = await isFeatureEnabled(CHAIN_BROADCAST_FLAG);

  if (!broadcastEnabled) {
    logger.info('broadcast disabled — simulating signed transaction instead', {
      flagKey: CHAIN_BROADCAST_FLAG,
      ...(correlationId !== undefined ? { correlationId } : {}),
    });

    return simulateOnly(base64WireTransaction, correlationId);
  }

  // The read wrapper checks this for itself; the send path has to check it explicitly, or
  // killing the Helius integration would still leave the one call that moves money running.
  if (!(await isFeatureEnabled(CHAIN_HELIUS_FLAG))) {
    throw new BroadcastError('chain.helius is disabled');
  }

  const networkSignature = await sendToNetwork(base64WireTransaction, correlationId);

  logger.info('signed transaction broadcast', { networkSignature, ...(correlationId !== undefined ? { correlationId } : {}) });

  return { dryRun: false, networkSignature, logs: null };
}
