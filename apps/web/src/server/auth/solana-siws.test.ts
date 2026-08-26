import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

import { getBase58Decoder } from '@solana/kit';
import { createSignInMessage } from '@solana/wallet-standard-util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SiwsChallengeRow, StoredSignInInput } from '../db/schema';
import { ChallengeRateLimited, CHALLENGE_RATE_LIMIT_MAX } from './challenge-rate-limit';
import {
  buildSignInInput,
  checkSignIn,
  issueSignInChallenge,
  recordSignInRejection,
  requiredSignInDomain,
  SignInRejected,
  verifyWalletSignIn,
  type SignInRejection,
  type WalletSignInProof,
} from './solana-siws';

/**
 * No wallet extension anywhere in here: a locally generated Ed25519 keypair produces
 * signatures indistinguishable from Phantom's, which is the whole point — the five
 * rejections below are the ones a real attacker would try, and each is asserted to fail
 * closed on its own.
 */

const {
  transactionMock,
  selectMock,
  insertMock,
  deleteMock,
  establishSessionMock,
  supersedePreviousSessionMock,
  recordEventMock,
  captureErrorMock,
} = vi.hoisted(() => ({
  transactionMock: vi.fn(),
  selectMock: vi.fn(),
  insertMock: vi.fn(),
  deleteMock: vi.fn(),
  establishSessionMock: vi.fn(),
  supersedePreviousSessionMock: vi.fn(),
  recordEventMock: vi.fn(),
  captureErrorMock: vi.fn(),
}));

vi.mock('../db/client', () => ({
  getDb: () => ({
    transaction: transactionMock,
    select: selectMock,
    insert: insertMock,
    delete: deleteMock,
  }),
}));
vi.mock('./session', () => ({
  establishSession: establishSessionMock,
  supersedePreviousSession: supersedePreviousSessionMock,
}));
vi.mock('../../observability/events', () => ({ recordEvent: recordEventMock }));
vi.mock('../../observability/error-tracking', () => ({ captureError: captureErrorMock }));

const DOMAIN = 'degencage.test';

interface Wallet {
  address: string;
  publicKey: Uint8Array;
  privateKey: KeyObject;
}

function generateWallet(): Wallet {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));

  return { address: getBase58Decoder().decode(raw), publicKey: raw, privateKey };
}

function signChallenge(wallet: Wallet, input: StoredSignInInput): WalletSignInProof {
  const signedMessage = createSignInMessage({ ...input, address: wallet.address });

  return {
    publicKey: wallet.publicKey,
    signedMessage,
    signature: new Uint8Array(sign(null, signedMessage, wallet.privateKey)),
  };
}

function challengeRow(input: StoredSignInInput, consumedAt: Date | null = null): SiwsChallengeRow {
  return {
    nonce: input.nonce,
    input,
    issuedAt: new Date(input.issuedAt),
    expiresAt: new Date(input.expirationTime),
    consumedAt,
    clientKey: 'client-key-hash',
  };
}

/**
 * The session a request arrives carrying. Its `idHash` comes from the caller's own cookie
 * and nothing else — it is the only session a sign-in is ever allowed to revoke.
 */
const PREVIOUS_SESSION = {
  walletAddress: 'So11111111111111111111111111111111111111112',
  walletId: 'wallet-1',
  userId: 'user-1',
  expiresAt: new Date('2026-09-25T00:00:00Z'),
  idHash: 'hash-of-the-callers-own-cookie',
};

const ISSUED_AT = new Date('2026-08-26T12:00:00Z');
/** Inside the 5-minute challenge window. */
const DURING = new Date('2026-08-26T12:01:00Z');

let wallet: Wallet;
let input: StoredSignInInput;

beforeEach(() => {
  vi.clearAllMocks();
  process.env['SIWS_DOMAIN'] = DOMAIN;
  wallet = generateWallet();
  input = buildSignInInput(ISSUED_AT, DOMAIN);
});

afterEach(() => {
  delete process.env['SIWS_DOMAIN'];
});

