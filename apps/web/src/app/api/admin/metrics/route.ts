import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import { captureError } from '../../../../observability/error-tracking';
import { logger } from '../../../../observability/logger';
import { buildMetricsSnapshot } from '../../../../server/metrics/queries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Internal-only: every Phase 0 success signal, computed live. No RBAC system exists yet
 * (decision 11 — open connect, no accounts/roles), so this is deliberately minimal: a
 * shared-secret header, not a session or a role.
 *
 * Missing/wrong secret answers **404, not 403** — a 403 would confirm to an unauthenticated
 * caller that this route exists at all; 404 makes it indistinguishable from a path that was
 * never registered. See `.ai/decisions/admin-metrics-secret-gate.md`.
 */

const ADMIN_METRICS_SECRET_HEADER = 'x-admin-metrics-secret';

/**
 * `timingSafeEqual` throws on a length mismatch rather than returning `false` — hashing both
 * sides first normalizes them to the same length before the constant-time comparison, so a
 * caller who sends a shorter/longer guess doesn't get a fast-fail that itself leaks a timing
 * signal about the secret's length.
 */
function secretsMatch(provided: string, expected: string): boolean {
  const providedDigest = createHash('sha256').update(provided).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();

  return timingSafeEqual(providedDigest, expectedDigest);
}

function isAuthorized(request: Request): boolean {
  const expected = process.env.ADMIN_METRICS_SECRET;
  const provided = request.headers.get(ADMIN_METRICS_SECRET_HEADER);

  // Unset `ADMIN_METRICS_SECRET` fails closed too — there is nothing valid to compare
  // against, so every caller (including one who sends nothing) is unauthorized.
  if (!expected || !provided) {
    return false;
  }

  return secretsMatch(provided, expected);
}

export async function GET(request: Request): Promise<Response> {
  const correlationId = randomUUID();

  if (!isAuthorized(request)) {
    logger.warn('admin metrics access denied', { correlationId });

    return new Response(null, { status: 404 });
  }

  try {
    const snapshot = await buildMetricsSnapshot(new Date());

    return Response.json({ ...snapshot, correlationId });
  } catch (error) {
    captureError(error, { correlationId, route: 'admin.metrics' });

    return Response.json({ error: 'metrics_unavailable', correlationId }, { status: 503 });
  }
}
