import { describe, expect, it } from 'vitest';

import { reauthTriggerFor } from './account-switch';

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
