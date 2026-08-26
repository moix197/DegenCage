'use client';

import { Suspense, useMemo } from 'react';

import { createClient, type Client } from '@solana/kit';
import { walletSigner, type ClientWithWallet } from '@solana/kit-plugin-wallet';
import { ClientProvider } from '@solana/react';

import type { ReauthTrigger } from './account-switch';
import { useWalletSession } from './use-wallet-session';

/**
 * The only place a Kit client is built, and the only React boundary that touches
 * `@solana/kit-plugin-wallet` (pre-1.0). Everything below it talks to
 * `useWalletSession`, so a breaking release stops here.
 *
 * One client = one chain, and Phase 0 watches real trading, so that chain is mainnet.
 */
const WALLET_CHAIN = 'solana:mainnet';

export interface WalletConnectProps {
  /**
   * The address the server-side session is bound to, or `null` when signed out.
   * Rendered by `connect/page.tsx` from `resolveSession()` — the cookie is authoritative,
   * never the wallet extension's own reconnect state.
   */
  sessionAddress: string | null;
}

/**
 * Provider plus connect surface. `ClientProvider` publishes the client for the Kit hooks
 * later phases will use; `<Suspense>` is the boundary it needs if a future plugin in the
 * `.use()` chain is async.
 */
export function WalletConnect({ sessionAddress }: WalletConnectProps) {
  const client = useMemo(() => createClient().use(walletSigner({ chain: WALLET_CHAIN })), []);

  return (
    <Suspense fallback={<p>Looking for wallets…</p>}>
      <ClientProvider client={client as unknown as Client<object>}>
        <ConnectPanel client={client} sessionAddress={sessionAddress} />
      </ClientProvider>
    </Suspense>
  );
}

function ConnectPanel({
  client,
  sessionAddress,
}: WalletConnectProps & { client: ClientWithWallet }) {
  const { wallets, connectedAddress, isReady, isSigningIn, error, reauthTrigger, signIn } =
    useWalletSession(client, sessionAddress);

  if (!isReady) {
    return <p>Looking for wallets…</p>;
  }

  return (
    <section>
      <SessionIdentity
        connectedAddress={connectedAddress}
        reauthTrigger={reauthTrigger}
        sessionAddress={sessionAddress}
      />

      {wallets.length === 0 ? (
        <p>No Solana wallet detected. Install Phantom or Solflare, then reload.</p>
      ) : (
        wallets.map((wallet) => (
          <button key={wallet.name} disabled={isSigningIn} onClick={() => signIn(wallet)}>
            Connect Wallet ({wallet.name})
          </button>
        ))
      )}

      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

/**
 * Who the app currently thinks you are — rendered here rather than in the page so a
 * detected mismatch can take it off screen the instant it is seen.
 *
 * `sessionAddress` still comes from the server's `resolveSession()`; the wallet's address
 * is never shown as the identity, only used to say which account to reconnect with. The
 * session is being torn down server-side while this renders, but the user must not be
 * looking at "Connected as <the account they just left>" for even one paint in between.
 */
function SessionIdentity({
  connectedAddress,
  reauthTrigger,
  sessionAddress,
}: {
  connectedAddress: string | null;
  reauthTrigger: ReauthTrigger | null;
  sessionAddress: string | null;
}) {
  if (reauthTrigger) {
    return (
      <p role="alert">
        {reauthTrigger === 'account_switch'
          ? `Your wallet switched accounts. Signing you out — connect again to continue as ${connectedAddress}.`
          : 'Your wallet is no longer connected to this account. Signing you out — connect again to continue.'}
      </p>
    );
  }

  return sessionAddress ? (
    <p>Connected as {sessionAddress}</p>
  ) : (
    <p>Not connected. Connect a wallet to write your trading constitution.</p>
  );
}
