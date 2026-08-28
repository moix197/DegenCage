# Phase 1 research — wallet/session/UI surface

## 1. Wallet client (`apps/web/src/client/wallet/`)

Library: **`@solana/kit` 8.0.0 + `@solana/kit-plugin-wallet` 0.18.0** (Anza's kit-plugins,
pre-1.0) + `@solana/react` 8.0.0, over wallet-standard (`@wallet-standard/ui` 1.0.3 pinned
exact, `@solana/wallet-standard-features`, `@solana/wallet-standard-util`). **Not**
`@solana/wallet-adapter-react`.

Client construction — the only place a Kit client exists (`wallet-provider.tsx:36`):

```ts
createClient().use(walletSigner({ chain: 'solana:mainnet' }))
```

Note: **no RPC plugin** is installed on the client. The browser has no Solana RPC endpoint
at all; `HELIUS_API_KEY` is server-only (`server/chain/helius-client.ts`). There is no
`NEXT_PUBLIC_` RPC var.

### Signing surface — what exists today vs. what Phase 1 needs

`@solana/kit-plugin-wallet/react` exports exactly these hooks (verified against
`dist/types/react/index.d.ts`):

`useWalletStatus`, `useConnectedWallet`, `useReconnectingAccount`, `useWallets`,
`useIsWalletReady`, `useConnect`, `useDisconnect`, `useSignIn`, `useSignMessage`,
`useSelectAccount`, plus the `<WalletReadyGate>` component.

**There is no `useSignTransaction` and no `useSignAndSendTransaction` hook.** Phase 0 uses
only `useSignIn` / `useConnect` / `useSignMessage` — message signing for SIWS.

Transaction signing is nonetheless available, one level down, via the store rather than a
hook. `client.wallet.getState().connected` is:

```ts
{ account: UiWalletAccount; signer: WalletSigner | null; wallet: UiWallet }
```

and `WalletSigner = TransactionSigner | (MessageSigner & TransactionSigner)` from
`@solana/kit`. So:

- The signer **always satisfies Kit's `TransactionSigner`** when non-null.
- `signer` is `null` for read-only/watch-only wallets — the swap UI must handle that.
- Concretely the signer is produced by `createSignerFromWalletAccount` for the configured
  chain, so it will be a `TransactionSendingSigner` when the wallet implements
  `solana:signAndSendTransaction`, and a `TransactionModifyingSigner` /
  `TransactionPartialSigner` when it only implements `solana:signTransaction`. Kit's
  `signAndSendTransactionMessageWithSigners` / `signTransactionMessageWithSigners` are the
  idiomatic call sites. **Which one a given wallet supports must be feature-detected**
  (`wallet.features.includes('solana:signAndSendTransaction')`) — `walletSigner`'s
  `filter` option even documents that exact predicate.
- `useConnectedWallet(client)` is the React-safe way to read that connected object
  (subscribes via `useSyncExternalStore`).

Phase 1 will therefore add the *first* transaction-signing code in the repo. Per
`.ai/decisions/wallet-standard-ui-dependency.md`, all contact with wallet libraries is
deliberately confined to `src/client/wallet/` + `src/server/auth/solana-siws.ts` so a
pre-1.0 break is a two-file change — new signing code belongs inside `src/client/wallet/`
(e.g. a `use-swap-signing.ts` sibling to `use-wallet-session.ts`), not in a page.

### Account-switch machinery (reusable, and a hazard)

- `wallet-account-watch.ts` — `subscribeToWalletAccountChanges(client, notify)` +
  `readActiveAddress(client)`; three channels (plugin store fan-out, per-wallet
  `standard:events` resolved with `getWalletFeature`, `focus`/`visibilitychange` backstop).
- `account-switch.ts` — pure `decideReauth({ sessionAddress, observedAddress,
  hasObservedWallet, isSigningIn, signedInAddress }) → { trigger, shouldRevoke }`.
- `use-wallet-session.ts` — on mismatch calls `revokeCurrentSession(trigger)` then
  `router.refresh()`. **A mid-swap account switch will therefore revoke the session
  underneath an in-flight quote/approval.** `.ai/decisions/wallet-account-switch-desync.md`
  is explicit: switch detection is unreliable, session identity can lag, and "signing is
  the only identity check that holds during the window."
