import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import type { ClientWithWallet } from '@solana/kit-plugin-wallet';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resolveSigningCapability,
  signQuotedTransaction,
  SIGN_AND_SEND_TRANSACTION_FEATURE,
  SIGN_TRANSACTION_FEATURE,
  SwapSigningError,
} from './use-swap-signing';

/**
 * The pure and async halves of the signing hook, exercised without React — the same split
 * `account-switch.ts`/`use-wallet-session.ts` already use, and the reason this workspace needs
 * no browser test environment. The React wrapper adds only `useState`/`useSyncExternalStore`
 * around `signQuotedTransaction`, which is what is tested here.
 */

vi.mock('@solana/kit-plugin-wallet', () => ({ walletSigner: () => (client: unknown) => client }));

const WALLET_ADDRESS = 'BPFLoaderUpgradeab1e11111111111111111111111';
const OTHER_ADDRESS = 'So11111111111111111111111111111111111111112';

function compiledMessageFor(feePayer: string) {
  const instruction = {
    programAddress: address('ComputeBudget111111111111111111111111111111'),
    accounts: [{ address: address(OTHER_ADDRESS), role: AccountRole.READONLY }],
    data: new Uint8Array([2, 64, 66, 15, 0]),
  };

  return pipe(
    createTransactionMessage({ version: 0 }),
    (message) => appendTransactionMessageInstructions([instruction], message),
    (message) => setTransactionMessageFeePayer(address(feePayer), message),
    (message) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: '11111111111111111111111111111111' as never, lastValidBlockHeight: 300n }, message),
    (message) => compileTransaction(message),
  );
}

function messageBase64For(feePayer: string): string {
  return Buffer.from(compiledMessageFor(feePayer).messageBytes).toString('base64');
}

const QUOTED_MESSAGE = messageBase64For(WALLET_ADDRESS);

interface FakeWalletOptions {
  features?: string[];
  signer?: unknown;
  connected?: boolean;
  /** Models the extension switching accounts while its own signing prompt is open. */
  switchAccountWhileSigning?: boolean;
  returnUnsigned?: boolean;
}

/**
 * A wallet handle whose active account can move *during* the prompt, because that is the
 * failure the post-signature check exists for — the address is deliberately flipped by the
 * signer itself rather than by a call counter, so the test does not depend on how many times
 * the store happens to be read.
 */
function fakeClient({
  features = [SIGN_TRANSACTION_FEATURE],
  signer,
  connected = true,
  switchAccountWhileSigning = false,
  returnUnsigned = false,
}: FakeWalletOptions = {}) {
  let activeAddress = WALLET_ADDRESS;

  const defaultSigner = {
    address: WALLET_ADDRESS,
    modifyAndSignTransactions: vi.fn(async (transactions: { messageBytes: Uint8Array; signatures: Record<string, unknown> }[]) => {
      if (switchAccountWhileSigning) {
        activeAddress = OTHER_ADDRESS;
      }

      return transactions.map((transaction) =>
        returnUnsigned ? transaction : { ...transaction, signatures: { [WALLET_ADDRESS]: new Uint8Array(64).fill(7) } },
      );
    }),
  };

  const client = {
    wallet: {
      getState: () =>
        connected
          ? { connected: { account: { address: activeAddress, features }, signer: signer === undefined ? defaultSigner : signer, wallet: {} } }
          : { connected: null },
    },
  } as unknown as ClientWithWallet;

  return { client, signer: defaultSigner };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveSigningCapability', () => {
  it('prefers signTransaction when the account offers both', () => {
    expect(resolveSigningCapability([SIGN_TRANSACTION_FEATURE, SIGN_AND_SEND_TRANSACTION_FEATURE])).toBe('sign_transaction');
  });

  it('names a sign-and-send-only account rather than assuming it can sign on its own', () => {
    expect(resolveSigningCapability([SIGN_AND_SEND_TRANSACTION_FEATURE])).toBe('sign_and_send_only');
  });

  it('reports unsupported when neither feature is present', () => {
    expect(resolveSigningCapability(['solana:signMessage'])).toBe('unsupported');
    expect(resolveSigningCapability([])).toBe('unsupported');
    expect(resolveSigningCapability(undefined)).toBe('unsupported');
  });
});

