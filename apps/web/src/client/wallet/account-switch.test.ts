import { describe, expect, it } from 'vitest';

import { reauthTriggerFor, shouldRevokeSession } from './account-switch';

/**
 * The account-switch rule, tested without a browser or an extension.
 *
 * Every case here is a state a real wallet reports. The one that matters most is the
 * *second* group: an extension that stops reporting an account is the ordinary way a
 * switch shows up when the new account is not authorized for the site, and treating it as
 * "nothing to check" leaves a live session bound to the account the user just left.
 */

const SESSION_ADDRESS = 'So11111111111111111111111111111111111111112';
const OTHER_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const THIRD_ADDRESS = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

describe('reauthTriggerFor', () => {
  it('is quiet while the wallet and the session agree', () => {
    expect(
      reauthTriggerFor({
        sessionAddress: SESSION_ADDRESS,
        observedAddress: SESSION_ADDRESS,
        hasObservedWallet: true,
      }),
    ).toBeNull();
  });

  it('forces re-auth when the wallet reports a different account', () => {
    expect(
      reauthTriggerFor({
        sessionAddress: SESSION_ADDRESS,
        observedAddress: OTHER_ADDRESS,
        hasObservedWallet: true,
      }),
    ).toBe('account_switch');
  });

  it('forces re-auth when the wallet stops reporting an account it had reported', () => {
    // Switching to an account the site is not authorized for: the extension reports no
    // account rather than the new one. Reading that as "no mismatch" is how a session
    // bound to the *previous* account survives a switch — the whole bug.
    expect(
      reauthTriggerFor({
        sessionAddress: SESSION_ADDRESS,
        observedAddress: null,
        hasObservedWallet: true,
      }),
    ).toBe('wallet_disconnected');
  });

  it('leaves the session alone before the wallet has reported anything', () => {
    // A plain reload. The cookie is authoritative and the extension's reconnect state is
    // cosmetic, so this must never re-prompt for a signature.
    expect(
      reauthTriggerFor({
        sessionAddress: SESSION_ADDRESS,
        observedAddress: null,
        hasObservedWallet: false,
      }),
    ).toBeNull();
  });

  it('has nothing to protect when there is no session', () => {
    expect(
      reauthTriggerFor({
        sessionAddress: null,
        observedAddress: OTHER_ADDRESS,
        hasObservedWallet: true,
      }),
    ).toBeNull();
  });
});

/**
 * The watcher's *timing* rule, and the regression for it revoking the session a sign-in
 * had just created.
 *
 * `sessionAddress` is a server render, so straight after a successful sign-in it still
 * names the old account until a refresh lands. `reauthTriggerFor` correctly calls that a
 * mismatch — it is comparing what it was given — so the deferral has to happen here,
 * without ever becoming an excuse to skip a mismatch that is real.
 */
describe('shouldRevokeSession', () => {
  const agreement = {
    sessionAddress: SESSION_ADDRESS,
    observedAddress: OTHER_ADDRESS,
    hasObservedWallet: true,
    isSigningIn: false,
    signedInAddress: null as string | null,
    trigger: 'account_switch' as const,
  };

  it('does nothing without a trigger', () => {
    expect(shouldRevokeSession({ ...agreement, trigger: null })).toBe(false);
  });

  it('revokes a live mismatch on a page that has not signed in', () => {
    expect(shouldRevokeSession(agreement)).toBe(true);
  });

  it('waits while a sign-in is still in flight', () => {
    expect(shouldRevokeSession({ ...agreement, isSigningIn: true })).toBe(false);
  });

  /**
   * The bug: `isSigningIn` goes false when the request settles, but the refresh it kicked
   * off is still in flight, so `sessionAddress` is still the *old* address. Acting on that
   * revokes the session just created and the user is told their signature was rejected.
   */
  it('waits after a sign-in until the server-rendered session catches up', () => {
    expect(
      shouldRevokeSession({
        ...agreement,
        // Signed in as OTHER_ADDRESS; the page still renders the account left behind.
        sessionAddress: SESSION_ADDRESS,
        observedAddress: OTHER_ADDRESS,
        signedInAddress: OTHER_ADDRESS,
        isSigningIn: false,
      }),
    ).toBe(false);
  });

  it('stops waiting once the refresh has landed', () => {
    // Caught up, and now the wallet has moved on again — a real, current mismatch.
    expect(
      shouldRevokeSession({
        ...agreement,
        sessionAddress: OTHER_ADDRESS,
        observedAddress: THIRD_ADDRESS,
        signedInAddress: OTHER_ADDRESS,
      }),
    ).toBe(true);
  });

  /**
   * The deferral must not become a hole of its own: if the wallet has moved off the account
   * we just signed in as, the mismatch is real *now*, refresh or no refresh.
   */
  it('revokes anyway when the wallet leaves the account that was just signed in', () => {
    expect(
      shouldRevokeSession({
        ...agreement,
        sessionAddress: SESSION_ADDRESS,
        observedAddress: THIRD_ADDRESS,
        signedInAddress: OTHER_ADDRESS,
      }),
    ).toBe(true);
  });

  it('revokes anyway when the wallet stops reporting an account after a sign-in', () => {
    expect(
      shouldRevokeSession({
        ...agreement,
        trigger: 'wallet_disconnected',
        sessionAddress: SESSION_ADDRESS,
        observedAddress: null,
        signedInAddress: OTHER_ADDRESS,
      }),
    ).toBe(true);
  });

  /**
   * `shouldRevokeSession` is the same gate the UI uses to decide whether to show "your
   * wallet switched accounts" — a normal first sign-in must not trip that message, and a
   * real switch must.
   */
  it('is quiet on a normal first sign-in (no prior session to be stale against)', () => {
    expect(
      shouldRevokeSession({
        ...agreement,
        trigger: reauthTriggerFor({
          sessionAddress: null,
          observedAddress: OTHER_ADDRESS,
          hasObservedWallet: true,
        }),
        sessionAddress: null,
        observedAddress: OTHER_ADDRESS,
        signedInAddress: null,
        isSigningIn: false,
      }),
    ).toBe(false);
  });

  it('speaks up on a real account switch', () => {
    expect(
      shouldRevokeSession({
        ...agreement,
        trigger: reauthTriggerFor({
          sessionAddress: SESSION_ADDRESS,
          observedAddress: OTHER_ADDRESS,
          hasObservedWallet: true,
        }),
        sessionAddress: SESSION_ADDRESS,
        observedAddress: OTHER_ADDRESS,
        signedInAddress: null,
        isSigningIn: false,
      }),
    ).toBe(true);
  });
});
