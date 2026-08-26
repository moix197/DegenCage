import type { SolanaSignInInput } from '@solana/wallet-standard-features';

import type { ReauthTrigger } from './account-switch';

/**
 * The browser's half of `/api/auth/*` — every call the session flow makes, and nothing
 * else. Split out of `use-wallet-session` for the same reason `reauthTriggerFor` is: what
 * each response means for the user's identity is security-critical, and it has to be
 * testable without a browser, a wallet extension, or React.
 *
 * One rule runs through all three: a response we did not get, or got and cannot read as a
 * success, is a failure. None of them may return as if the server had agreed.
 */

/** What `/api/auth/nonce` hands back: our issued input, domain and nonce included. */
export type SignInChallenge = SolanaSignInInput & { domain: string; nonce: string };

export interface SignInProofWire {
  publicKey: string;
  signedMessage: string;
  signature: string;
}

export async function fetchChallenge(): Promise<SignInChallenge> {
  const response = await fetch('/api/auth/nonce', { method: 'POST' });

  if (!response.ok) {
    // The kill switch is the expected reason, so say so rather than "something failed".
    throw new Error('Wallet connect is currently unavailable. Please try again later.');
  }

  return ((await response.json()) as { input: SignInChallenge }).input;
}

/** @returns The address the *server* bound the new session to — never our own claim. */
export async function postProof(proof: SignInProofWire): Promise<string> {
  const response = await fetch('/api/auth/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(proof),
  });

  if (!response.ok) {
    throw new Error('That signature was not accepted. Please try connecting again.');
  }

  return ((await response.json()) as { address: string }).address;
}

/**
 * `reason` annotates the audit trail; it is not an instruction. *Which* session dies is
 * decided from the cookie server-side, and the reason is narrowed to a known one there.
 *
 * A rejected request — or one that never arrived — is a *failed* sign-out, and says so.
 * Reporting it as done would leave the user reading "signing you out" over a session row
 * that still resolves: exactly the state this whole path exists to prevent.
 *
 * @returns Whether the server confirmed the revocation.
 */
export async function revokeCurrentSession(reason: ReauthTrigger): Promise<boolean> {
  try {
    const response = await fetch(`/api/auth/verify?reason=${reason}`, { method: 'DELETE' });

    return response.ok;
  } catch {
    return false;
  }
}
