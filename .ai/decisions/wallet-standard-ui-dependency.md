# `@wallet-standard/ui` is a declared dependency, not a phantom import

**Decision:** `apps/web` declares `@wallet-standard/ui` at exactly `1.0.3` — the version
already resolved transitively through `@solana/kit-plugin-wallet` and `@solana/react` — and
`src/client/wallet/wallet-account-watch.ts` resolves a wallet's `standard:events`
implementation with its `getWalletFeature`, replacing a duck-typed lookup on the handle's
`features`.

**Why:** `nodeLinker: hoisted` (see [monorepo-package-shape](monorepo-package-shape.md) and
`apps/web/README.md`) means pnpm no longer catches undeclared dependencies: importing a
package that happens to be hoisted works until a transitive bump moves it, and then a clean
install fails. Every package we import is declared in the importing workspace, and that rule
is what pinned the version — matching the already-resolved one keeps this a declaration of
an existing fact rather than a second copy in the tree.

The functional half: the Kit plugin hands us `UiWallet` handles, which carry feature
*names* only. Duck-typing `features` for an object with an `on` method therefore never
found the implementation on those handles at all, so the per-wallet `standard:events`
channel — one of the three the account-switch watcher depends on — silently did not exist.
`getWalletFeature` resolves the name against the underlying wallet-standard `Wallet`.

Exact version, no caret: this is a pre-1.x-adjacent wallet-standard package reached in the
same tree as `@solana/kit`, and a floating range that drifts off the transitively resolved
version reintroduces the duplicate it was declared to avoid.

**Rejected:**

- **Keep duck-typing `features`** — misses `UiWallet` handles entirely, which is the whole
  reason the channel was dead.
- **Rely on the phantom import** — works only by accident of hoisting; a clean-install
  failure waiting to happen.
- **A caret range** — risks resolving a second copy alongside the transitively pinned one.

**Constraints it creates:**

- `getWalletFeature` **throws** `WalletStandardError` on a feature the wallet does not
  implement, so the handle's own `features.includes(...)` is checked first. A wallet
  without `standard:events` must degrade to one fewer channel — the store fan-out and the
  refocus backstop still cover it — never to a throw that takes the other channels down.
- Contact with the wallet libraries stays confined to `src/client/wallet/` and
  `src/server/auth/solana-siws.ts`, so a pre-1.0 breaking release stays a two-file change.
