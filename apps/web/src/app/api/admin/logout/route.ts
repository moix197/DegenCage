import { cookies } from 'next/headers';

import { ADMIN_SESSION_COOKIE_NAME } from '@/server/admin/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Clears the admin session cookie — the only revocation path that exists (the cookie is
 * stateless/self-verifying, `server/admin/access.ts`, so there is no session row to delete
 * server-side). `POST`, not `GET`, so a prefetch or a crawled link can never silently log an
 * operator out. Same path/attributes as `api/admin/login/route.ts`'s `set` — an overwrite
 * with `maxAge: 0` only actually clears the browser's cookie if every scoping attribute
 * matches the one that was set.
 */
function relativeRedirect(path: string): Response {
  return new Response(null, { status: 303, headers: { location: path } });
}

function isPlainHttpLocalhost(request: Request): boolean {
  const hostname = new URL(request.url).hostname;

  return hostname === 'localhost' || hostname === '127.0.0.1';
}

export async function POST(request: Request): Promise<Response> {
  const cookieStore = await cookies();

  cookieStore.set(ADMIN_SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    secure: !isPlainHttpLocalhost(request),
    sameSite: 'lax',
    path: '/admin',
    maxAge: 0,
  });

  return relativeRedirect('/admin/login');
}
