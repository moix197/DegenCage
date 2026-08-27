import { cookies } from 'next/headers';

import { ADMIN_SESSION_COOKIE_NAME, getConfiguredAdminSecret, verifyAdminSessionCookie } from '@/server/admin/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Clears the admin session cookie — the only revocation path that exists (the cookie is
 * stateless/self-verifying, `server/admin/access.ts`, so there is no session row to delete
 * server-side). `POST`, not `GET`, so a prefetch or a crawled link can never silently log an
 * operator out. Same path/attributes as `api/admin/login/route.ts`'s `set` — an overwrite
 * with `maxAge: 0` only actually clears the browser's cookie if every scoping attribute
 * matches the one that was set.
 *
 * **CSRF-safe by construction, not by a token.** This route only ever issues a `Set-Cookie`
 * when the *incoming* request already carries a currently-valid admin session cookie
 * (checked below) — a cross-site auto-submitting form cannot supply one: the cookie is
 * `sameSite: 'lax'`, and Lax cookies are not attached to a cross-site `POST` at all, so
 * `cookieStore.get(...)` sees nothing for that request and `hasValidSession` is false before
 * anything is cleared. The same-origin check on top is defense in depth for the case where
 * `SameSite` handling is ever weakened (an older browser, a same-site-but-cross-origin
 * subdomain trick) rather than the only thing standing in the way — impact if this were ever
 * bypassed is a forced re-login, never account takeover or data exposure (`degencage_session`,
 * the user-facing session cookie, is untouched by this route entirely).
 */
function relativeRedirect(path: string): Response {
  return new Response(null, { status: 303, headers: { location: path } });
}

function isPlainHttpLocalhost(request: Request): boolean {
  const hostname = new URL(request.url).hostname;

  return hostname === 'localhost' || hostname === '127.0.0.1';
}

/** No `Origin` header at all (some legitimate same-site requests omit it) is treated as same-origin — the cookie-validity check above is the primary gate; this is defense in depth on top of it, not a replacement. */
function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');

  if (!origin) {
    return true;
  }

  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

export async function POST(request: Request): Promise<Response> {
  const expected = getConfiguredAdminSecret();
  const cookieStore = await cookies();
  const currentCookie = cookieStore.get(ADMIN_SESSION_COOKIE_NAME)?.value;
  const hasValidSession = expected !== undefined && currentCookie !== undefined && verifyAdminSessionCookie(currentCookie, expected);

  if (!hasValidSession || !isSameOrigin(request)) {
    // Nothing to clear: no genuine session on this request, or a cross-site caller. No
    // `Set-Cookie` is issued either way — see the module doc comment for why a CSRF `POST`
    // can't reach the branch below at all.
    return relativeRedirect('/admin/login');
  }

  cookieStore.set(ADMIN_SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    secure: !isPlainHttpLocalhost(request),
    sameSite: 'lax',
    path: '/admin',
    maxAge: 0,
  });

  return relativeRedirect('/admin/login');
}
