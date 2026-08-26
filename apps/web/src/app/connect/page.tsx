import { WalletConnect } from '@/client/wallet/wallet-provider';
import { resolveSession } from '@/server/auth/session';
import { WALLET_CONNECT_FLAG } from '@/server/auth/solana-siws';
import { isFeatureEnabled } from '@/server/flags/feature-flags';

// The session is read per request from the cookie, so this page can never be cached.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * "Connected as X" is rendered from `resolveSession()`, not from wallet state: the
 * server-side session is the identity, and a reload must never re-prompt for a signature.
 */
export default async function ConnectPage() {
  const [session, connectEnabled] = await Promise.all([
    resolveSession(),
    isFeatureEnabled(WALLET_CONNECT_FLAG),
  ]);

  return (
    <main>
      <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>DegenCage</h1>

      {session ? (
        <p>Connected as {session.walletAddress}</p>
      ) : (
        <p>Not connected. Connect a wallet to write your trading constitution.</p>
      )}

      {connectEnabled ? (
        <WalletConnect sessionAddress={session?.walletAddress ?? null} />
      ) : (
        <p>Wallet connect is switched off right now. Nothing is wrong with your wallet.</p>
      )}
    </main>
  );
}
