import { randomUUID } from 'node:crypto';

import { cookies } from 'next/headers';

import { captureError } from '@/observability/error-tracking';
import { recordEvent } from '@/observability/events';
import { logger } from '@/observability/logger';
import {
  ADMIN_SESSION_COOKIE_NAME,
  ADMIN_SESSION_TTL_MS,
  createAdminSessionCookieValue,
  getConfiguredAdminSecret,
  secretsMatch,
} from '@/server/admin/access';
import {
  AdminLoginRateLimited,
  assertWithinAdminLoginRateLimit,
  recordAdminLoginAttempt,
  recordRateLimitedLoginEventOnce,
} from '@/server/admin/login-rate-limit';
import { clientKeyForRequest } from '@/server/auth/challenge-rate-limit';
import { getDb } from '@/server/db/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Exchanges `ADMIN_METRICS_SECRET` for a signed, httpOnly, expiring session cookie —
 * what `admin/metrics/page.tsx` checks instead of a header a browser navigation can't send.
 * Plain `<form method="POST">`-compatible: accepts `application/x-www-form-urlencoded` or
 * JSON, and always redirects (303) rather than returning JSON, so it works with zero client
 * JS from `admin/login/page.tsx`.
 *
 * Rate limited per client (`server/admin/login-rate-limit.ts`), because unlike
 * `GET /api/admin/metrics` (obscured by the 404-not-403 gate), `admin/login/page.tsx` is a
 * public 200 page that necessarily advertises this endpoint's existence — the throttle, not
 * obscurity, is what makes online guessing against the secret infeasible here.
 */

/** Redirect locations are relative on purpose — `new URL(path, request.url)` would resolve against a caller-controlled `Host` header (Next.js does not verify it against a trusted proxy list here), letting a forged Host turn this into an open redirect. A relative `Location` is resolved by the browser against the origin it actually connected to, which a spoofed header cannot change. */
function relativeRedirect(path: string): Response {
  return new Response(null, { status: 303, headers: { location: path } });
}

async function readSecretFromRequest(request: Request): Promise<string | null> {
  const contentType = request.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    const body = await request.json().catch(() => null);

    return body && typeof body.secret === 'string' ? body.secret : null;
  }

  const form = await request.formData().catch(() => null);
  const value = form?.get('secret');

  return typeof value === 'string' ? value : null;
}

/** Real HTTPS everywhere this actually deploys to (Vercel — `.ai/decisions/hosting-and-growth-path.md`); the one carve-out is a bare-HTTP local dev server, which cannot set a `Secure` cookie for itself to read back at all. Keyed off the request's own host, not `NODE_ENV` — a preview/staging deploy is not `NODE_ENV=production` by default and must not silently downgrade to sending a 12h admin bearer token over plain HTTP. */
function isPlainHttpLocalhost(request: Request): boolean {
  const hostname = new URL(request.url).hostname;

  return hostname === 'localhost' || hostname === '127.0.0.1';
}

export async function POST(request: Request): Promise<Response> {
  const correlationId = randomUUID();
  const clientKey = clientKeyForRequest(request);
  const now = new Date();
  const db = getDb();

  try {
    await assertWithinAdminLoginRateLimit(db, clientKey, correlationId, now);
  } catch (error) {
    if (error instanceof AdminLoginRateLimited) {
      await recordRateLimitedLoginEventOnce(db, clientKey, correlationId, now);

      return relativeRedirect('/admin/login?error=rate_limited');
    }

    captureError(error, { correlationId, route: 'admin.login' });

    // Fail closed: cannot confirm this caller is under the limit, so the login does not proceed.
    return relativeRedirect('/admin/login?error=1');
  }

  const expected = getConfiguredAdminSecret();
  const provided = await readSecretFromRequest(request);
  const succeeded = expected !== undefined && provided !== null && secretsMatch(provided, expected);

  try {
    // Recorded regardless of outcome — this is what makes the *next* call's throttle check
    // accurate, and what bounds this table's growth to the throttle's own max per window.
    await recordAdminLoginAttempt(db, clientKey, succeeded, now);
  } catch (error) {
    captureError(error, { correlationId, route: 'admin.login', operation: 'recordAdminLoginAttempt' });
  }

  if (!succeeded) {
    logger.warn('admin login rejected', { correlationId });

    try {
      await recordEvent({ eventType: 'admin.login_failed', occurredAt: now, correlationId, userId: null, payload: { clientKey } }, db);
    } catch (error) {
      captureError(error, { correlationId, route: 'admin.login', operation: 'recordFailedLoginEvent' });
    }

    return relativeRedirect('/admin/login?error=1');
  }

  try {
    const cookieStore = await cookies();

    cookieStore.set(ADMIN_SESSION_COOKIE_NAME, createAdminSessionCookieValue(expected, ADMIN_SESSION_TTL_MS, now), {
      httpOnly: true,
      secure: !isPlainHttpLocalhost(request),
      sameSite: 'lax',
      path: '/admin',
      maxAge: Math.floor(ADMIN_SESSION_TTL_MS / 1_000),
    });

    return relativeRedirect('/admin/metrics');
  } catch (error) {
    captureError(error, { correlationId, route: 'admin.login' });

    return relativeRedirect('/admin/login?error=1');
  }
}