describe('signQuotedTransaction feature detection', () => {
  it('signs the server’s own compiled message and returns the wire transaction', async () => {
    const { client } = fakeClient();

    const signedBase64 = await signQuotedTransaction(client, QUOTED_MESSAGE);
    const decoded = getTransactionDecoder().decode(Uint8Array.from(Buffer.from(signedBase64, 'base64')));

    // The bytes the server compiled, unchanged — this client never composes a transaction of
    // its own, which is what makes the server's hash comparison mean anything.
    expect(Buffer.from(decoded.messageBytes).toString('base64')).toBe(QUOTED_MESSAGE);
    expect(decoded.signatures[WALLET_ADDRESS as keyof typeof decoded.signatures]).not.toBeNull();
  });

  it('refuses a sign-and-send-only wallet instead of broadcasting around the kill switch', async () => {
    const { client } = fakeClient({ features: [SIGN_AND_SEND_TRANSACTION_FEATURE], signer: { address: WALLET_ADDRESS, signAndSendTransactions: vi.fn() } });

    await expect(signQuotedTransaction(client, QUOTED_MESSAGE)).rejects.toMatchObject({ reason: 'wallet_sign_and_send_only' });
  });

  it('refuses an account that implements neither signing feature', async () => {
    const { client } = fakeClient({ features: ['solana:signMessage'], signer: null });

    await expect(signQuotedTransaction(client, QUOTED_MESSAGE)).rejects.toMatchObject({ reason: 'wallet_cannot_sign' });
  });

  it('refuses a read-only wallet that advertises the feature but has no signer', async () => {
    const { client } = fakeClient({ signer: null });

    await expect(signQuotedTransaction(client, QUOTED_MESSAGE)).rejects.toMatchObject({ reason: 'wallet_cannot_sign' });
  });

  it('refuses a signer that cannot sign a transaction it is handed', async () => {
    const { client } = fakeClient({ signer: { address: WALLET_ADDRESS } });

    await expect(signQuotedTransaction(client, QUOTED_MESSAGE)).rejects.toMatchObject({ reason: 'wallet_cannot_sign' });
  });

  it('refuses when no wallet is connected at all', async () => {
    const { client } = fakeClient({ connected: false });

    await expect(signQuotedTransaction(client, QUOTED_MESSAGE)).rejects.toMatchObject({ reason: 'wallet_not_connected' });
  });
});

describe('signQuotedTransaction account checks', () => {
  it('refuses to prompt for a quote made for a different account', async () => {
    const { client, signer } = fakeClient();

    await expect(signQuotedTransaction(client, messageBase64For(OTHER_ADDRESS))).rejects.toMatchObject({ reason: 'fee_payer_mismatch' });
    expect(signer.modifyAndSignTransactions).not.toHaveBeenCalled();
  });

  it('aborts submission when the wallet changed accounts while the prompt was open', async () => {
    const { client } = fakeClient({ switchAccountWhileSigning: true });

    await expect(signQuotedTransaction(client, QUOTED_MESSAGE)).rejects.toMatchObject({ reason: 'account_switched' });
  });

  it('refuses a wallet that returned the transaction without signing it', async () => {
    const { client } = fakeClient({ returnUnsigned: true });

    await expect(signQuotedTransaction(client, QUOTED_MESSAGE)).rejects.toMatchObject({ reason: 'signature_missing' });
  });

  it('refuses a quoted message that is not a compiled transaction message', async () => {
    const { client } = fakeClient();

    await expect(signQuotedTransaction(client, 'bm90LWEtbWVzc2FnZQ==')).rejects.toBeInstanceOf(SwapSigningError);
  });
});
