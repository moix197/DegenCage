import { WalletConnect } from '@/client/wallet/wallet-provider';
import { resolveSession } from '@/server/auth/session';
import { WALLET_CONNECT_FLAG } from '@/server/auth/solana-siws';
import { isFeatureEnabled } from '@/server/flags/feature-flags';

// The session is read per request from the cookie, so this page can never be cached.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The identity comes from `resolveSession()`, never from wallet state: the server-side
 * session is who you are, and a reload must never re-prompt for a signature.
 *
 * It is *handed to* the connect panel rather than printed here, though. A server render is
 * a snapshot: the moment the wallet switches accounts this page's "Connected as X" is
 * stale, and nothing left in the server tree can notice. The panel holds both halves — the
 * session's address and the wallet's — so it can stop showing the old identity the instant
 * they disagree, while the session is revoked underneath. With the kill switch off there is
 * no panel and no way to re-auth, so no identity is claimed at all.
 */
export default async function ConnectPage() {
  const [session, connectEnabled] = await Promise.all([
    resolveSession(),
    isFeatureEnabled(WALLET_CONNECT_FLAG),
  ]);

  return (
    <main>
      <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>DegenCage</h1>

      {connectEnabled ? (
        <WalletConnect sessionAddress={session?.walletAddress ?? null} />
      ) : (
        <p>Wallet connect is switched off right now. Nothing is wrong with your wallet.</p>
      )}
    </main>
  );
}
