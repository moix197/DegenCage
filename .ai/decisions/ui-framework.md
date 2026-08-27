# Tailwind CSS + shadcn/ui for web UI

**Decision:** `apps/web` adopts Tailwind CSS v4 (via `@tailwindcss/postcss`) and shadcn/ui
as its component layer, initialized with `pnpm dlx shadcn@latest init` and components added
one at a time with `pnpm dlx shadcn@latest add <name>` — `card`, `badge`, `table`,
`separator`, `skeleton`, `alert` to start (Phase 7's dashboard), more only as a real screen
needs them.

**Why:** Every screen shipped through Phase 6 (`/`, `/connect`, `/constitution`, and the
Phase 4–6 status page since renamed to `/dashboard`) hand-rolls its markup with inline
`style={{}}` objects — fine for a handful of status paragraphs and a form, but Phase 7's
dashboard is the first screen with real layout: cards, a table-shaped violations feed,
badges for tier/verdict state, loading skeletons for the live-polled figures. Building that
from scratch in inline styles is where "no CSS framework" stops paying for itself and
starts costing real time per screen, with no consistency guarantee between them.

Tailwind is the smallest, most widely adopted answer to "utility classes instead of
per-element style objects," and shadcn/ui rides on top of it rather than being a second,
competing choice: **shadcn components are copied into `src/components/ui/` as source we
own, not a package we depend on and can't touch.** No new runtime dependency owns our
markup — `@base-ui/react` (the primitives shadcn wraps for accessible behavior: focus
management, keyboard nav, ARIA — shadcn's own move away from Radix, not our choice to
diverge from it) and `class-variance-authority`/`clsx`/`tailwind-merge` (variant and
class-merging plumbing) are the only new dependencies with actual code in the tree, and all
four are mature, narrowly-scoped, and exactly the kind of "don't hand-roll this" case
CLAUDE.md's Architecture section already calls out for anything that isn't the product's
differentiator. The rule engine, commitment logic, and violation detection stay ours; a
`<Card>` and a `<Table>` never were.

**Rejected:**

- **Keep hand-rolling inline styles.** Works at Phase 0–6's scale (a handful of paragraphs
  per page) but does not scale to a dashboard with cards, a feed, and live-updating state —
  every new element needs a bespoke style object, and nothing enforces visual consistency
  across screens.
- **A different headless/component kit (Radix directly, Headless UI, Ark UI).** shadcn/ui
  already wraps a headless primitives library (`@base-ui/react`) underneath; picking shadcn
  gets the same accessible primitives plus a CLI that generates readable, editable source
  instead of a black-box component package. Nothing else in that space offers "copied-in
  source we own" as the default.
- **CSS Modules or vanilla CSS with a small utility layer.** Viable, but reinvents a
  chunk of what Tailwind already gives for free (a constrained scale, dark-mode variants,
  responsive prefixes) with no ecosystem of pre-built accessible components on top.

**Constraints it creates:**

- **`apps/web/src/app/layout.tsx` now imports `./globals.css`.** Required for Tailwind's
  utility classes to resolve anywhere in the app, including on pages that don't otherwise
  use them. The existing inline `style={{}}` on `<body>` is untouched and keeps winning on
  specificity (inline style beats the `@layer base` rules Tailwind adds), so this import
  causes no visible change to `/`, `/connect`, or `/constitution`.
- **Existing inline-style pages (`app/page.tsx`, `constitution/constitution-panel.tsx`) are
  left exactly as they are.** They are not
  migrated to Tailwind/shadcn as part of this change — that is a separate, opportunistic
  cleanup, done page-by-page when a page is touched for other reasons anyway, never a
  standing "port everything now" task.
- **New screens use Tailwind + shadcn primitives; do not add new inline `style={{}}`
  screens going forward.** Phase 7's dashboard is the first to follow this.
- **Component additions go through the shadcn CLI (`pnpm dlx shadcn@latest add <name>`),
  never hand-copied from the docs site.** Keeps `components.json`'s registry config, the
  generated file set, and dependency versions consistent with what the CLI expects to
  manage on a future `diff`/update.
- **`tailwindcss`, `@tailwindcss/postcss`, `postcss`, `tw-animate-css`, `lucide-react`,
  `class-variance-authority`, `clsx`, `tailwind-merge`, and the `@base-ui/react` packages a
  given shadcn component pulls in are real dependencies of `apps/web`, declared explicitly**
  — same discipline as [wallet-standard-ui-dependency](wallet-standard-ui-dependency.md): no
  phantom hoisted imports. `shadcn` (the CLI) and `postcss` (a build-time-only tool, never
  imported at runtime) are `devDependencies`; everything else here ships in the bundle.
