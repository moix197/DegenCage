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
