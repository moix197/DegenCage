'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { getBase58Decoder } from '@solana/kit';
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
import { createSignInMessage, verifySignIn } from '@solana/wallet-standard-util';
import { useRouter } from 'next/navigation';

import { reauthTriggerFor, type ReauthTrigger } from './account-switch';

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
 *    than acting under an identity the user is no longer using. The decision itself lives
 *    in `reauthTriggerFor`; this hook only feeds it what the extension reports and acts on
 *    the answer. Revocation is server-side — the session row dies — never client state.
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
  /** Non-null while the session on file no longer matches the wallet — trust nothing on screen. */
  reauthTrigger: ReauthTrigger | null;
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

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

/**
 * Never post a proof we cannot verify ourselves.
 *
 * The server runs this same check and answers every failure with one deliberately opaque
 * `sign_in_rejected` — correct against a prober, useless to the user whose wallet handed
 * back a proof signed by an account other than the one it named (what an account switch
 * mid-prompt produces). Running it here first turns that dead end into a message that says
 * what to do, and leaves the challenge unspent so the next click starts from a fresh nonce
 * and the wallet's current account.
 */
function assertProofIsSelfConsistent(proof: SignInProofWire, challenge: SignInChallenge): void {
  const publicKey = fromBase64(proof.publicKey);
  // Derived from the key, exactly as the server derives it — never read off the wallet.
  const address = getBase58Decoder().decode(publicKey);
  const output = {
    account: { publicKey, address, chains: [], features: [] },
    signedMessage: fromBase64(proof.signedMessage),
    signature: fromBase64(proof.signature),
  } as unknown as SolanaSignInOutput;

  if (!verifySignIn({ ...challenge, address }, output)) {
    throw new Error(
      'Your wallet returned a signature that does not match the account it reported — it may have changed accounts. Connect again with the account you want to use.',
    );
  }
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

/**
 * `reason` annotates the audit trail; it is not an instruction. *Which* session dies is
 * decided from the cookie server-side, and the reason is narrowed to a known one there.
 */
async function revokeCurrentSession(reason: ReauthTrigger): Promise<void> {
  await fetch(`/api/auth/verify?reason=${reason}`, { method: 'DELETE' });
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
  const [reauthTrigger, setReauthTrigger] = useState<ReauthTrigger | null>(null);

  const connectedAddress = connected?.account.address ?? null;
  /** Latches: has the extension reported an account at any point on this page? */
  const hasObservedWallet = useRef(false);

  useEffect(() => {
    hasObservedWallet.current ||= connectedAddress !== null;

    const trigger = reauthTriggerFor({
      sessionAddress,
      observedAddress: connectedAddress,
      hasObservedWallet: hasObservedWallet.current,
    });

    setReauthTrigger(trigger);

    // A sign-in in flight is *about* to re-bind the session; revoking mid-flight would
    // race the new cookie and could kill the session the user just created. `isSigningIn`
    // is a dependency, so the check re-runs the moment the attempt settles either way —
    // deferred, never skipped.
    if (!trigger || isSigningIn) {
      return;
    }

    // Revoke first, refresh second. The address on screen is rendered from
    // `resolveSession()`, so refreshing before the row is dead just re-renders the stale
    // identity — precisely the failure this watcher exists to prevent.
    void revokeCurrentSession(trigger).then(() => router.refresh());
  }, [connectedAddress, isSigningIn, router, sessionAddress]);

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

      // The message names the account read *before* the prompt; the wallet signs with
      // whichever account is active when the user approves. If those drifted apart the
      // proof mixes two identities — the key says one thing, the signature another.
      if (client.wallet.getState().connected?.account.address !== account.address) {
        throw new Error(
          'Your wallet changed accounts while signing. Connect again to sign in as the account you are using now.',
        );
      }

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

          assertProofIsSelfConsistent(proof, challenge);
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

  return { wallets, connectedAddress, isReady, isSigningIn, error, reauthTrigger, signIn };
}
