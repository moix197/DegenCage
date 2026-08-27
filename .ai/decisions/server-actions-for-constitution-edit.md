# `/constitution/edit` mutates via Server Actions, not API routes + client fetch

**Decision:** `apps/web/src/app/constitution/edit/page.tsx` is a single Server Component. Its
two mutations — request a limit change, cancel a pending increase — are inline Next.js Server
Actions (`'use server'` functions in the same file, bound to `<form action={...}>`), not a new
`route.ts` under `app/api/` called from a `'use client'` panel the way `/constitution` and
`/dashboard` do it today. No client JavaScript ships for this page at all.

**Why:** Every other mutating surface in this codebase (`/api/constitution`,
`/api/constitution/commit`, `/api/constitution/activate`, `/api/wallet/reconcile`) follows the
same shape: a thin `route.ts` that reads `resolveSession()`, checks a feature flag, calls into
`server/*`, and wraps the result as `{data}` or `{error, correlationId}` — then a `'use client'`
panel (`constitution-panel.tsx`, `dashboard-panel.tsx`) that `fetch()`s it. That pattern earns
its keep when a page needs *live* client state — `constitution-panel.tsx` polls
`GET /api/constitution` every 5s to drive the commitment countdown, which only a client
component can do. `/constitution/edit` has no such state: "decrease applied" and "increase
pending, effective at `<timestamp>`" are both facts fully known at request time, and the two
actions are ordinary form submits with nothing to poll afterward. Standing up a route file, a
JSON contract, and a client panel to fetch it would be three moving pieces reproducing what one
Server Component + two inline actions already do, for a page that never needs a re-render the
server didn't already trigger.

There is also no shared middleware or wrapper layer behind the existing API routes to lose by
skipping them — each route repeats the same three lines (`resolveSession()`, `isFeatureEnabled`,
try/catch → `captureError`) by hand; nothing generic sits in front of `app/api/*` that a Server
Action would otherwise have to reimplement. And this is not a new pattern in this codebase:
`apps/web/src/app/dashboard/page.tsx:122–143` already mutates from a Server Component today —
`reconcileWallet()` runs inline in `DashboardPage`'s render, wrapped in the same
try/catch-then-`captureError` shape used here. `/constitution/edit` extends that precedent to a
*user-triggered* mutation (a form submit) rather than an *automatic* one (page load), via the
same Next.js primitive (`'use server'`) that already ships in this app's dependency graph —
nothing new is added.

**Identity, flags, and error handling all still go through the exact same functions** the API
routes use — `resolveSession()` (indirectly, inside `requestLimitChange`/`cancelPendingChange`
themselves), `isFeatureEnabled(CONSTITUTION_AUTHOR_FLAG)`, `captureError`. Choosing Server
Actions over a route changes *how the client reaches the server*, not *what runs once it gets
there* — every invariant in `server/constitution/*` (session-derived identity only, fail-closed
flag checks, no silent catches) applies identically either way.

**Rejected:**

- **A new `app/api/constitution/pending-changes/*` route pair, fetched from a client panel** —
  matches every existing page's shape, but adds a JSON contract, a client component, and a
  polling/refresh strategy for a page that needs none of the three. Also the option the Phase
  8 code review explicitly gated behind a STOP-and-report rather than silently doing — evaluated
  here and rejected on its merits, not skipped by default.
- **A shared middleware/wrapper for the API routes, then use it** — there isn't one to reuse;
  building it would be new scope motivated by this one page, not an existing pattern being
  extended.
- **Client-side interactivity (a `'use client'` panel) purely for a nicer submit experience** —
  nothing on this page needs it: no live countdown (the effective timestamp is static once
  rendered — `commitment-window-server-clock.md`'s "client countdowns are display only" applies
  with extra force here, since there is not even a countdown, just a fixed label), no optimistic
  UI the product's "friction, not speed" framing would want anyway.

**Constraints it creates:**

- **Every rejection must cross the redirect boundary as a URL, not a JSON body.** A Server
  Action can't hand a value back to the *next* render directly; this page's error path is
  `redirect('/constitution/edit?error=<reason>&correlationId=<id>')`, read back via
  `searchParams` on the next render (`errorRedirectUrl`/`describeRejection` in `page.tsx`).
  Both `error` and `correlationId` travel together — dropping either breaks either the
  human-readable message or the traceability CLAUDE.md requires end-to-end.
- **No optimistic UI, no partial re-render** — a form submit is a full server round trip
  (`revalidatePath` + the implicit navigation a Server Action triggers). Acceptable here
  precisely because there is nothing time-sensitive to optimize for; would not be the right
  call for a page that needed sub-second feedback.
- **If a future consumer needs the JSON contract** (a mobile client, a third-party
  integration), *that* is when `/api/constitution/pending-changes/*` gets built — against a
  real second caller, not speculatively for this page.
