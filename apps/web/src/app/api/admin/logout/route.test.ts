import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ADMIN_SESSION_COOKIE_NAME, createAdminSessionCookieValue } from '@/server/admin/access';

import { POST } from './route';

/**
 * CSRF safety is the property under test: a cross-site auto-submitting form cannot force a
 * logout, because it can't attach the `sameSite: 'lax'` admin cookie to a cross-site `POST`
 * in the first place — this route only clears the cookie when the *incoming* request already
 * carries a currently-valid one. Modeled here by simply not sending a cookie (what a
 * cross-site request would actually look like server-side), not by simulating `SameSite`
 * itself (a browser behavior, out of scope for a route-handler unit test).
 */

const { cookiesGetMock, cookiesSetMock } = vi.hoisted(() => ({ cookiesGetMock: vi.fn(), cookiesSetMock: vi.fn() }));

vi.mock('next/headers', () => ({ cookies: async () => ({ get: cookiesGetMock, set: cookiesSetMock }) }));

const ORIGINAL_SECRET = process.env.ADMIN_METRICS_SECRET;
const VALID_SECRET = 'a-very-strong-secret-that-is-32-chars-plus';
// `route.ts` calls `verifyAdminSessionCookie(cookie, secret)` with no explicit `now` — it
// defaults to the real `new Date()`. A fixed-past `NOW` here would make every cookie this
// file signs look already-expired against that real check, so this has to track real time.
const NOW = new Date();

function requestWithOrigin(origin?: string): Request {
  return new Request('http://localhost/api/admin/logout', {
    method: 'POST',
    headers: origin !== undefined ? { origin } : {},
  });
}

beforeEach(() => {
  cookiesGetMock.mockReset();
  cookiesSetMock.mockReset();
  process.env.ADMIN_METRICS_SECRET = VALID_SECRET;
});

afterEach(() => {
  process.env.ADMIN_METRICS_SECRET = ORIGINAL_SECRET;
});

describe('POST /api/admin/logout', () => {
  it('clears the cookie when the request carries a currently-valid session, same-origin', async () => {
    cookiesGetMock.mockReturnValue({ value: createAdminSessionCookieValue(VALID_SECRET, 60_000, NOW) });

    const response = await POST(requestWithOrigin('http://localhost'));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/admin/login');
    expect(cookiesSetMock).toHaveBeenCalledWith(
      ADMIN_SESSION_COOKIE_NAME,
      '',
      expect.objectContaining({ httpOnly: true, path: '/admin', maxAge: 0 }),
    );
  });

  it('sets no cookie when the request carries no session cookie at all — the CSRF case', async () => {
    cookiesGetMock.mockReturnValue(undefined);

    const response = await POST(requestWithOrigin('https://evil.example.com'));

    expect(response.status).toBe(303);
    expect(cookiesSetMock).not.toHaveBeenCalled();
  });

  it('sets no cookie for an expired/tampered session cookie', async () => {
    const expired = createAdminSessionCookieValue(VALID_SECRET, -1, NOW);
    cookiesGetMock.mockReturnValue({ value: expired });

    await POST(requestWithOrigin('http://localhost'));

    expect(cookiesSetMock).not.toHaveBeenCalled();
  });

  it('sets no cookie for a valid session cookie arriving with a cross-origin Origin header — defense in depth', async () => {
    cookiesGetMock.mockReturnValue({ value: createAdminSessionCookieValue(VALID_SECRET, 60_000, NOW) });

    await POST(requestWithOrigin('https://evil.example.com'));

    expect(cookiesSetMock).not.toHaveBeenCalled();
  });

  it('does not reject a same-site request with no Origin header at all', async () => {
    cookiesGetMock.mockReturnValue({ value: createAdminSessionCookieValue(VALID_SECRET, 60_000, NOW) });

    await POST(requestWithOrigin(undefined));

    expect(cookiesSetMock).toHaveBeenCalledTimes(1);
  });

  it('sets no cookie when ADMIN_METRICS_SECRET is unset, even with what looks like a cookie present', async () => {
    delete process.env.ADMIN_METRICS_SECRET;
    cookiesGetMock.mockReturnValue({ value: createAdminSessionCookieValue(VALID_SECRET, 60_000, NOW) });

    await POST(requestWithOrigin('http://localhost'));

    expect(cookiesSetMock).not.toHaveBeenCalled();
  });
});
