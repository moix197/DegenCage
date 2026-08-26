import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientWithWallet } from '@solana/kit-plugin-wallet';

import { decideReauth, type ReauthTrigger } from './account-switch';
import { readActiveAddress, subscribeToWalletAccountChanges } from './wallet-account-watch';

/**
 * The wallet-standard registry, stood in for: real `UiWallet` handles are resolved to their
 * underlying `Wallet` through a module-level `WeakMap` that only the wallet-standard app
 * layer can populate, so the fakes below register their feature implementations here
 * instead. `getWalletFeature` is mocked over that map with the real contract — including
 * the throw for a wallet that does not implement the feature, which is what the graceful
 * degradation is guarding against.
 */
const { walletFeatures } = vi.hoisted(() => ({
  walletFeatures: new WeakMap<object, Record<string, unknown>>(),
}));

vi.mock('@wallet-standard/ui', () => ({
  getWalletFeature: (handle: object, featureName: string) => {
    const features = walletFeatures.get(handle);

    if (!features || !(featureName in features)) {
      throw new Error(`Wallet does not implement \`${featureName}\``);
    }

    return features[featureName];
  },
}));

/**
 * The subscription itself, tested without a browser, a wallet extension, or React.
 *
 * This is the regression for the hole it closes: the watcher compared the wallet against
 * the session correctly, but nothing ever told it to look. A switch made in the extension
 * reached the app only if something else re-rendered — so the session stayed live, and
 * authenticated requests kept being served as the account the user had just left.
 *
 * The wiring is what is asserted here, not the effect that consumes it: the repo has no
 * DOM environment or React renderer (`vitest.config.ts` is `environment: 'node'`, and
 * adding jsdom + a renderer for one hook was out of scope). So the two pieces the hook
 * puts together — `subscribeToWalletAccountChanges` and `decideReauth` — are driven here
 * exactly as `useWalletSession` drives them, including the revoke that a real change event
 * must reach. What is left unasserted is only React's own `useSyncExternalStore` contract.
 */

const SESSION_ADDRESS = 'So11111111111111111111111111111111111111112';
const OTHER_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

interface FakeWallet {
  name: string;
  /** As on a `UiWallet`: feature *names*; the implementations live in the registry. */
  features: string[];
}

/** A wallet that implements `standard:events`, with its listeners exposed for the test. */
function walletWithEvents(name: string) {
  const listeners = new Set<() => void>();
  const unsubscribe = vi.fn();
  const on = vi.fn((_event: 'change', listener: () => void) => {
    listeners.add(listener);

    return () => {
      listeners.delete(listener);
      unsubscribe();
    };
  });

  const wallet = { name, features: ['standard:connect', 'standard:events'] } satisfies FakeWallet;

  walletFeatures.set(wallet, { 'standard:events': { on } });

  return {
    wallet,
    on,
    unsubscribe,
    emitChange: () => listeners.forEach((listener) => listener()),
  };
}

/** A wallet that does not implement `standard:events`: nothing to attach to. */
function walletWithoutEvents(name: string): FakeWallet {
  return { name, features: ['standard:connect', 'solana:signIn'] };
}

function createFakeClient(initial: { address?: string | null; wallets?: FakeWallet[] } = {}) {
  const listeners = new Set<() => void>();
  let address = initial.address ?? null;
  let wallets = initial.wallets ?? [];

  const unsubscribeStore = vi.fn();
  const client = {
    wallet: {
      getState: () => ({
        connected: address === null ? null : { account: { address } },
        wallets,
      }),
      subscribe: vi.fn((listener: () => void) => {
        listeners.add(listener);

        return () => {
          listeners.delete(listener);
          unsubscribeStore();
        };
      }),
    },
  };

  return {
    client: client as unknown as ClientWithWallet,
    unsubscribeStore,
    /** What the extension reports next; the store notification is the caller's choice. */
    setState: (next: { address?: string | null; wallets?: FakeWallet[] }) => {
      address = next.address === undefined ? address : next.address;
      wallets = next.wallets ?? wallets;
    },
    notifyStore: () => listeners.forEach((listener) => listener()),
  };
}

