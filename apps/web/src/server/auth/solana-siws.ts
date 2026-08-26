import { randomBytes } from 'node:crypto';

import { getBase58Decoder } from '@solana/kit';
import type { SolanaSignInOutput } from '@solana/wallet-standard-features';
import { parseSignInMessage, verifySignIn } from '@solana/wallet-standard-util';
import { and, eq, isNull } from 'drizzle-orm';

import { captureError } from '../../observability/error-tracking';
import { recordEvent } from '../../observability/events';
import { logger } from '../../observability/logger';
import { getDb } from '../db/client';
import { siwsChallenges, type SiwsChallengeRow, type StoredSignInInput } from '../db/schema';
import { assertWithinChallengeRateLimit } from './challenge-rate-limit';
import { reapExpiredChallenges } from './challenge-reaper';
import {
  establishSession,
  supersedePreviousSession,
  type EstablishedSession,
  type SessionIdentity,
} from './session';

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
  | 'malformed_proof'
  | 'malformed_message'
  | 'unknown_nonce'
  | 'nonce_already_consumed'
  | 'challenge_expired'
  | 'domain_mismatch'
  | 'address_mismatch'
  | 'signature_invalid';

export type SignInCheck = { ok: true; address: string } | { ok: false; reason: SignInRejection };

/**
 * The rejections that were reached by evaluating a challenge we actually issued.
 *
 * Reaching a stored challenge is *not* on its own a bound, and an earlier version of this
 * comment claimed it was. `verify` is unauthenticated and has no throttle of its own;
 * `challenge-rate-limit` caps issuance on `/api/auth/nonce`, not verification. One nonce
 * can therefore be resubmitted forever, every replay landing on `nonce_already_consumed`,
 * so "one event per call that got past the lookup" is still a table an anonymous caller
 * grows without limit.
 *
 * What bounds it is one event per *challenge row*, claimed in SQL by
 * `claimRejectionEventSlot` — rows being the thing the issuance limit does cap. The set
 * below is then the set of reasons that have a row to hang that claim on; the excluded
 * three — a body that is not a proof, a message that is not SIWS, and a nonce we never
 * issued — have none, are free to generate, and stop at the log.
 */
const REJECTIONS_AGAINST_A_STORED_CHALLENGE: ReadonlySet<SignInRejection> = new Set([
  'nonce_already_consumed',
  'challenge_expired',
  'domain_mismatch',
  'address_mismatch',
  'signature_invalid',
] satisfies SignInRejection[]);

/** Whether this rejection belongs in the event log, per the rule above. */
function isRejectionOfAStoredChallenge(reason: SignInRejection): boolean {
  return REJECTIONS_AGAINST_A_STORED_CHALLENGE.has(reason);
}

/**
 * Takes the single rejection-event slot a challenge has, atomically.
 *
 * Same shape as the nonce consume below — `UPDATE ... WHERE <column> IS NULL ... RETURNING`
 * — and for the same reason: the database, not this process, decides which of N concurrent
 * replays of one nonce is the first, so N replays produce one event rather than N.
 *
 * Runs on the pooled client and never inside the sign-in transaction: that transaction has
 * already rolled back by the time a rejection is recorded, which would take the claim with
 * it and hand the replay its slot straight back.
 *
 * @returns Whether this caller is the one that may write the event.
 */
async function claimRejectionEventSlot(nonce: string, now: Date): Promise<boolean> {
  const claimed = await getDb()
    .update(siwsChallenges)
    .set({ rejectionRecordedAt: now })
    .where(and(eq(siwsChallenges.nonce, nonce), isNull(siwsChallenges.rejectionRecordedAt)))
    .returning({ nonce: siwsChallenges.nonce });

  return claimed.length === 1;
}

/**
 * Records a refused sign-in in the event log, at most once per challenge.
 *
 * A rejection is a *decision*, and the decisions are what the audit trail is for
 * (CLAUDE.md → Observability): "how often is a sign-in refused, and why" is a question
 * about this product's behaviour, and until now the only trace of it was a log line.
 *
 * The first genuine rejection of a challenge is written with its own specific reason. Every
 * later attempt on that same nonce is a replay of a decision already recorded and is logged
 * only — which is what keeps `events` bounded by challenges issued (see
 * `REJECTIONS_AGAINST_A_STORED_CHALLENGE`) at no real cost to the audit trail.
 *
 * Nothing identifying goes in. `userId` is null and the payload carries the reason alone —
 * no address, no public key, no nonce. No signature has proved an identity on this path, an
 * unproven address does not enter the audit trail, and the reason is no finer a distinction
 * than the server already drew for itself. It adds no oracle either: the HTTP response is
 * uniformly opaque whatever is written here, and nothing here is readable by the caller.
 *
 * Fails closed, and is captured rather than thrown: a claim that cannot be made writes no
 * event, because the failure mode of guessing is the unbounded table this exists to
 * prevent — and telemetry must not turn a rejection into a 503 either way.
 */
export async function recordSignInRejection(
  correlationId: string,
  rejection: SignInRejected,
): Promise<void> {
  const { reason, nonce } = rejection;

  if (!isRejectionOfAStoredChallenge(reason)) {
    return;
  }

  if (!nonce) {
    logger.warn('sign-in rejection against a stored challenge arrived without its nonce', {
      correlationId,
      reason,
    });

    return;
  }

  try {
    if (!(await claimRejectionEventSlot(nonce, new Date()))) {
      logger.info('sign-in rejection not recorded: challenge already has one, or is gone', {
        correlationId,
        reason,
      });

      return;
    }

    await recordEvent({
      eventType: 'auth.sign_in_rejected',
      occurredAt: new Date(),
      correlationId,
      userId: null,
      payload: { reason },
    });
  } catch (error) {
    captureError(error, { correlationId, operation: 'recordSignInRejection' });
  }
}

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

