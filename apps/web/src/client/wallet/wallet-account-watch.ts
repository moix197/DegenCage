import type { ClientWithWallet } from '@solana/kit-plugin-wallet';
import { getWalletFeature, type UiWallet } from '@wallet-standard/ui';

/**
 * Every channel that can tell us the wallet's active account moved, wired as one
 * subscription with one teardown.
 *
 * This exists because the account-switch watcher was, in practice, not watching. It read
 * the connected address on render and compared it to the session — correct logic, driven
 * by nothing: with no subscription of our own, a switch made in the extension only reached
 * the app if something else happened to re-render the tree. Between the switch and the
 * next full page load the session stayed live and every authenticated request was served
 * as the *previous* address. The fix is not more comparing, it is being told.
 *
 * Three channels, deliberately overlapping — a missed switch is a wrong-identity session,
 * so redundancy is the point:
 *
 * 1. **The plugin store** (`client.wallet.subscribe`). The store attaches one
 *    `standard:events` `change` subscription per discovered wallet and reconciles the
 *    active account from it, so this is that event, fanned out.
 * 2. **The wallet's own `standard:events`**, resolved from the handle with
 *    `getWalletFeature`. A wallet without the feature is simply not attached to — never a
 *    throw, never a missing channel for the others.
 * 3. **Refocus** (`visibilitychange` / `focus`). The backstop for a wallet whose change
 *    event is unreliable or never arrives: coming back to the tab re-reads the wallet.
 *
 * Nothing here decides anything. It reports what the extension says; `account-switch.ts`
 * decides what that means, and only the server can act on it.
 */

const STANDARD_EVENTS_FEATURE = 'standard:events';

type Unsubscribe = () => void;

/** The `standard:events` feature, narrowed to the one method we use. */
interface StandardEventsFeature {
  on: (event: 'change', listener: () => void) => Unsubscribe;
}

/**
 * The address the extension reports *right now*, read straight from the store rather than
 * from a React snapshot — this is what the refocus backstop re-reads, and what every
 * comparison against the session is made from.
 */
export function readActiveAddress(client: ClientWithWallet): string | null {
  return client.wallet.getState().connected?.account.address ?? null;
}

function isStandardEventsFeature(value: unknown): value is StandardEventsFeature {
  return typeof (value as StandardEventsFeature | undefined)?.on === 'function';
}

/**
 * The wallet's `standard:events` implementation, or `null` when the wallet has none.
 *
 * A `UiWallet` handle carries feature *names* only; `getWalletFeature` resolves one to the
 * implementation on the underlying wallet-standard `Wallet`, and *throws* when the wallet
 * does not implement it. So the handle's own feature list is asked first: a wallet without
 * the feature degrades to "one fewer channel" — it is still covered by the store channel
 * and by refocus — never to a crash that takes the other channels down with it.
 */
function standardEventsOf(wallet: UiWallet): StandardEventsFeature | null {
  if (!wallet.features.includes(STANDARD_EVENTS_FEATURE)) {
    return null;
  }

  const feature = getWalletFeature(wallet, STANDARD_EVENTS_FEATURE);

  return isStandardEventsFeature(feature) ? feature : null;
}

interface WalletEventSubscriptions {
  /** Attaches to wallets that have appeared, drops those that are gone. Idempotent. */
  sync: () => void;
  dispose: Unsubscribe;
}

/**
 * One `change` subscription per discovered wallet, keyed by name.
 *
 * Wallets register asynchronously, so the set is re-synced whenever the store reports a
 * change rather than only at mount. Keying by name is what makes that safe to call on
 * every notification: an already-attached wallet is skipped, so no re-render or repeated
 * sync can double-subscribe.
 */
function createWalletEventSubscriptions(
  client: ClientWithWallet,
  onChange: () => void,
): WalletEventSubscriptions {
  const attached = new Map<string, Unsubscribe>();

  return {
    sync: () => {
      const wallets = client.wallet.getState().wallets;
      const present = new Set(wallets.map((wallet) => wallet.name));

      for (const [name, unsubscribe] of attached) {
        if (!present.has(name)) {
          unsubscribe();
          attached.delete(name);
        }
      }

      for (const wallet of wallets) {
        if (attached.has(wallet.name)) {
          continue;
        }

        const events = standardEventsOf(wallet);

        if (events) {
          attached.set(wallet.name, events.on('change', onChange));
        }
      }
    },
    dispose: () => {
      for (const unsubscribe of attached.values()) {
        unsubscribe();
      }

      attached.clear();
    },
  };
}

/**
 * The backstop. A wallet whose `change` event is unreliable still cannot hide a switch
 * across a tab switch — returning to the page re-reads the extension.
 *
 * No-ops outside the browser (SSR) rather than guarding at every call site.
 */
function subscribeToRefocus(onChange: () => void): Unsubscribe {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => {};
  }

  const onVisible = () => {
    if (document.visibilityState === 'visible') {
      onChange();
    }
  };

  window.addEventListener('focus', onChange);
  document.addEventListener('visibilitychange', onVisible);

  return () => {
    window.removeEventListener('focus', onChange);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

/**
 * Subscribes to every account-change channel at once.
 *
 * `onChange` is a notification, not a value: it says "re-read the wallet", and may fire
 * when nothing has actually changed. Callers compare against the session themselves.
 *
 * @returns An unsubscribe that tears down all three channels. Safe to call more than once.
 */
export function subscribeToWalletAccountChanges(
  client: ClientWithWallet,
  onChange: () => void,
): Unsubscribe {
  const walletEvents = createWalletEventSubscriptions(client, onChange);

  // The store notification is also how a newly registered wallet reaches us, so the
  // per-wallet subscriptions are reconciled before the caller is told anything.
  const unsubscribeStore = client.wallet.subscribe(() => {
    walletEvents.sync();
    onChange();
  });
  const unsubscribeRefocus = subscribeToRefocus(onChange);

  walletEvents.sync();

  return () => {
    unsubscribeStore();
    walletEvents.dispose();
    unsubscribeRefocus();
  };
}
