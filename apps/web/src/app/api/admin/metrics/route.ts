import { randomUUID } from 'node:crypto';

import { captureError } from '@/observability/error-tracking';
import { logger } from '@/observability/logger';
import { hasValidAdminSecretHeader } from '@/server/admin/access';
import { buildMetricsSnapshot } from '@/server/metrics/queries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Internal-only, programmatic access to every Phase 0 success signal: `x-admin-metrics-secret`
 * header, checked via `hasValidAdminSecretHeader` (`server/admin/access.ts`) — the same
 * constant-time comparison `api/admin/login/route.ts` uses for the browser-facing cookie flow.
 * No RBAC system exists yet (decision 11 — open connect, no accounts/roles), so this is
 * deliberately minimal: a shared secret, not a session or a role.
 *
 * Missing/wrong secret, and every non-GET method, answer the identical 404 — never 403/401,
 * and never an auto-405 (which would itself confirm this route exists via its `Allow` header
 * regardless of auth). See `.ai/decisions/admin-metrics-secret-gate.md`.
 */

/**
 * A generic, minimal not-found body/content-type — not a byte-for-byte copy of Next's own
 * themed 404 page (that would be brittle across Next versions and is not the property this
 * gate needs). The property that matters: no response from this route is distinguishable, by
 * header shape or status code, from "this path was never registered" — no JSON error object,
 * no correlation id, no `Allow` header.
 */
function notFoundResponse(): Response {
  return new Response('404 - This page could not be found.', {
    status: 404,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

async function handleRequest(request: Request): Promise<Response> {
  const correlationId = randomUUID();

  // Every method funnels through the same check, including GET: a correct secret on a
  // non-GET method still 404s (nothing but GET is a legitimate operation here), so exporting
  // every method below never lets Next's auto-405/`Allow` fallback fire for this route at all.
  if (!hasValidAdminSecretHeader(request) || request.method !== 'GET') {
    logger.warn('admin metrics access denied', { correlationId, method: request.method });

    return notFoundResponse();
  }

  try {
    const snapshot = await buildMetricsSnapshot(new Date());

    return Response.json({ ...snapshot, correlationId });
  } catch (error) {
    captureError(error, { correlationId, route: 'admin.metrics' });

    return Response.json({ error: 'metrics_unavailable', correlationId }, { status: 503 });
  }
}

export const GET = handleRequest;
export const POST = handleRequest;
export const PUT = handleRequest;
export const PATCH = handleRequest;
export const DELETE = handleRequest;
export const HEAD = handleRequest;
export const OPTIONS = handleRequest;