/**
 * Housekeeping, on the write path that produces the garbage.
 *
 * Never fatal: the challenge is already committed and returned, so a failed delete must
 * not turn a sign-in the caller can complete into a 503. Captured rather than swallowed —
 * a reaper that has quietly stopped running is exactly the kind of thing that is only ever
 * noticed by the table it was supposed to be draining.
 */
async function reapOpportunistically(correlationId: string, now: Date): Promise<void> {
  try {
    await reapExpiredChallenges(getDb(), correlationId, now);
  } catch (error) {
    captureError(error, { correlationId, operation: 'reapExpiredChallenges' });
  }
}

/**
 * Issues one challenge for one client, behind the rate limit.
 *
 * The limit lives here rather than in the route so that the check and the write it guards
 * cannot drift apart: there is no way to add a `siws_challenges` row without passing it.
 *
 * @param clientKey - From `clientKeyForRequest` — derived from transport headers, never
 *   from anything in a request body. It buys no identity; it is only what the limit counts.
 */
export async function issueSignInChallenge(
  correlationId: string,
  clientKey: string,
): Promise<StoredSignInInput> {
  const now = new Date();
  const input = buildSignInInput(now, requiredSignInDomain());

  await assertWithinChallengeRateLimit(getDb(), clientKey, correlationId, now);

  await getDb().insert(siwsChallenges).values({
    nonce: input.nonce,
    input,
    issuedAt: now,
    expiresAt: new Date(input.expirationTime),
    clientKey,
  });

  logger.info('siws challenge issued', { correlationId, nonce: input.nonce });

  await reapOpportunistically(correlationId, now);

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

/** What `parseSignInMessage` gives back for the bytes the wallet signed, or nullish. */
type ParsedSignInMessage = ReturnType<typeof parseSignInMessage>;

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
  return checkParsedSignIn(
    challenge,
    proof,
    parseSignInMessage(proof.signedMessage),
    now,
    expectedDomain,
  );
}

/**
 * As `checkSignIn`, but for the one caller that has already parsed the signed message to
 * find the nonce it looked the challenge up by. `parsed` is never a separate input: both
 * callers derive it from `proof.signedMessage` and nothing else, so the nonce the row was
 * fetched with and the address checked here are guaranteed to come from one parse of one
 * set of bytes. It stays private for that reason — it is not a seam a caller may widen.
 */
function checkParsedSignIn(
  challenge: Pick<SiwsChallengeRow, 'input' | 'consumedAt'>,
  proof: WalletSignInProof,
  parsed: ParsedSignInMessage,
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
  if (parsed?.address !== address) {
    return { ok: false, reason: 'address_mismatch' };
  }

  return passesSignatureVerification(address, challenge.input, proof)
    ? { ok: true, address }
    : { ok: false, reason: 'signature_invalid' };
}

export class SignInRejected extends Error {
  /**
   * @param nonce - The challenge the decision was reached against, when it reached one.
   *   Carried so the rejection can be recorded against that row exactly once. It is a
   *   lookup key and never an identity, and it does not enter the event payload.
   */
  constructor(
    readonly reason: SignInRejection,
    readonly nonce: string | null = null,
  ) {
    super(`sign-in rejected: ${reason}`);
    this.name = 'SignInRejected';
  }
}

/** The nonce is only a lookup key here; nothing is trusted until `checkSignIn` passes. */
function readSubmittedNonce(parsed: ParsedSignInMessage): string | null {
  return parsed?.nonce ?? null;
}

/**
 * Verifies a sign-in, supersedes the session the request arrived with, and issues the new
 * one — all in a single transaction.
 *
 * All four writes commit or roll back together. Split apart, each seam is a live hole:
 * a crash between consume and insert burns the challenge and leaves the user
 * unauthenticated with a nonce that can never be spent again; a revoke that fails after
 * the insert leaves the *old*, wrong-identity session alive and cookied while the caller
 * is told the sign-in failed. One transaction is what makes "the old identity is gone"
 * and "the new one exists" the same fact.
 *
 * @param previous - The session this request arrived as, from `resolveSession()` — the
 *   cookie, never the request body. `null` on a first sign-in.
 */
export async function verifyWalletSignIn(
  proof: WalletSignInProof,
  correlationId: string,
  previous: SessionIdentity | null,
): Promise<EstablishedSession> {
  const parsed = parseSignInMessage(proof.signedMessage);
  const nonce = readSubmittedNonce(parsed);

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

    const check = checkParsedSignIn(challenge, proof, parsed, new Date(), expectedDomain);

    if (!check.ok) {
      throw new SignInRejected(check.reason, nonce);
    }

    // Before anything new is minted: the proof has re-bound identity, so the session the
    // request came in as is dead from here on. A throw rolls the whole sign-in back —
    // nonce unspent, no new session — rather than leaving the old one live behind a
    // successful sign-in.
    await supersedePreviousSession(tx, previous, check.address, correlationId);

    // Belt and braces alongside the row lock: the guard is in SQL too, so two racing
    // requests cannot both see an unconsumed nonce.
    const consumed = await tx
      .update(siwsChallenges)
      .set({ consumedAt: new Date() })
      .where(and(eq(siwsChallenges.nonce, nonce), isNull(siwsChallenges.consumedAt)))
      .returning({ nonce: siwsChallenges.nonce });

    if (consumed.length !== 1) {
      throw new SignInRejected('nonce_already_consumed', nonce);
    }

    return establishSession(tx, check.address, correlationId);
  });
}
