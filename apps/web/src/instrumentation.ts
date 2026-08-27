import { warnIfAdminSecretMisconfigured } from './server/admin/access';
import { initErrorTracking, onRequestError } from './observability/error-tracking';

/**
 * Next.js runs this once per server runtime, before any request is served — the only
 * place Sentry can be initialised for the Node and edge bundles.
 *
 * It imports the observability wrapper, never `@sentry/nextjs` directly
 * (`.ai/decisions/observability-stack.md`).
 */
export function register(): void {
  initErrorTracking(process.env.NEXT_RUNTIME === 'edge' ? 'edge' : 'nodejs');
  // A weak/missing ADMIN_METRICS_SECRET never crashes startup — it fails closed at the gate
  // itself, same as every other kill switch — but must be visible in logs immediately.
  warnIfAdminSecretMisconfigured();
}

export { onRequestError };
