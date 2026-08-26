'use client';

import { useCallback, useEffect, useState } from 'react';

import type { ClientWithWallet } from '@solana/kit-plugin-wallet';
import {
  useConnect,
  useConnectedWallet,
  useIsWalletReady,
  useSignIn,
  useSignMessage,
  useWallets,
} from '@solana/kit-plugin-wallet/react';
import type { SolanaSignInInput, SolanaSignInOutput } from '@solana/wallet-standard-features';
import { createSignInMessage } from '@solana/wallet-standard-util';
import { useRouter } from 'next/navigation';

/**
 * Owns the whole client side of "who is signed in".
 *
 * Two rules it exists to enforce:
 *
 * 1. **The cookie is authoritative.** `sessionAddress` is rendered on the server from
 *    `resolveSession()`, so a reload never re-prompts for a signature. The wallet's own
 *    reconnect state is cosmetic.
 * 2. **The wallet and the session must agree.** Switching the active account in the
 *    extension without disconnecting leaves a session bound to the *previous* address.
 *    That session is revoked the moment the mismatch is seen — better a forced re-auth
 *    than acting under an identity the user is no longer using.
 */

type DiscoveredWallet = ReturnType<ClientWithWallet['wallet']['getState']>['wallets'][number];

/** What `/api/auth/nonce` hands back: our issued input, domain and nonce included. */
type SignInChallenge = SolanaSignInInput & { domain: string; nonce: string };

interface SignInProofWire {
  publicKey: string;
  signedMessage: string;
  signature: string;
}

export interface WalletSessionState {
  wallets: readonly DiscoveredWallet[];
  connectedAddress: string | null;
  isReady: boolean;
  isSigningIn: boolean;
  error: string | null;
  signIn: (wallet: DiscoveredWallet) => void;
}

const SIGN_IN_FEATURE = 'solana:signIn';

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function toProofWire(publicKey: Uint8Array, signedMessage: Uint8Array, signature: Uint8Array) {
  return {
    publicKey: toBase64(publicKey),
    signedMessage: toBase64(signedMessage),
    signature: toBase64(signature),
  } satisfies SignInProofWire;
}

async function fetchChallenge(): Promise<SignInChallenge> {
  const response = await fetch('/api/auth/nonce', { method: 'POST' });

  if (!response.ok) {
    // The kill switch is the expected reason, so say so rather than "something failed".
    throw new Error('Wallet connect is currently unavailable. Please try again later.');
  }

  return ((await response.json()) as { input: SignInChallenge }).input;
}

async function postProof(proof: SignInProofWire): Promise<void> {
  const response = await fetch('/api/auth/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(proof),
  });

  if (!response.ok) {
    throw new Error('That signature was not accepted. Please try connecting again.');
  }
}

async function revokeCurrentSession(): Promise<void> {
  await fetch('/api/auth/verify', { method: 'DELETE' });
}

function supportsSignIn(wallet: DiscoveredWallet): boolean {
  return wallet.features.includes(SIGN_IN_FEATURE);
}

/** A superseded dispatch is not a failure — it is the user clicking twice. */
function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'Wallet sign-in failed.';
}

export function useWalletSession(
  client: ClientWithWallet,
  sessionAddress: string | null,
): WalletSessionState {
  const router = useRouter();
  const wallets = useWallets(client);
  const connected = useConnectedWallet(client);
  const isReady = useIsWalletReady(client);
  const signInAction = useSignIn(client);
  const connectAction = useConnect(client);
  const signMessageAction = useSignMessage(client);

  const [isSigningIn, setIsSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connectedAddress = connected?.account.address ?? null;

  useEffect(() => {
    if (!sessionAddress || !connectedAddress || connectedAddress === sessionAddress) {
      return;
    }

    void revokeCurrentSession().then(() => router.refresh());
  }, [connectedAddress, router, sessionAddress]);

  /**
   * Wallets without `solana:signIn` (and some Ledger firmware behind wallets that do)
   * cannot do the single-prompt flow. Connect, then sign the very same SIWS text as a
   * plain message: the server verifies it identically. A wallet that refuses to sign
   * arbitrary bytes rejects here, visibly, instead of hanging on a prompt that never came.
   */
  const signInByMessage = useCallback(
    async (wallet: DiscoveredWallet, challenge: SignInChallenge): Promise<SignInProofWire> => {
      await connectAction.dispatchAsync(wallet);
      const account = client.wallet.getState().connected?.account;

      if (!account) {
        throw new Error('This wallet did not authorize an account.');
      }

      const signedMessage = createSignInMessage({ ...challenge, address: account.address });
      const signature = await signMessageAction.dispatchAsync(signedMessage);

      return toProofWire(account.publicKey as Uint8Array, signedMessage, signature as Uint8Array);
    },
    [client, connectAction, signMessageAction],
  );

  const signInBySignIn = useCallback(
    async (wallet: DiscoveredWallet, challenge: SignInChallenge): Promise<SignInProofWire> => {
      const output: SolanaSignInOutput = await signInAction.dispatchAsync(wallet, challenge);

      return toProofWire(
        output.account.publicKey as Uint8Array,
        output.signedMessage as Uint8Array,
        output.signature as Uint8Array,
      );
    },
    [signInAction],
  );

  const signIn = useCallback(
    (wallet: DiscoveredWallet): void => {
      setError(null);
      setIsSigningIn(true);

      void (async () => {
        try {
          const challenge = await fetchChallenge();
          const proof = supportsSignIn(wallet)
            ? await signInBySignIn(wallet, challenge)
            : await signInByMessage(wallet, challenge);

          await postProof(proof);
          router.refresh();
        } catch (thrown) {
          if (!isAbort(thrown)) {
            setError(describe(thrown));
          }
        } finally {
          setIsSigningIn(false);
        }
      })();
    },
    [router, signInByMessage, signInBySignIn],
  );

  return { wallets, connectedAddress, isReady, isSigningIn, error, signIn };
}
