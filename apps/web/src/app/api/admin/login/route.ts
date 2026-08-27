import { randomUUID } from 'node:crypto';

import { cookies } from 'next/headers';

import { captureError } from '@/observability/error-tracking';
import { logger } from '@/observability/logger';
import { ADMIN_SESSION_COOKIE_NAME, ADMIN_SESSION_TTL_MS, createAdminSessionCookieValue, secretsMatch } from '@/server/admin/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Exchanges `ADMIN_METRICS_SECRET` for a signed, httpOnly, expiring session cookie —
 * what `admin/metrics/page.tsx` checks instead of a header a browser navigation can't send.
 * Plain `<form method="POST">`-compatible: accepts `application/x-www-form-urlencoded` or
 * JSON, and always redirects (303) rather than returning JSON, so it works with zero client
 * JS from `admin/login/page.tsx`.
 */

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

export async function POST(request: Request): Promise<Response> {
  const correlationId = randomUUID();
  const expected = process.env.ADMIN_METRICS_SECRET;
  const provided = await readSecretFromRequest(request);

  // Same fail-closed shape as `api/admin/metrics/route.ts`: an unset secret means nothing
  // can ever log in, not that the check is skipped.
  if (!expected || !provided || !secretsMatch(provided, expected)) {
    logger.warn('admin login rejected', { correlationId });

    return Response.redirect(new URL('/admin/login?error=1', request.url), 303);
  }

  try {
    const cookieStore = await cookies();

    cookieStore.set(ADMIN_SESSION_COOKIE_NAME, createAdminSessionCookieValue(expected, ADMIN_SESSION_TTL_MS), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/admin',
      maxAge: Math.floor(ADMIN_SESSION_TTL_MS / 1_000),
    });

    return Response.redirect(new URL('/admin/metrics', request.url), 303);
  } catch (error) {
    captureError(error, { correlationId, route: 'admin.login' });

    return Response.redirect(new URL('/admin/login?error=1', request.url), 303);
  }
}
