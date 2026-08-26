'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { getBase58Decoder } from '@solana/kit';
import type { ClientWithWallet } from '@solana/kit-plugin-wallet';
import {
  useConnect,
  useIsWalletReady,
  useSignIn,
  useSignMessage,
  useWallets,
} from '@solana/kit-plugin-wallet/react';
import type { SolanaSignInOutput } from '@solana/wallet-standard-features';
import { createSignInMessage, verifySignIn } from '@solana/wallet-standard-util';
import { useRouter } from 'next/navigation';

import { decideReauth, type ReauthTrigger } from './account-switch';
import {
  fetchChallenge,
  postProof,
  revokeCurrentSession,
  type SignInChallenge,
  type SignInProofWire,
} from './session-api';
import { readActiveAddress, subscribeToWalletAccountChanges } from './wallet-account-watch';

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
 *    than acting under an identity the user is no longer using. Seeing it requires being
 *    *told*: the address is read through `subscribeToWalletAccountChanges`, not sampled on
 *    whatever render happens next, or a switch stays invisible until the next page load
 *    while every request is served as the old address. The decision itself lives in
 *    `decideReauth`; this hook only feeds it what the extension reports and acts on the
 *    answer. Revocation is server-side — the session row dies — never client state.
 */

type DiscoveredWallet = ReturnType<ClientWithWallet['wallet']['getState']>['wallets'][number];

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

const REVOKE_FAILED_MESSAGE =
  'We could not sign you out. Reload this page — if it still shows you as connected, disconnect this site in your wallet.';

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

/**
 * The wallet's active address, as a subscription rather than a sample.
 *
 * `useSyncExternalStore` is what makes the account-switch watcher a watcher: React
 * re-reads on every notification from any of the channels and re-renders only when the
 * address actually differs, so the effect below runs on the switch itself instead of on
 * some unrelated render. It also owns the teardown — the subscription is dropped on
 * unmount, and `subscribe` is memoised on the client so a re-render never re-subscribes.
 *
 * The server snapshot is `null`: there is no extension there, and the session — not the
 * wallet — is what the server renders identity from.
 */
function useObservedWalletAddress(client: ClientWithWallet): string | null {
  const subscribe = useCallback(
    (notify: () => void) => subscribeToWalletAccountChanges(client, notify),
    [client],
  );

  return useSyncExternalStore(
    subscribe,
    () => readActiveAddress(client),
    () => null,
  );
}

export function useWalletSession(
  client: ClientWithWallet,
  sessionAddress: string | null,
): WalletSessionState {
  const router = useRouter();
  const wallets = useWallets(client);
  const isReady = useIsWalletReady(client);
  const signInAction = useSignIn(client);
  const connectAction = useConnect(client);
  const signMessageAction = useSignMessage(client);

  const [isSigningIn, setIsSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reauthTrigger, setReauthTrigger] = useState<ReauthTrigger | null>(null);
  /** The address the server said it issued a session for, once a sign-in has succeeded. */
  const [signedInAddress, setSignedInAddress] = useState<string | null>(null);

  const connectedAddress = useObservedWalletAddress(client);
  /** Latches: has the extension reported an account at any point on this page? */
  const hasObservedWallet = useRef(false);

  useEffect(() => {
    hasObservedWallet.current ||= connectedAddress !== null;

    // Whether this mismatch is real *now*, or is the stale server render of a sign-in that
    // has already succeeded, is `decideReauth`'s call — every input it reads is a dependency
    // of this effect, so a deferral is always re-examined, never dropped.
    const { trigger, shouldRevoke } = decideReauth({
      sessionAddress,
      observedAddress: connectedAddress,
      hasObservedWallet: hasObservedWallet.current,
      isSigningIn,
      signedInAddress,
    });

    setReauthTrigger(shouldRevoke ? trigger : null);

    if (!shouldRevoke || !trigger) {
      return;
    }

    // Revoke first, refresh second. The address on screen is rendered from
    // `resolveSession()`, so refreshing before the row is dead just re-renders the stale
    // identity — precisely the failure this watcher exists to prevent. And a revoke that
    // did not happen is never refreshed over: the user is told, not shown a sign-out we
    // cannot vouch for.
    void revokeCurrentSession(trigger).then((revoked) => {
      if (!revoked) {
        setError(REVOKE_FAILED_MESSAGE);
        return;
      }

      router.refresh();
    });
  }, [connectedAddress, isSigningIn, router, sessionAddress, signedInAddress]);

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
          // Recorded before the refresh is asked for, so the watcher already knows which
          // identity the page is *about* to render as by the time it re-runs.
          setSignedInAddress(await postProof(proof));
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
