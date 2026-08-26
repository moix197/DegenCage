/**
 * The account-switch decision, on its own, as a pure function.
 *
 * It is split out of `use-wallet-session` for the same reason `checkSignIn` is split out
 * of the transaction that calls it: this is the security-critical part, and it has to be
 * testable without a browser, a wallet extension, or React.
 *
 * The rule it encodes has two halves that pull in opposite directions:
 *
 * 1. **The cookie is authoritative until the wallet says otherwise.** A reload must never
 *    re-prompt for a signature, so a page where the extension has not yet reported an
 *    account is *not* a mismatch — the wallet's reconnect state is cosmetic.
 * 2. **Once the wallet has spoken, it must keep agreeing.** After it reports an account,
 *    any divergence — a different address, or no account at all because the user switched
 *    to one this site is not authorized for — means the session is bound to an identity
 *    the user has moved off. Fail closed: force re-auth rather than keep acting as the
 *    old address.
 *
 * Half 2 is the one that has to be exhaustive. Treating "the wallet stopped reporting an
 * account" as "nothing to check" is a fail-open hole, not a quiet edge case: it leaves a
 * live session bound to the previous account with nothing left to notice.
 */

export type ReauthTrigger = 'account_switch' | 'wallet_disconnected';

export interface AccountAgreement {
  /** The address the server-side session is bound to, from `resolveSession()`. */
  sessionAddress: string | null;
  /** The address the wallet extension currently reports, or `null` when it reports none. */
  observedAddress: string | null;
  /** Whether the wallet has reported an account at any point in this page session. */
  hasObservedWallet: boolean;
}

export function reauthTriggerFor({
  sessionAddress,
  observedAddress,
  hasObservedWallet,
}: AccountAgreement): ReauthTrigger | null {
  if (!sessionAddress || !hasObservedWallet) {
    return null;
  }

  if (observedAddress === null) {
    return 'wallet_disconnected';
  }

  return observedAddress === sessionAddress ? null : 'account_switch';
}

export interface ReauthAction extends AccountAgreement {
  /** What `reauthTriggerFor` said about the current agreement. */
  trigger: ReauthTrigger | null;
  /** Whether a sign-in is still in flight. */
  isSigningIn: boolean;
  /**
   * The address the *server* confirmed on the last successful sign-in in this page life,
   * or `null` if there has not been one. Server-derived (the verify response), never the
   * wallet extension's own claim.
   */
  signedInAddress: string | null;
}

/**
 * Whether the watcher may act on a trigger, or must wait.
 *
 * A trigger compares the wallet against `sessionAddress`, and `sessionAddress` is a
 * *server render*: it only changes when a refresh lands. In the window between "the
 * sign-in committed" and "the page has re-rendered as the new identity", it still names
 * the old account, so the comparison reports a switch that has already been resolved.
 * Acting on it revokes the session the user just created — and they are told their
 * signature was not accepted.
 *
 * `isSigningIn` alone does not close that window: it goes false the moment the request
 * settles, while the refresh it kicked off is still in flight. So the wait is on the thing
 * that actually matters — `sessionAddress` catching up to the address the server said it
 * issued the session for.
 *
 * The deferral is bounded and stays fail-closed: it holds only while the wallet is still
 * on the account we just signed in as. The moment the extension reports anything else —
 * a different account, or none — the mismatch is real and current, and the revoke goes
 * ahead whether or not the refresh ever landed.
 */
export function shouldRevokeSession({
  trigger,
  isSigningIn,
  signedInAddress,
  sessionAddress,
  observedAddress,
}: ReauthAction): boolean {
  if (!trigger || isSigningIn) {
    return false;
  }

  const awaitingRefresh = signedInAddress !== null && sessionAddress !== signedInAddress;

  return !(awaitingRefresh && observedAddress === signedInAddress);
}
