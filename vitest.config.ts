import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// One shared runner for the whole workspace: `pnpm test` at the root covers
// `apps/web` and `packages/rules` alike. Both are Node-side today; a browser
// environment gets added per-project only when a component test needs it.
export default defineConfig({
  resolve: {
    // Mirrors `apps/web/tsconfig.json`'s `"@/*": ["./src/*"]` — Vite/Vitest does not read
    // tsconfig `paths` on its own (no `vite-tsconfig-paths` plugin here), so without this a
    // route/page importing `@/...` fails to resolve under Vitest even though `next build`
    // resolves it fine. See `.ai/decisions/migration-and-test-tooling.md`.
    alias: {
      '@': fileURLToPath(new URL('./apps/web/src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['apps/web/src/**/*.test.ts', 'packages/rules/src/**/*.test.ts'],
  },
});
