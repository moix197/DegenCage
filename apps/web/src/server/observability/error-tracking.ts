import * as Sentry from '@sentry/nextjs';

import { logger, type LogFields } from './logger';

/**
 * The one error-tracking entry point. Nothing else imports `@sentry/nextjs`.
 *
 * Every captured error is *also* logged, so a missing/misconfigured `SENTRY_DSN`
 * degrades to "less searchable", never to a silent failure (CLAUDE.md →
 * Observability: no swallowed errors).
 */
export function captureError(error: unknown, fields: LogFields = {}): void {
  logger.error(error instanceof Error ? error.message : String(error), {
    ...fields,
    errorName: error instanceof Error ? error.name : typeof error,
    stack: error instanceof Error ? error.stack : undefined,
  });

  Sentry.captureException(error, { extra: fields });
}