describe('requiredSignInDomain', () => {
  it('throws rather than defaulting when SIWS_DOMAIN is unset', () => {
    delete process.env['SIWS_DOMAIN'];

    expect(() => requiredSignInDomain()).toThrow(/SIWS_DOMAIN/);
  });
});

describe('buildSignInInput', () => {
  it('issues a fresh 32-byte nonce and a 5-minute window', () => {
    const other = buildSignInInput(ISSUED_AT, DOMAIN);

    expect(input.nonce).toHaveLength(64);
    expect(input.nonce).not.toBe(other.nonce);
    expect(Date.parse(input.expirationTime) - Date.parse(input.issuedAt)).toBe(5 * 60 * 1_000);
  });
});

describe('checkSignIn', () => {
  it('accepts a valid sign-in and derives the address from the signing key', () => {
    const check = checkSignIn(challengeRow(input), signChallenge(wallet, input), DURING, DOMAIN);

    expect(check).toEqual({ ok: true, address: wallet.address });
  });

  it('rejects a challenge whose nonce has already been consumed', () => {
    const proof = signChallenge(wallet, input);
    const consumed = challengeRow(input, new Date('2026-08-26T12:00:30Z'));

    expect(checkSignIn(consumed, proof, DURING, DOMAIN)).toEqual({
      ok: false,
      reason: 'nonce_already_consumed',
    });
  });

  it('rejects a perfectly valid signature against an expired challenge', () => {
    const proof = signChallenge(wallet, input);
    const afterExpiry = new Date(Date.parse(input.expirationTime) + 1_000);

    expect(checkSignIn(challengeRow(input), proof, afterExpiry, DOMAIN)).toEqual({
      ok: false,
      reason: 'challenge_expired',
    });
  });

  it('rejects a stored challenge bound to a domain that is not ours', () => {
    const foreign = buildSignInInput(ISSUED_AT, 'phishing.example');
    const proof = signChallenge(wallet, foreign);

    expect(checkSignIn(challengeRow(foreign), proof, DURING, DOMAIN)).toEqual({
      ok: false,
      reason: 'domain_mismatch',
    });
  });

  it('rejects a message signed for a different domain than the one we issued', () => {
    const proof = signChallenge(wallet, { ...input, domain: 'phishing.example' });

    expect(checkSignIn(challengeRow(input), proof, DURING, DOMAIN)).toEqual({
      ok: false,
      reason: 'signature_invalid',
    });
  });

  it('rejects a tampered signed message', () => {
    const proof = signChallenge(wallet, input);
    proof.signedMessage[10] = proof.signedMessage[10]! ^ 0x01;

    expect(checkSignIn(challengeRow(input), proof, DURING, DOMAIN)).toEqual({
      ok: false,
      reason: 'signature_invalid',
    });
  });

  /**
   * What an account switch mid-prompt produces: the message names the account the page had
   * a moment ago, the key belongs to the account that actually signed. It is a different
   * failure from a forged signature and has to be *named* differently — folded into
   * `signature_invalid` it reads in the logs exactly like an attack, and the one question
   * worth answering ("did this user's wallet change accounts?") goes unanswered.
   */
  it('names an account/key disagreement rather than calling it a bad signature', () => {
    const impostor = generateWallet();
    const proof = signChallenge(impostor, input);

    expect(checkSignIn(challengeRow(input), { ...proof, publicKey: wallet.publicKey }, DURING, DOMAIN))
      .toEqual({ ok: false, reason: 'address_mismatch' });
  });

  it('rejects a signature made by a key other than the one the message names', () => {
    const impostor = generateWallet();
    // Message and key agree on `wallet`; only the signature is somebody else's.
    const forged = {
      ...signChallenge(wallet, input),
      signature: signChallenge(impostor, input).signature,
    };

    expect(checkSignIn(challengeRow(input), forged, DURING, DOMAIN)).toEqual({
      ok: false,
      reason: 'signature_invalid',
    });
  });

  it('rejects key material of the wrong length instead of handing it to the verifier', () => {
    const proof = signChallenge(wallet, input);

    expect(checkSignIn(challengeRow(input), { ...proof, signature: new Uint8Array(8) }, DURING, DOMAIN))
      .toEqual({ ok: false, reason: 'signature_invalid' });
  });
});

