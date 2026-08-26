import { randomBytes } from 'node:crypto';

import { getBase58Decoder } from '@solana/kit';
import type { SolanaSignInOutput } from '@solana/wallet-standard-features';
import { parseSignInMessage, verifySignIn } from '@solana/wallet-standard-util';
import { and, eq, isNull } from 'drizzle-orm';

import { logger } from '../../observability/logger';
import { getDb } from '../db/client';
import { siwsChallenges, type SiwsChallengeRow, type StoredSignInInput } from '../db/schema';
import { establishSession, type EstablishedSession } from './session';

/**
 * Sign In With Solana, and the three checks the library does not do.
 *
 * `verifySignIn` proves only that the signature is valid and that the signed text matches
 * the input we hand it (decision 16). It knows nothing about our challenge: whether the
 * nonce was already spent, whether it has expired, or whether the domain is ours. Those
 * three are the difference between authentication and a replay oracle, so they are
 * checked explicitly here, against our stored row, and every one of them fails closed.
 *
 * All contact with the wallet libraries is confined to this module and
 * `src/client/wallet/` so a pre-1.0 breaking release is a two-file change.
 */

/** Kill switch for the whole connect flow — seeded by `src/server/db/seed.ts`. */
export const WALLET_CONNECT_FLAG = 'auth.wallet_connect';

const CHALLENGE_TTL_MS = 5 * 60 * 1_000;
const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

const SIWS_STATEMENT =
  'Sign in to DegenCage. This proves you hold this wallet. It authorizes no transaction and moves no funds.';

/** What the wallet hands back, reduced to the three things verification actually needs. */
export interface WalletSignInProof {
  publicKey: Uint8Array;
  signedMessage: Uint8Array;
  signature: Uint8Array;
}

/** Base64 on the wire — JSON has no byte array, and a number[] triples the payload. */
export interface WalletSignInProofWire {
  publicKey: string;
  signedMessage: string;
  signature: string;
}

function decodeBase64(value: unknown): Uint8Array | null {
  return typeof value === 'string' ? new Uint8Array(Buffer.from(value, 'base64')) : null;
}

/** Shapes an untrusted request body into a proof, or `null` if it is not one. */
export function parseSignInProof(body: unknown): WalletSignInProof | null {
  const wire = body as Partial<WalletSignInProofWire> | null;
  const publicKey = decodeBase64(wire?.publicKey);
  const signedMessage = decodeBase64(wire?.signedMessage);
  const signature = decodeBase64(wire?.signature);

  if (!publicKey || !signedMessage || !signature) {
    return null;
  }

  return { publicKey, signedMessage, signature };
}

export type SignInRejection =
  | 'malformed_message'
  | 'unknown_nonce'
  | 'nonce_already_consumed'
  | 'challenge_expired'
  | 'domain_mismatch'
  | 'address_mismatch'
  | 'signature_invalid';

export type SignInCheck = { ok: true; address: string } | { ok: false; reason: SignInRejection };

/**
 * The domain is configuration, never a request header. Deriving it from `Host` or
 * `Origin` would let an attacker who can set headers bind a signature to any domain they
 * like, which defeats the point of binding it at all.
 */
export function requiredSignInDomain(): string {
  const domain = process.env.SIWS_DOMAIN;

  if (!domain) {
    throw new Error('SIWS_DOMAIN is not set. Wallet sign-in cannot be verified; see .env.example.');
  }

  return domain;
}

/** Hex, not base64url: the SIWS message grammar is line-based and wallets display it raw. */
export function buildSignInInput(now: Date, domain: string): StoredSignInInput {
  return {
    domain,
    statement: SIWS_STATEMENT,
    nonce: randomBytes(32).toString('hex'),
    issuedAt: now.toISOString(),
    expirationTime: new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString(),
  };
}

export async function issueSignInChallenge(correlationId: string): Promise<StoredSignInInput> {
  const now = new Date();
  const input = buildSignInInput(now, requiredSignInDomain());

  await getDb().insert(siwsChallenges).values({
    nonce: input.nonce,
    input,
    issuedAt: now,
    expiresAt: new Date(input.expirationTime),
  });

  logger.info('siws challenge issued', { correlationId, nonce: input.nonce });

  return input;
}

/**
 * `verifySignIn` needs a full `SolanaSignInOutput`; only `account.publicKey`,
 * `signedMessage` and `signature` are read. `account.address` is our own derivation from
 * the public key, never the caller's claim — otherwise a caller could sign with a key
 * they hold and label it with someone else's address.
 */
