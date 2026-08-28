'use client';

import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';

import {
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  isTransactionModifyingSigner,
  createClient,
  type Transaction,
} from '@solana/kit';
import { walletSigner, type ClientWithWallet } from '@solana/kit-plugin-wallet';

import { readActiveAddress, subscribeToWalletAccountChanges } from './wallet-account-watch';

/**
 * Signing, kept inside the wallet-library containment boundary
 * (`.ai/decisions/wallet-standard-ui-dependency.md`): `/trade`'s panel imports this hook and
 * nothing from `@solana/kit-plugin-wallet` or `@wallet-standard/*`, so a pre-1.0 breaking
 * release stays inside `src/client/wallet/`.
 *
 * What the wallet is asked to sign is *the server's* compiled message, handed back verbatim
 * from `POST /api/swap/quote`. Nothing here builds, edits or re-orders a transaction: the
 * browser holding signable bytes it composed itself would make the server's re-verification
 * meaningless, since there would be nothing authoritative to compare against.
 *
 * Two checks happen before those bytes ever leave for `POST /api/swap/submit`, and both are
 * client-side conveniences that the server repeats and does not trust:
 *
 *  1. The message's fee payer is the account currently connected — catching a stale quote from
 *     before an account switch *before* the user is prompted to sign it.
 *  2. The connected address is re-read **after** the prompt returns and compared to the one the
 *     quote was for. A wallet can change accounts while its own prompt is open; that is the
 *     same failure `use-wallet-session.ts` guards against for sign-in, and the same answer —
 *     abort, say why, do not submit an identity mix-up to the server.
 */

/** One client = one chain, and this product trades mainnet — the same constant `wallet-provider.tsx` builds its client with. */
const WALLET_CHAIN = 'solana:mainnet';

export const SIGN_TRANSACTION_FEATURE = 'solana:signTransaction';
export const SIGN_AND_SEND_TRANSACTION_FEATURE = 'solana:signAndSendTransaction';

/**
 * What a connected account can actually do, decided by looking rather than assuming.
 *
 * `signAndSendTransaction` is deliberately *not* a usable path here even though plenty of
 * wallets implement it and some implement nothing else. It broadcasts from inside the wallet,
 * which would skip `POST /api/swap/submit` entirely: no re-verification of the signed bytes
 * against `tx_message_hash`, no submit-time re-evaluation, and — the part that matters most in
 * this phase — no `chain.broadcast` kill switch in front of a real mainnet send. So it is
 * detected and named as its own refusal, never silently substituted for `signTransaction`.
 */
export type SigningCapability = 'sign_transaction' | 'sign_and_send_only' | 'unsupported';

export function resolveSigningCapability(features: readonly string[] | undefined): SigningCapability {
  if (features?.includes(SIGN_TRANSACTION_FEATURE)) {
    return 'sign_transaction';
  }

  if (features?.includes(SIGN_AND_SEND_TRANSACTION_FEATURE)) {
    return 'sign_and_send_only';
  }

  return 'unsupported';
}

export type SwapSigningFailure =
  | 'wallet_not_connected'
  | 'wallet_cannot_sign'
  | 'wallet_sign_and_send_only'
  | 'fee_payer_mismatch'
  | 'account_switched'
  | 'signature_missing'
  | 'malformed_message';

export class SwapSigningError extends Error {
  constructor(
    readonly reason: SwapSigningFailure,
    message: string,
  ) {
    super(message);
    this.name = 'SwapSigningError';
  }
}

const FAILURE_COPY: Record<SwapSigningFailure, string> = {
  wallet_not_connected: 'No wallet is connected. Connect the account this quote was made for, then try again.',
  wallet_cannot_sign: 'This wallet cannot sign transactions — it looks like a watch-only account. Connect a signing wallet to trade.',
  wallet_sign_and_send_only:
    'This wallet can only sign and send in one step, which would broadcast without DegenCage verifying the trade first. Use a wallet that supports signing a transaction on its own.',
  fee_payer_mismatch: 'This quote was made for a different account than the one your wallet has connected. Request a new quote.',
  account_switched: 'Your wallet changed accounts while signing, so nothing was submitted. Request a new quote for the account you are using now.',
  signature_missing: 'Your wallet returned an unsigned transaction. Nothing was submitted.',
  malformed_message: 'The quote could not be read as a transaction, so nothing was signed.',
};

