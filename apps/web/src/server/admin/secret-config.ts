import { logger } from '../../observability/logger';

/**
 * `ADMIN_METRICS_SECRET` env-var reading and validation — split out from `./access` so this
 * stays importable from `src/instrumentation.ts`'s edge bundle. `./access` pulls in
 * `node:crypto` for its signing/comparison primitives, which the edge runtime cannot resolve;
 * this module only ever touches `process.env` and string length, so it is safe in both
 * runtimes and can be imported unconditionally.
 */

/**
 * Below this length, `ADMIN_METRICS_SECRET` is treated as **not configured at all** — the
 * gate refuses everyone, including whoever holds the weak value, rather than accept a
 * guessable one. 32 characters is a floor, not a target: generate with `openssl rand -base64
 * 32` (or equivalent), never a memorized phrase — see `.env.example`.
 */
export const MIN_ADMIN_SECRET_LENGTH = 32;

/**
 * The one place that reads `ADMIN_METRICS_SECRET` from the environment. Every gate calls
 * this rather than `process.env.ADMIN_METRICS_SECRET` directly, so a too-short value is
 * treated identically to an unset one everywhere at once — never valid in one check and
 * silently accepted in another.
 */
export function getConfiguredAdminSecret(): string | undefined {
  const secret = process.env.ADMIN_METRICS_SECRET;

  if (!secret || secret.length < MIN_ADMIN_SECRET_LENGTH) {
    return undefined;
  }

  return secret;
}

/**
 * Logged once at process startup (`instrumentation.ts`) — a weak/missing secret does not
 * crash the app (an admin-only surface failing closed is not worth taking the whole product
 * down for), but it must be visible in logs immediately, not discovered later while
 * debugging why `/api/admin/metrics` 404s for everyone including the real secret.
 */
export function warnIfAdminSecretMisconfigured(): void {
  const raw = process.env.ADMIN_METRICS_SECRET;

  if (!raw) {
    logger.warn('ADMIN_METRICS_SECRET is not set — the admin gate refuses every caller until it is');
    return;
  }

  if (raw.length < MIN_ADMIN_SECRET_LENGTH) {
    logger.warn('ADMIN_METRICS_SECRET is shorter than the minimum length — the admin gate refuses every caller, including the real value, until a stronger secret is set', {
      length: raw.length,
      minimumLength: MIN_ADMIN_SECRET_LENGTH,
    });
  }
}