function asSignInOutput(address: string, proof: WalletSignInProof): SolanaSignInOutput {
  return {
    account: { address, publicKey: proof.publicKey, chains: [], features: [] },
    signedMessage: proof.signedMessage,
    signature: proof.signature,
  } as unknown as SolanaSignInOutput;
}

function hasWellFormedKeyMaterial(proof: WalletSignInProof): boolean {
  return (
    proof.publicKey.length === ED25519_PUBLIC_KEY_BYTES &&
    proof.signature.length === ED25519_SIGNATURE_BYTES
  );
}

function passesSignatureVerification(address: string, input: StoredSignInInput, proof: WalletSignInProof): boolean {
  // Hostile bytes reach the ed25519 verifier directly, so a throw is a rejection.
  try {
    return verifySignIn({ ...input, address }, asSignInOutput(address, proof));
  } catch {
    return false;
  }
}

/**
 * The whole decision, as a pure function of the stored challenge and the submitted proof.
 * Split out from the transaction below the way `resolveFeatureFlag` is split from
 * `isFeatureEnabled`: the security-critical part is then testable without a database.
 */
export function checkSignIn(
  challenge: Pick<SiwsChallengeRow, 'input' | 'consumedAt'>,
  proof: WalletSignInProof,
  now: Date,
  expectedDomain: string,
): SignInCheck {
  if (challenge.consumedAt !== null) {
    return { ok: false, reason: 'nonce_already_consumed' };
  }

  const issuedAt = Date.parse(challenge.input.issuedAt);
  const expirationTime = Date.parse(challenge.input.expirationTime);

  if (now.getTime() < issuedAt || now.getTime() > expirationTime) {
    return { ok: false, reason: 'challenge_expired' };
  }

  if (challenge.input.domain !== expectedDomain) {
    return { ok: false, reason: 'domain_mismatch' };
  }

  if (!hasWellFormedKeyMaterial(proof)) {
    return { ok: false, reason: 'signature_invalid' };
  }

  const address = getBase58Decoder().decode(proof.publicKey);

  // Named separately from `signature_invalid` because it is a different failure with a
  // different cause. `verifySignIn` folds both into one boolean, which left the only
  // symptom of "the wallet signed as a different account than the key it handed us" —
  // exactly what an account switch produces — indistinguishable in the logs from a
  // forged signature. The response stays identically opaque; only the log line differs.
  if (parseSignInMessage(proof.signedMessage)?.address !== address) {
    return { ok: false, reason: 'address_mismatch' };
  }

  return passesSignatureVerification(address, challenge.input, proof)
    ? { ok: true, address }
    : { ok: false, reason: 'signature_invalid' };
}

export class SignInRejected extends Error {
  constructor(readonly reason: SignInRejection) {
    super(`sign-in rejected: ${reason}`);
    this.name = 'SignInRejected';
  }
}

/** The nonce is only a lookup key here; nothing is trusted until `checkSignIn` passes. */
function readSubmittedNonce(proof: WalletSignInProof): string | null {
  return parseSignInMessage(proof.signedMessage)?.nonce ?? null;
}

/**
 * Verifies a sign-in and issues the session in one transaction.
 *
 * Consuming the nonce and creating the session must commit or roll back together. Split
 * across two transactions, a crash in between burns the challenge and leaves the user
 * unauthenticated with a nonce that can never be spent again.
 */
export async function verifyWalletSignIn(
  proof: WalletSignInProof,
  correlationId: string,
): Promise<EstablishedSession> {
  const nonce = readSubmittedNonce(proof);

  if (!nonce) {
    throw new SignInRejected('malformed_message');
  }

  const expectedDomain = requiredSignInDomain();

  return getDb().transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(siwsChallenges)
      .where(eq(siwsChallenges.nonce, nonce))
      .for('update')
      .limit(1);

    const challenge = rows[0];

    if (!challenge) {
      throw new SignInRejected('unknown_nonce');
    }

    const check = checkSignIn(challenge, proof, new Date(), expectedDomain);

    if (!check.ok) {
      throw new SignInRejected(check.reason);
    }

    // Belt and braces alongside the row lock: the guard is in SQL too, so two racing
    // requests cannot both see an unconsumed nonce.
    const consumed = await tx
      .update(siwsChallenges)
      .set({ consumedAt: new Date() })
      .where(and(eq(siwsChallenges.nonce, nonce), isNull(siwsChallenges.consumedAt)))
      .returning({ nonce: siwsChallenges.nonce });

    if (consumed.length !== 1) {
      throw new SignInRejected('nonce_already_consumed');
    }

    return establishSession(tx, check.address, correlationId);
  });
}