export function describeSigningFailure(error: unknown): string {
  if (error instanceof SwapSigningError) {
    return FAILURE_COPY[error.reason];
  }

  return error instanceof Error ? error.message : 'Signing failed.';
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

interface QuotedMessage {
  transaction: Transaction;
  feePayer: string;
}

/**
 * Rebuilds the unsigned transaction around the server's compiled message: the same bytes, plus
 * the empty signature slots the wire format needs. The required signers are read out of the
 * message's own header rather than assumed to be one, so a route Jupiter builds with a second
 * signer does not silently lose a slot.
 */
function toUnsignedTransaction(messageBase64: string): QuotedMessage {
  try {
    const messageBytes = fromBase64(messageBase64);
    const compiled = getCompiledTransactionMessageDecoder().decode(messageBytes);
    const signerAddresses = compiled.staticAccounts.slice(0, compiled.header.numSignerAccounts);

    if (signerAddresses.length === 0) {
      throw new Error('compiled message declares no required signer');
    }

    return {
      transaction: { messageBytes, signatures: Object.fromEntries(signerAddresses.map((account) => [account, null])) } as unknown as Transaction,
      feePayer: signerAddresses[0]!,
    };
  } catch (error) {
    throw new SwapSigningError('malformed_message', `quoted message could not be decoded: ${String(error)}`);
  }
}

/**
 * Prompts the connected wallet to sign the server's compiled message and returns the signed
 * bytes, base64 wire format — exactly what `POST /api/swap/submit` re-verifies.
 *
 * @throws SwapSigningError for every refusal, so the caller can render a reason rather than a
 *   stack trace. Nothing is submitted on any throwing path.
 */
export async function signQuotedTransaction(client: ClientWithWallet, messageBase64: string): Promise<string> {
  const connected = client.wallet.getState().connected;

  if (!connected) {
    throw new SwapSigningError('wallet_not_connected', 'no wallet is connected');
  }

  // The *account's* feature list, not the wallet's: a wallet may advertise `signTransaction`
  // while the connected account does not support it, and the account's list is the one the Kit
  // signer is built from (`createSignerFromWalletAccount`). It is a subset of the wallet's, so
  // checking it is the stricter of the two reads.
  const capability = resolveSigningCapability(connected.account.features);

  if (capability === 'unsupported' || !connected.signer) {
    throw new SwapSigningError('wallet_cannot_sign', 'the connected account implements no transaction-signing feature');
  }

  if (capability === 'sign_and_send_only') {
    throw new SwapSigningError('wallet_sign_and_send_only', 'the connected account can only sign-and-send, which would bypass submit verification');
  }

  if (!isTransactionModifyingSigner(connected.signer)) {
    throw new SwapSigningError('wallet_cannot_sign', 'the connected signer cannot sign a transaction it is handed');
  }

  const { transaction, feePayer } = toUnsignedTransaction(messageBase64);
  const quotedAddress = connected.account.address;

  if (feePayer !== quotedAddress) {
    throw new SwapSigningError('fee_payer_mismatch', 'the quoted transaction pays fees from a different account than the connected one');
  }

  const [signed] = await connected.signer.modifyAndSignTransactions([transaction]);

  return assertSignedByQuotedAccount(client, signed, quotedAddress);
}

/**
 * Everything that has to be true *after* the prompt returns. Split out because it is the half
 * that is easy to forget: the wallet can change accounts while its own dialog is open, and a
 * wallet can also hand back a transaction it did not actually sign.
 */
function assertSignedByQuotedAccount(client: ClientWithWallet, signed: Transaction | undefined, quotedAddress: string): string {
  if (readActiveAddress(client) !== quotedAddress) {
    throw new SwapSigningError('account_switched', 'the wallet changed accounts while the signing prompt was open');
  }

  if (!signed?.signatures[quotedAddress as keyof typeof signed.signatures]) {
    throw new SwapSigningError('signature_missing', 'the wallet returned no signature for the fee payer');
  }

  return getBase64EncodedWireTransaction(signed);
}

export interface SwapSigningState {
  connectedAddress: string | null;
  /** `null` until a wallet is connected — there is no account to ask about yet. */
  capability: SigningCapability | null;
  isSigning: boolean;
  error: string | null;
  clearError: () => void;
  /** Resolves to the signed bytes, base64 wire format, or `null` when signing was refused (see `error`). */
  sign: (messageBase64: string) => Promise<string | null>;
}

/**
 * The wallet's active address as a subscription rather than a sample — the same
 * `useSyncExternalStore` wiring `use-wallet-session.ts` uses, so an account switch made in the
 * extension reaches this panel instead of waiting for an unrelated re-render.
 */
function useObservedWalletAddress(client: ClientWithWallet): string | null {
  const subscribe = useCallback((notify: () => void) => subscribeToWalletAccountChanges(client, notify), [client]);

  return useSyncExternalStore(
    subscribe,
    () => readActiveAddress(client),
    () => null,
  );
}

export function useSwapSigning(): SwapSigningState {
  const client = useMemo(() => createClient().use(walletSigner({ chain: WALLET_CHAIN })), []);
  const connectedAddress = useObservedWalletAddress(client);
  const [isSigning, setIsSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-read on every notification the address subscription delivers, so a wallet swapped
  // mid-session re-answers "can this account sign?" instead of keeping the old answer.
  const capability = useMemo(
    () => (connectedAddress ? resolveSigningCapability(client.wallet.getState().connected?.account.features) : null),
    [client, connectedAddress],
  );

  const sign = useCallback(
    async (messageBase64: string): Promise<string | null> => {
      setError(null);
      setIsSigning(true);

      try {
        return await signQuotedTransaction(client, messageBase64);
      } catch (thrown) {
        setError(describeSigningFailure(thrown));

        return null;
      } finally {
        setIsSigning(false);
      }
    },
    [client],
  );

  return { connectedAddress, capability, isSigning, error, clearError: () => setError(null), sign };
}
