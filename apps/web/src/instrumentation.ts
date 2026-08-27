import { initErrorTracking, onRequestError } from './observability/error-tracking';
// `./server/admin/secret-config`, not `./server/admin/access`: `access.ts` imports
// `node:crypto`, which the edge bundle can't resolve, and webpack still tries to build that
// module's edge chunk even behind a runtime-only branch or a dynamic `import()` (it can't
// prove the branch unreachable at compile time). `secret-config.ts` holds just the
// crypto-free pieces (env read + startup warning) and is safe to import unconditionally.
import { warnIfAdminSecretMisconfigured } from './server/admin/secret-config';

/**
 * Next.js runs this once per server runtime, before any request is served — the only
 * place Sentry can be initialised for the Node and edge bundles.
 *
 * It imports the observability wrapper, never `@sentry/nextjs` directly
 * (`.ai/decisions/observability-stack.md`).
 */
export function register(): void {
  const isEdge = process.env.NEXT_RUNTIME === 'edge';
  initErrorTracking(isEdge ? 'edge' : 'nodejs');

  if (!isEdge) {
    // A weak/missing ADMIN_METRICS_SECRET never crashes startup — it fails closed at the gate
    // itself, same as every other kill switch — but must be visible in logs immediately.
    warnIfAdminSecretMisconfigured();
  }
}

export { onRequestError };
