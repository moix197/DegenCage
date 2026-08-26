import * as Sentry from '@sentry/nextjs';

import { logger, type LogFields } from './logger';

/**
 * The one error-tracking entry point. Nothing else imports `@sentry/nextjs` — not the
 * call sites, and not the Next.js instrumentation hooks, which delegate to
 * `initErrorTracking` / `onRequestError` below (`.ai/decisions/observability-stack.md`).
 *
 * Every captured error is *also* logged, so a missing/misconfigured DSN degrades to
 * "less searchable", never to a silent failure (CLAUDE.md → Observability).
 */

/** Which Next.js execution context is initialising — carried on the startup log line. */
export type Runtime = 'nodejs' | 'edge' | 'browser';

/**
 * Server and edge read `SENTRY_DSN`; the browser bundle can only see a `NEXT_PUBLIC_`
 * var, so it reads that one. Both unset is a supported (logged) configuration.
 */
function resolveDsn(runtime: Runtime): string | undefined {
  const dsn =
    runtime === 'browser' ? process.env.NEXT_PUBLIC_SENTRY_DSN : process.env.SENTRY_DSN;

  return dsn && dsn.length > 0 ? dsn : undefined;
}

let initialized = false;

/**
 * Called once per runtime from `src/instrumentation.ts` / `src/instrumentation-client.ts`.
 * Without this, `Sentry.captureException` silently no-ops even with a DSN configured.
 */
export function initErrorTracking(runtime: Runtime): void {
  if (initialized) return;
  initialized = true;

  const dsn = resolveDsn(runtime);

  if (!dsn) {
    // Visible, not silent: the no-op state is a deliberate configuration, and an operator
    // grepping for "why is Sentry empty" finds this line.
    logger.warn('error tracking disabled: no Sentry DSN configured, errors are logged only', {
      runtime,
    });
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    // Tracing is deferred until a second process exists to trace across; a correlation id
    // on every log line covers one app talking to one database.
    tracesSampleRate: 0,
  });

  logger.info('error tracking initialised', { runtime });
}

export function captureError(error: unknown, fields: LogFields = {}): void {
  logger.error(error instanceof Error ? error.message : String(error), {
    ...fields,
    errorName: error instanceof Error ? error.name : typeof error,
    stack: error instanceof Error ? error.stack : undefined,
  });

  Sentry.captureException(error, { extra: fields });
}

/**
 * `captureError` only queues the event; the transport sends it asynchronously. A short-lived
 * process (a script, a job) must await this before exiting or the report is dropped.
 * Long-running servers never need it — Sentry drains on its own.
 *
 * Resolves `false` if the queue did not drain within `timeoutMs`; with no DSN it is a no-op.
 */
export function flushErrorTracking(timeoutMs = 2_000): Promise<boolean> {
  return Sentry.flush(timeoutMs);
}

/** Next.js' server-side request-error hook, re-exported from `src/instrumentation.ts`. */
export const onRequestError = Sentry.captureRequestError;