/** A stand-in for `window`/`document` so the refocus backstop can be driven in Node. */
function createFakeEventTarget(extra: Record<string, unknown> = {}) {
  const handlers = new Map<string, Set<(event?: unknown) => void>>();

  return {
    target: {
      ...extra,
      addEventListener: vi.fn((type: string, handler: (event?: unknown) => void) => {
        const existing = handlers.get(type) ?? new Set();

        existing.add(handler);
        handlers.set(type, existing);
      }),
      removeEventListener: vi.fn((type: string, handler: (event?: unknown) => void) => {
        handlers.get(type)?.delete(handler);
      }),
    },
    countFor: (type: string) => handlers.get(type)?.size ?? 0,
    dispatch: (type: string) => handlers.get(type)?.forEach((handler) => handler()),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('subscribeToWalletAccountChanges', () => {
  it('reports a switch the wallet announces on its own standard:events', () => {
    const phantom = walletWithEvents('Phantom');
    const { client, setState } = createFakeClient({
      address: SESSION_ADDRESS,
      wallets: [phantom.wallet],
    });
    const onChange = vi.fn();

    subscribeToWalletAccountChanges(client, onChange);
    setState({ address: OTHER_ADDRESS });
    phantom.emitChange();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(readActiveAddress(client)).toBe(OTHER_ADDRESS);
  });

  it('reports a switch the plugin store fans out', () => {
    const { client, setState, notifyStore } = createFakeClient({ address: SESSION_ADDRESS });
    const onChange = vi.fn();

    subscribeToWalletAccountChanges(client, onChange);
    setState({ address: null });
    notifyStore();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(readActiveAddress(client)).toBeNull();
  });

  /**
   * A wallet with no `standard:events` is one fewer channel, never a thrown error that
   * takes the other channels down with it.
   */
  it('degrades without crashing for a wallet that has no standard:events', () => {
    const { client, setState, notifyStore } = createFakeClient({
      address: SESSION_ADDRESS,
      wallets: [walletWithoutEvents('Ledger')],
    });
    const onChange = vi.fn();

    expect(() => subscribeToWalletAccountChanges(client, onChange)).not.toThrow();

    setState({ address: OTHER_ADDRESS });
    notifyStore();

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('attaches to a wallet that registers after the subscription started', () => {
    const solflare = walletWithEvents('Solflare');
    const { client, setState, notifyStore } = createFakeClient({ address: SESSION_ADDRESS });
    const onChange = vi.fn();

    subscribeToWalletAccountChanges(client, onChange);
    setState({ wallets: [solflare.wallet] });
    notifyStore();
    onChange.mockClear();

    solflare.emitChange();

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('never attaches to the same wallet twice, however often the store notifies', () => {
    const phantom = walletWithEvents('Phantom');
    const { client, notifyStore } = createFakeClient({
      address: SESSION_ADDRESS,
      wallets: [phantom.wallet],
    });

    subscribeToWalletAccountChanges(client, vi.fn());
    notifyStore();
    notifyStore();

    expect(phantom.on).toHaveBeenCalledTimes(1);
  });

  it('drops the subscription of a wallet that unregisters', () => {
    const phantom = walletWithEvents('Phantom');
    const { client, setState, notifyStore } = createFakeClient({
      address: SESSION_ADDRESS,
      wallets: [phantom.wallet],
    });

    subscribeToWalletAccountChanges(client, vi.fn());
    setState({ wallets: [] });
    notifyStore();

    expect(phantom.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('tears every channel down on unmount', () => {
    const phantom = walletWithEvents('Phantom');
    const fakeWindow = createFakeEventTarget();
    const fakeDocument = createFakeEventTarget({ visibilityState: 'visible' });

    vi.stubGlobal('window', fakeWindow.target);
    vi.stubGlobal('document', fakeDocument.target);

    const { client, unsubscribeStore, notifyStore } = createFakeClient({
      address: SESSION_ADDRESS,
      wallets: [phantom.wallet],
    });
    const onChange = vi.fn();

    const unsubscribe = subscribeToWalletAccountChanges(client, onChange);

    unsubscribe();

    expect(unsubscribeStore).toHaveBeenCalledTimes(1);
    expect(phantom.unsubscribe).toHaveBeenCalledTimes(1);
    expect(fakeWindow.countFor('focus')).toBe(0);
    expect(fakeDocument.countFor('visibilitychange')).toBe(0);

    // And nothing that fires afterwards can still reach a hook that is gone.
    notifyStore();
    phantom.emitChange();
    fakeWindow.dispatch('focus');

    expect(onChange).not.toHaveBeenCalled();
  });

  it('has nothing to attach to outside the browser', () => {
    const { client } = createFakeClient({ address: SESSION_ADDRESS });

    expect(typeof window).toBe('undefined');
    expect(() => subscribeToWalletAccountChanges(client, vi.fn())()).not.toThrow();
  });
});

/**
 * The backstop, for wallets whose `change` event is unreliable or never arrives: coming
 * back to the tab re-reads the extension rather than trusting the last thing it said.
 */
describe('the refocus backstop', () => {
  let browser = createBrowser('visible');

  beforeEach(() => {
    browser = createBrowser('visible');
  });

  function createBrowser(visibilityState: 'hidden' | 'visible') {
    const fakeWindow = createFakeEventTarget();
    const fakeDocument = createFakeEventTarget({ visibilityState });

    vi.stubGlobal('window', fakeWindow.target);
    vi.stubGlobal('document', fakeDocument.target);

    return { fakeWindow, fakeDocument };
  }

  it('re-reads the wallet when the window is focused', () => {
    const { client } = createFakeClient({ address: SESSION_ADDRESS });
    const onChange = vi.fn();

    subscribeToWalletAccountChanges(client, onChange);
    browser.fakeWindow.dispatch('focus');

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('re-reads the wallet when the tab becomes visible again', () => {
    const { client } = createFakeClient({ address: SESSION_ADDRESS });
    const onChange = vi.fn();

    subscribeToWalletAccountChanges(client, onChange);
    browser.fakeDocument.dispatch('visibilitychange');

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when the tab is only being hidden', () => {
    const hidden = createBrowser('hidden');
    const { client } = createFakeClient({ address: SESSION_ADDRESS });
    const onChange = vi.fn();

    subscribeToWalletAccountChanges(client, onChange);
    hidden.fakeDocument.dispatch('visibilitychange');

    expect(onChange).not.toHaveBeenCalled();
  });
});

/**
 * The subscription wired to the decision, exactly as `useWalletSession` wires them: a real
 * `change` event has to come out the far end as a server-side revoke.
 */
describe('a change event reaching the revoke path', () => {
  function watchForRevoke(
    client: ClientWithWallet,
    session: { sessionAddress: string | null; signedInAddress?: string | null },
  ) {
    const revoked: ReauthTrigger[] = [];
    let hasObservedWallet = readActiveAddress(client) !== null;

    const unsubscribe = subscribeToWalletAccountChanges(client, () => {
      const observedAddress = readActiveAddress(client);

      hasObservedWallet ||= observedAddress !== null;

      const { trigger, shouldRevoke } = decideReauth({
        sessionAddress: session.sessionAddress,
        observedAddress,
        hasObservedWallet,
        isSigningIn: false,
        signedInAddress: session.signedInAddress ?? null,
      });

      if (shouldRevoke && trigger) {
        revoked.push(trigger);
      }
    });

    return { revoked, unsubscribe };
  }

  it('revokes when the wallet announces a different account', () => {
    const phantom = walletWithEvents('Phantom');
    const { client, setState } = createFakeClient({
      address: SESSION_ADDRESS,
      wallets: [phantom.wallet],
    });
    const { revoked } = watchForRevoke(client, { sessionAddress: SESSION_ADDRESS });

    setState({ address: OTHER_ADDRESS });
    phantom.emitChange();

    expect(revoked).toEqual(['account_switch']);
  });

  it('revokes when the wallet stops reporting an account at all', () => {
    const phantom = walletWithEvents('Phantom');
    const { client, setState } = createFakeClient({
      address: SESSION_ADDRESS,
      wallets: [phantom.wallet],
    });
    const { revoked } = watchForRevoke(client, { sessionAddress: SESSION_ADDRESS });

    setState({ address: null });
    phantom.emitChange();

    expect(revoked).toEqual(['wallet_disconnected']);
  });

  /**
   * The regression that must survive the new channels: straight after a sign-in the
   * server-rendered `sessionAddress` still names the account left behind, and the extra
   * notifications now arriving must not turn that stale render into a revoke of the
   * session the user just created.
   */
  it('does not revoke the session a sign-in has just created', () => {
    const phantom = walletWithEvents('Phantom');
    const { client, notifyStore } = createFakeClient({
      address: OTHER_ADDRESS,
      wallets: [phantom.wallet],
    });
    const { revoked } = watchForRevoke(client, {
      sessionAddress: SESSION_ADDRESS,
      signedInAddress: OTHER_ADDRESS,
    });

    phantom.emitChange();
    notifyStore();

    expect(revoked).toEqual([]);
  });

  it('stops revoking once it is unsubscribed', () => {
    const phantom = walletWithEvents('Phantom');
    const { client, setState } = createFakeClient({
      address: SESSION_ADDRESS,
      wallets: [phantom.wallet],
    });
    const { revoked, unsubscribe } = watchForRevoke(client, { sessionAddress: SESSION_ADDRESS });

    unsubscribe();
    setState({ address: OTHER_ADDRESS });
    phantom.emitChange();

    expect(revoked).toEqual([]);
  });
});
