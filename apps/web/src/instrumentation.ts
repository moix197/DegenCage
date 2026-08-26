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
}

export { onRequestError };