describe('verifyWalletSignIn', () => {
  /**
   * A single-row `siws_challenges` that actually remembers being consumed.
   *
   * @returns The transaction handle it will run the callback with, so a test can assert
   *   that every write of a sign-in went through *that* executor and no other.
   */
  function fakeChallengeTable(row: SiwsChallengeRow | null) {
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({ for: () => ({ limit: async () => (row ? [row] : []) }) }),
        }),
      }),
      update: () => ({
        set: (values: { consumedAt: Date }) => ({
          where: () => ({
            returning: async () => {
              if (!row || row.consumedAt !== null) {
                return [];
              }

              row.consumedAt = values.consumedAt;

              return [{ nonce: row.nonce }];
            },
          }),
        }),
      }),
    };

    transactionMock.mockImplementation((callback: (tx: unknown) => unknown) => callback(tx));

    return tx;
  }

  beforeEach(() => {
    establishSessionMock.mockImplementation(async (_tx: unknown, address: string) => ({
      walletAddress: address,
    }));
    supersedePreviousSessionMock.mockResolvedValue(undefined);
    vi.useFakeTimers();
    vi.setSystemTime(DURING);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('verifies, consumes the nonce, and issues the session in the same transaction', async () => {
    const row = challengeRow(input);
    fakeChallengeTable(row);

    await expect(verifyWalletSignIn(signChallenge(wallet, input), 'trade-intent-1', null)).resolves
      .toMatchObject({ walletAddress: wallet.address });
    expect(row.consumedAt).toBeInstanceOf(Date);
    expect(establishSessionMock).toHaveBeenCalledOnce();
  });

  it('rejects a replay: the identical, still-valid proof submitted a second time', async () => {
    const row = challengeRow(input);
    fakeChallengeTable(row);
    const proof = signChallenge(wallet, input);

    await expect(verifyWalletSignIn(proof, 'trade-intent-2', null)).resolves.toBeTruthy();

    // Same address, same publicKey, same signedMessage, same signature — and still inside
    // the expiry window. Only the spent nonce stands between this and a stolen identity.
    await expect(verifyWalletSignIn(proof, 'trade-intent-3', null)).rejects.toThrow(SignInRejected);
    expect(establishSessionMock).toHaveBeenCalledOnce();
  });

  it('rejects a nonce we never issued', async () => {
    fakeChallengeTable(null);

    await expect(verifyWalletSignIn(signChallenge(wallet, input), 'trade-intent-4', null)).rejects
      .toMatchObject({ reason: 'unknown_nonce' });
    expect(establishSessionMock).not.toHaveBeenCalled();
  });

  it('rejects a message that is not a SIWS message at all', async () => {
    fakeChallengeTable(challengeRow(input));

    const garbage: WalletSignInProof = {
      publicKey: wallet.publicKey,
      signedMessage: new TextEncoder().encode('gm'),
      signature: new Uint8Array(64),
    };

    await expect(verifyWalletSignIn(garbage, 'trade-intent-5', null)).rejects.toMatchObject({
      reason: 'malformed_message',
    });
  });

  /**
   * The recovery path after an account switch, and the regression for it dead-ending.
   * Whatever happened on the previous attempt, a fresh nonce signed by the account the
   * wallet is on now has to buy a session for *that* account — the old address's history
   * must not stand in its way.
   */
  it('lets the account the wallet switched to sign in on a fresh challenge', async () => {
    fakeChallengeTable(challengeRow(input));

    await expect(verifyWalletSignIn(signChallenge(wallet, input), 'trade-intent-7', null)).resolves
      .toMatchObject({ walletAddress: wallet.address });

    const switched = generateWallet();
    const fresh = buildSignInInput(ISSUED_AT, DOMAIN);
    const freshRow = challengeRow(fresh);
    fakeChallengeTable(freshRow);

    await expect(verifyWalletSignIn(signChallenge(switched, fresh), 'trade-intent-8', null)).resolves
      .toMatchObject({ walletAddress: switched.address });
    expect(freshRow.consumedAt).toBeInstanceOf(Date);
  });

  it('leaves the challenge unspent when the wallet signs as an account other than its key', async () => {
    const row = challengeRow(input);
    fakeChallengeTable(row);
    const switched = generateWallet();
    // Message from one account, public key from the other — the shape a mid-prompt switch
    // produces. Rejecting it must not cost the user the challenge, or the retry is dead
    // before it starts.
    const mixed = { ...signChallenge(switched, input), publicKey: wallet.publicKey };

    await expect(verifyWalletSignIn(mixed, 'trade-intent-9', null)).rejects.toMatchObject({
      reason: 'address_mismatch',
    });
    expect(row.consumedAt).toBeNull();
    expect(establishSessionMock).not.toHaveBeenCalled();
  });

  it('never issues a session when the signature does not verify', async () => {
    const row = challengeRow(input);
    fakeChallengeTable(row);
    const proof = signChallenge(wallet, input);
    proof.signature[0] = proof.signature[0]! ^ 0x01;

    await expect(verifyWalletSignIn(proof, 'trade-intent-6', null)).rejects.toMatchObject({
      reason: 'signature_invalid',
    });
    expect(row.consumedAt).toBeNull();
    expect(establishSessionMock).not.toHaveBeenCalled();
  });

  /**
   * The supersede is not a step that happens near the sign-in — it is part of it. Run on
   * its own connection it could fail after the nonce was spent and the new session
   * inserted, and then the *old* session, bound to the account the user just left, would
   * still be live and still be the cookie in their browser.
   */
  it('revokes the session the request arrived with through the sign-in transaction itself', async () => {
    const tx = fakeChallengeTable(challengeRow(input));

    await expect(
      verifyWalletSignIn(signChallenge(wallet, input), 'trade-intent-10', PREVIOUS_SESSION),
    ).resolves.toMatchObject({ walletAddress: wallet.address });

    expect(supersedePreviousSessionMock).toHaveBeenCalledWith(
      tx,
      PREVIOUS_SESSION,
      wallet.address,
      'trade-intent-10',
    );
    // Same executor for both, or "revoked" and "issued" are not the same commit.
    expect(establishSessionMock.mock.calls[0]?.[0]).toBe(tx);
  });

  /**
   * The regression for the fail-open hole: a revoke write that will not land must take the
   * whole sign-in down with it. Nothing may be left behind for the caller's 503 to sit on
   * top of — no spent nonce, no new session, and (in Postgres, by the rollback this fake
   * stands in for) no half-killed old one.
   */
  it('spends no nonce and issues no session when the supersede fails', async () => {
    const row = challengeRow(input);
    fakeChallengeTable(row);
    supersedePreviousSessionMock.mockRejectedValue(new Error('revoke write failed'));

    await expect(
      verifyWalletSignIn(signChallenge(wallet, input), 'trade-intent-11', PREVIOUS_SESSION),
    ).rejects.toThrow('revoke write failed');

    expect(row.consumedAt).toBeNull();
    expect(establishSessionMock).not.toHaveBeenCalled();
  });

  it('has nothing to supersede when the request carried no session', async () => {
    fakeChallengeTable(challengeRow(input));

    await verifyWalletSignIn(signChallenge(wallet, input), 'trade-intent-12', null);

    expect(supersedePreviousSessionMock).toHaveBeenCalledWith(
      expect.anything(),
      null,
      wallet.address,
      'trade-intent-12',
    );
  });
});


