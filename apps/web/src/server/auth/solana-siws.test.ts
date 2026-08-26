import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

import { getBase58Decoder } from '@solana/kit';
import { createSignInMessage } from '@solana/wallet-standard-util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SiwsChallengeRow, StoredSignInInput } from '../db/schema';
import {
  buildSignInInput,
  checkSignIn,
  requiredSignInDomain,
  SignInRejected,
  verifyWalletSignIn,
  type WalletSignInProof,
} from './solana-siws';

/**
 * No wallet extension anywhere in here: a locally generated Ed25519 keypair produces
 * signatures indistinguishable from Phantom's, which is the whole point — the five
 * rejections below are the ones a real attacker would try, and each is asserted to fail
 * closed on its own.
 */

const { transactionMock, establishSessionMock } = vi.hoisted(() => ({
  transactionMock: vi.fn(),
  establishSessionMock: vi.fn(),
}));

vi.mock('../db/client', () => ({ getDb: () => ({ transaction: transactionMock }) }));
vi.mock('./session', () => ({ establishSession: establishSessionMock }));

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
  };
}

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

  it('rejects a signature made by a key other than the one presented', () => {
    const impostor = generateWallet();
    const proof = signChallenge(impostor, input);

    expect(checkSignIn(challengeRow(input), { ...proof, publicKey: wallet.publicKey }, DURING, DOMAIN))
      .toEqual({ ok: false, reason: 'signature_invalid' });
  });

  it('rejects key material of the wrong length instead of handing it to the verifier', () => {
    const proof = signChallenge(wallet, input);

    expect(checkSignIn(challengeRow(input), { ...proof, signature: new Uint8Array(8) }, DURING, DOMAIN))
      .toEqual({ ok: false, reason: 'signature_invalid' });
  });
});

describe('verifyWalletSignIn', () => {
  /** A single-row `siws_challenges` that actually remembers being consumed. */
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
  }

  beforeEach(() => {
    establishSessionMock.mockImplementation(async (_tx: unknown, address: string) => ({
      walletAddress: address,
    }));
    vi.useFakeTimers();
    vi.setSystemTime(DURING);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('verifies, consumes the nonce, and issues the session in the same transaction', async () => {
    const row = challengeRow(input);
    fakeChallengeTable(row);

    await expect(verifyWalletSignIn(signChallenge(wallet, input), 'trade-intent-1')).resolves
      .toMatchObject({ walletAddress: wallet.address });
    expect(row.consumedAt).toBeInstanceOf(Date);
    expect(establishSessionMock).toHaveBeenCalledOnce();
  });

  it('rejects a replay: the identical, still-valid proof submitted a second time', async () => {
    const row = challengeRow(input);
    fakeChallengeTable(row);
    const proof = signChallenge(wallet, input);

    await expect(verifyWalletSignIn(proof, 'trade-intent-2')).resolves.toBeTruthy();

    // Same address, same publicKey, same signedMessage, same signature — and still inside
    // the expiry window. Only the spent nonce stands between this and a stolen identity.
    await expect(verifyWalletSignIn(proof, 'trade-intent-3')).rejects.toThrow(SignInRejected);
    expect(establishSessionMock).toHaveBeenCalledOnce();
  });

  it('rejects a nonce we never issued', async () => {
    fakeChallengeTable(null);

    await expect(verifyWalletSignIn(signChallenge(wallet, input), 'trade-intent-4')).rejects
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

    await expect(verifyWalletSignIn(garbage, 'trade-intent-5')).rejects.toMatchObject({
      reason: 'malformed_message',
    });
  });

  it('never issues a session when the signature does not verify', async () => {
    const row = challengeRow(input);
    fakeChallengeTable(row);
    const proof = signChallenge(wallet, input);
    proof.signature[0] = proof.signature[0]! ^ 0x01;

    await expect(verifyWalletSignIn(proof, 'trade-intent-6')).rejects.toMatchObject({
      reason: 'signature_invalid',
    });
    expect(row.consumedAt).toBeNull();
    expect(establishSessionMock).not.toHaveBeenCalled();
  });
});
