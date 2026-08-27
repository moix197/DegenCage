import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ADMIN_SESSION_COOKIE_NAME } from '@/server/admin/access';

import { POST } from './route';

/**
 * `unauthenticated → 404/notFound` for the page's gate is covered by `access.test.ts`
 * (the cookie-verification logic itself) and here (wrong/missing secret never sets a
 * cookie); `valid cookie → renders` is covered here by asserting the correct secret sets a
 * cookie that `verifyAdminSessionCookie` (exercised in `access.test.ts`) accepts — the exact
 * function `admin/metrics/page.tsx` calls before rendering anything.
 */

const { cookiesSetMock } = vi.hoisted(() => ({ cookiesSetMock: vi.fn() }));

vi.mock('next/headers', () => ({ cookies: async () => ({ set: cookiesSetMock }) }));

const ORIGINAL_SECRET = process.env.ADMIN_METRICS_SECRET;

function formRequest(secret?: string): Request {
  const form = new URLSearchParams();
  if (secret !== undefined) form.set('secret', secret);

  return new Request('http://localhost/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
}

beforeEach(() => {
  cookiesSetMock.mockReset();
  process.env.ADMIN_METRICS_SECRET = 'correct-secret';
});

afterEach(() => {
  process.env.ADMIN_METRICS_SECRET = ORIGINAL_SECRET;
});

describe('POST /api/admin/login', () => {
  it('redirects to /admin/login?error=1 and sets no cookie on a wrong secret', async () => {
    const response = await POST(formRequest('wrong-secret'));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('/admin/login?error=1');
    expect(cookiesSetMock).not.toHaveBeenCalled();
  });

  it('redirects to /admin/login?error=1 with no secret field sent at all', async () => {
    const response = await POST(formRequest());

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('/admin/login?error=1');
    expect(cookiesSetMock).not.toHaveBeenCalled();
  });

  it('rejects every caller, and sets no cookie, when ADMIN_METRICS_SECRET itself is unset', async () => {
    delete process.env.ADMIN_METRICS_SECRET;

    const response = await POST(formRequest('anything'));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('/admin/login?error=1');
    expect(cookiesSetMock).not.toHaveBeenCalled();
  });

  it('sets a signed, httpOnly session cookie scoped to /admin and redirects to /admin/metrics on the correct secret', async () => {
    const response = await POST(formRequest('correct-secret'));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('/admin/metrics');
    expect(cookiesSetMock).toHaveBeenCalledTimes(1);

    const [name, value, options] = cookiesSetMock.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(name).toBe(ADMIN_SESSION_COOKIE_NAME);
    expect(value).toMatch(/^\d+\.[0-9a-f]{64}$/);
    expect(options).toMatchObject({ httpOnly: true, path: '/admin', sameSite: 'lax' });
  });

  it('also accepts a JSON body, not only form-encoded', async () => {
    const response = await POST(
      new Request('http://localhost/api/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret: 'correct-secret' }),
      }),
    );

    expect(response.status).toBe(303);
    expect(cookiesSetMock).toHaveBeenCalledTimes(1);
  });
});