describe('issueSignInChallenge', () => {
  const CLIENT_KEY = 'client-key-hash';
  let valuesSpy: ReturnType<typeof vi.fn>;

  /** `select().from().where()` — the rate limiter's count. */
  function issuedInWindow(count: number | Error) {
    selectMock.mockReturnValue({
      from: () => ({
        where: () =>
          count instanceof Error ? Promise.reject(count) : Promise.resolve([{ issued: count }]),
      }),
    });
  }

  function reapReturning(result: { nonce: string }[] | Error) {
    deleteMock.mockReturnValue({
      where: () => ({
        returning: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)),
      }),
    });
  }

  beforeEach(() => {
    valuesSpy = vi.fn().mockResolvedValue(undefined);
    insertMock.mockReturnValue({ values: valuesSpy });
    issuedInWindow(0);
    reapReturning([]);
  });

  it('issues a challenge and records which client it was issued to', async () => {
    const issued = await issueSignInChallenge('trade-intent-20', CLIENT_KEY);

    expect(issued.nonce).toHaveLength(64);
    expect(valuesSpy.mock.calls[0]?.[0]).toMatchObject({
      nonce: issued.nonce,
      clientKey: CLIENT_KEY,
    });
  });

  /**
   * The endpoint behind this is unauthenticated and writes a row per call, so the limit is
   * the only thing standing between a `for` loop and an unbounded `siws_challenges`.
   */
  it('writes nothing once the client has spent its window', async () => {
    issuedInWindow(CHALLENGE_RATE_LIMIT_MAX);

    await expect(issueSignInChallenge('trade-intent-21', CLIENT_KEY)).rejects.toThrow(
      ChallengeRateLimited,
    );
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('fails closed, issuing nothing, when the limit cannot be counted', async () => {
    issuedInWindow(new Error('connection terminated'));

    await expect(issueSignInChallenge('trade-intent-22', CLIENT_KEY)).rejects.toThrow(
      'connection terminated',
    );
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('reaps expired challenges on the way out', async () => {
    await issueSignInChallenge('trade-intent-23', CLIENT_KEY);

    expect(deleteMock).toHaveBeenCalledOnce();
  });

  /**
   * Housekeeping is not allowed to cost the user a sign-in: the challenge is already
   * committed by then. It must still be visible, never swallowed.
   */
  it('still issues the challenge when the reap fails, and reports the failure', async () => {
    reapReturning(new Error('deadlock detected'));

    await expect(issueSignInChallenge('trade-intent-24', CLIENT_KEY)).resolves.toMatchObject({
      domain: DOMAIN,
    });
    expect(captureErrorMock).toHaveBeenCalledOnce();
  });
});

describe('recordSignInRejection', () => {
  const AGAINST_A_STORED_CHALLENGE: SignInRejection[] = [
    'nonce_already_consumed',
    'challenge_expired',
    'domain_mismatch',
    'address_mismatch',
    'signature_invalid',
  ];

  it.each(AGAINST_A_STORED_CHALLENGE)('records a %s rejection with its reason', async (reason) => {
    await recordSignInRejection('trade-intent-30', reason);

    expect(recordEventMock).toHaveBeenCalledOnce();
    expect(recordEventMock.mock.calls[0]?.[0]).toMatchObject({
      eventType: 'auth.sign_in_rejected',
      correlationId: 'trade-intent-30',
      userId: null,
      payload: { reason },
    });
  });

  /**
   * The audit trail is not a place to leak. No address, no public key, no nonce — nothing
   * a signature has not proved, and nothing the uniform 401 does not already concede.
   */
  it('carries the reason and nothing that could identify the caller', async () => {
    await recordSignInRejection('trade-intent-31', 'signature_invalid');

    const payload = recordEventMock.mock.calls[0]?.[0].payload as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(['reason']);
  });

  /**
   * `events` is append-only product data, and this path is reachable without any identity.
   * Getting as far as a stored challenge costs a nonce, and nonces are rate limited; the
   * two rejections that cost nothing to produce stop at the log, or the audit trail becomes
   * the unbounded table the rate limit exists to deny.
   */
  it.each<SignInRejection>(['malformed_proof', 'malformed_message', 'unknown_nonce'])(
    'writes no event for a %s rejection, which is free to generate',
    async (reason) => {
      await recordSignInRejection('trade-intent-32', reason);

      expect(recordEventMock).not.toHaveBeenCalled();
    },
  );

  it('never turns a failed event write into a failed rejection', async () => {
    recordEventMock.mockRejectedValueOnce(new Error('connection terminated'));

    await expect(recordSignInRejection('trade-intent-33', 'challenge_expired')).resolves
      .toBeUndefined();
    expect(captureErrorMock).toHaveBeenCalledOnce();
  });
});