- `session-api.ts` — every `/api/auth/*` call; any response it can't read as success is a
  failure.

Reusable pattern for a swap: the connected account address must be re-read *after* the
wallet prompt and compared to what was quoted/approved — `signInByMessage`
(`use-wallet-session.ts:208-232`) already does exactly this for SIWS and is the template.

## 2. Server auth (`apps/web/src/server/auth/`)

- `resolveSession()` (`session.ts`) is the **only** source of caller identity. Returns
  `{ userId, walletId, walletAddress, ... } | null`. Reads the `degencage_session`
  httpOnly cookie (opaque 32-byte base64url; SHA-256 hash stored as the `sessions` PK);
  30-day sliding TTL inside a 90-day absolute cap; fails closed to `null` on any error.
- **Invariant: no route may take a wallet id or address from a request body.** A swap
  route derives the wallet from `resolveSession()` and nothing else. `resolveSession(...,
  { slideExpiry: false })` exists for callers that only identify in order to revoke.
- Kill switch: `WALLET_CONNECT_FLAG` = `auth.wallet_connect`.
- Full detail: `apps/web/src/server/auth/README.md`.

## 3. App Router conventions

Pages: `app/page.tsx`, `app/connect/page.tsx`, `app/constitution/page.tsx` (+
`constitution-panel.tsx`), `app/constitution/edit/page.tsx`, `app/dashboard/page.tsx` (+
`dashboard-panel.tsx`, `feedback-prompt.tsx`), `app/admin/login/page.tsx`,
`app/admin/metrics/page.tsx`.

API routes: `api/auth/nonce`, `api/auth/verify`, `api/constitution` (+ `/commit`,
`/activate`), `api/dashboard`, `api/feedback`, `api/wallet/reconcile`, `api/admin/{login,
logout,metrics}`.

### Route handler shape (uniform across every route)

```ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const correlationId = randomUUID();                 // node:crypto, minted per request
  if (!(await isFeatureEnabled(FLAG))) return Response.json({ error: '<flag>_disabled', correlationId }, { status: 503 });
  const body = await request.json().catch(() => null);
  if (!isValid(body)) return Response.json({ error: 'invalid_x', correlationId }, { status: 400 });
  const session = await resolveSession();
  if (!session) return Response.json({ error: 'unauthenticated', correlationId }, { status: 401 });
  try { ... return Response.json(payload); }
  catch (error) {
    if (error instanceof DomainRejected) return Response.json({ error: error.reason, correlationId }, { status: httpStatusFor(error.reason) });
    captureError(error, { correlationId, route: 'x.post' });
    return Response.json({ error: 'x_unavailable', correlationId }, { status: 503 });   // fail closed
  }
}
```

Error shape is always `{ error: '<snake_case_reason>', correlationId }`. Correlation ids
are **minted in the route** with `randomUUID()` (never accepted from the client) and passed
down into every server function and `recordEvent()`/`captureError()` call. Domain modules
throw a typed `XRejected` carrying a `reason`, plus a `httpStatusForXRejection(reason)`
mapper — see `server/feedback/feedback.ts` and `server/constitution/pending-changes.ts`.

### Server action vs route handler

Per `.ai/decisions/server-actions-for-constitution-edit.md` and the header comment in
`app/constitution/edit/page.tsx`: **inline `'use server'` actions** when the surface is
plain `<form>` submits with no client state (rejections surface via `redirect('?error=…')`);
**route handler** when a client component needs to call it (polling, JSON, optimistic UI).
The only server actions in the tree are the two in `constitution/edit/page.tsx:93,122`.

A swap terminal has real client state (quote refresh, in-flight signing) → route handler.

### Page conventions

Every page: `export const dynamic = 'force-dynamic'; export const runtime = 'nodejs';`,
`resolveSession()` + `isFeatureEnabled()` in one `Promise.all`, then three explicit
render branches — flag-off ("switched off right now. Nothing is wrong with your wallet."),
no-session (link to `/connect`), and the real content. Server component does the fetching
and passes an `initial` prop to a `'use client'` panel.

