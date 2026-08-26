'use client';

import { Suspense, useMemo } from 'react';

import { createClient, type Client } from '@solana/kit';
import { walletSigner, type ClientWithWallet } from '@solana/kit-plugin-wallet';
import { ClientProvider } from '@solana/react';

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
  const { wallets, connectedAddress, isReady, isSigningIn, error, signIn } = useWalletSession(
    client,
    sessionAddress,
  );

  if (!isReady) {
    return <p>Looking for wallets…</p>;
  }

  const mismatched = sessionAddress !== null && connectedAddress !== null && connectedAddress !== sessionAddress;

  return (
    <section>
      {mismatched ? (
        <p>Your wallet switched accounts. Sign in again to continue as {connectedAddress}.</p>
      ) : null}

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
