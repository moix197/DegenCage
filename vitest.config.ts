import { defineConfig } from 'vitest/config';

// One shared runner for the whole workspace: `pnpm test` at the root covers
// `apps/web` and `packages/rules` alike. Both are Node-side today; a browser
// environment gets added per-project only when a component test needs it.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/web/src/**/*.test.ts', 'packages/rules/src/**/*.test.ts'],
  },
});