There is **no shared app shell / nav** — each page renders its own `<main>` and `<h1>`.

## 4. UI stack

Tailwind **v4** (`@tailwindcss/postcss`, no `tailwind.config` file — CSS-first via
`@import 'tailwindcss'` in `src/app/globals.css`) + shadcn/ui, style `base-nova`, baseColor
`neutral`, icon library `lucide` (`components.json`). Primitives from `@base-ui/react`
(not Radix). `cn()` at `src/lib/utils.ts`.

**`src/components/ui/` inventory (6 files only):** `alert.tsx`, `badge.tsx`, `button.tsx`,
`card.tsx`, `separator.tsx`, `table.tsx`.

**Missing for a swap form:** `input`, `label`, `form`, `select` (or `combobox` +
`command`/`popover` for token search), `dialog`/`drawer` (confirm + blocked-trade modal),
`skeleton` (referenced in the ui-framework decision but never actually added),
`tooltip`, `sonner`/`toast`, `tabs`, `slider` (percentage amount), `avatar` (token logos).
Add via `pnpm dlx shadcn@latest add <name>` — **never hand-copied** (hard constraint in
`.ai/decisions/ui-framework.md`), and each new transitive `@base-ui/react` dep must be
declared explicitly in `apps/web/package.json`.

**Tokens** (`globals.css`): standard shadcn set — `--background`, `--foreground`, `--card`,
`--popover`, `--primary`, `--secondary`, `--muted`, `--accent`, `--destructive`, `--border`,
`--input`, `--ring`, `--chart-1..5`, `--sidebar-*`, `--radius: 0.625rem` with derived
`--radius-sm..4xl`. Dark palette under `.dark`, `@custom-variant dark (&:is(.dark *))`.

**Theming conflict, load-bearing:** `layout.tsx`'s `<body>` has a hard-coded inline
`style={{ background: '#0b0b0f', color: '#e6e6ea', fontFamily: monospace, padding: '3rem 1.5rem' }}`
— a dark page body — while `.dark` is **never applied to `<html>`**, so every shadcn
component renders its *light* palette on a dark background. The `ui-framework` decision
acknowledges the inline style "keeps winning on specificity" but does not address the
palette mismatch. Font is `Geist` via `next/font/google` bound to `--font-sans`, but the
body's inline monospace `fontFamily` overrides it.

Layout pattern from the dashboard: `<main className="mx-auto flex max-w-3xl flex-col gap-6">`,
card grid `grid grid-cols-1 gap-4 sm:grid-cols-3`.

## 5. Client data fetching / refresh

No SWR, no React Query, no tRPC — **plain `fetch` + `setInterval`** in a `'use client'`
panel seeded by an `initial` prop from the server component.

`dashboard-panel.tsx`: `POLL_INTERVAL_MS = 15_000`; `fetch('/api/dashboard', { cache:
'no-store' })`; on `!response.ok` or throw → set a `refreshFailed` banner and report, but
**never clear `data`** (state only moves forward to a newer successful response);
`reportRefreshFailure()` lazily `import('@/observability/error-tracking')` so Sentry's
browser SDK stays out of the initial bundle, with a `console.error` fallback if that
dynamic import itself fails.

`constitution-panel.tsx` uses the same shape for its commitment-window countdown — and per
`.ai/decisions/commitment-window-server-clock.md`, **client countdowns are display only**;
the deadline is always the server's/DB's `now()`. Same rule will apply to a quote's
expiry/slippage countdown.

Server-side refresh triggers exist too: `dashboard/page.tsx` calls `reconcileWallet()` and
`applyDuePendingChanges()` in-request on app open (no scheduler, no worker).

## Observability expectations for Phase 1

`recordEvent()` (`src/observability/events.ts`) is the sole write path into `events`;
`observed_at` is server-stamped; pass the open transaction to make the event atomic with
the state change. Existing names are dotted: `auth.session_created`,
`rule.decision_recorded`, `dashboard.viewed`, `feedback.submitted`. A swap will need its
own family (`swap.quote_requested`, `swap.blocked`, `swap.submitted`, …) plus a
`jupiter.*` kill switch flag seeded in `server/db/seed.ts`.
