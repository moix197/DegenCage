import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ADMIN_SESSION_COOKIE_NAME } from '@/server/admin/access';
import { AdminLoginRateLimited } from '@/server/admin/login-rate-limit';

import { POST } from './route';

/**
 * `unauthenticated → 404/notFound` for the page's gate is covered by `access.test.ts`
 * (the cookie-verification logic itself) and here (wrong/missing secret never sets a
 * cookie); `valid cookie → renders` is covered here by asserting the correct secret sets a
 * cookie that `verifyAdminSessionCookie` (exercised in `access.test.ts`) accepts — the exact
 * function `admin/metrics/page.tsx` calls before rendering anything.
 *
 * The login throttle itself (`server/admin/login-rate-limit.ts`) is unit-tested on its own
 * in `login-rate-limit.test.ts`; here the route-level wiring is what's under test — a
 * throttled client never reaches the secret check at all (closing the online-guessing
 * oracle a security audit flagged), and `recordAdminLoginAttempt` is mocked rather than
 * exercised against a real table.
 */

const { cookiesSetMock, recordEventMock, assertWithinAdminLoginRateLimitMock, recordAdminLoginAttemptMock, recordRateLimitedLoginEventOnceMock } = vi.hoisted(
  () => ({
    cookiesSetMock: vi.fn(),
    recordEventMock: vi.fn(),
    assertWithinAdminLoginRateLimitMock: vi.fn(),
    recordAdminLoginAttemptMock: vi.fn(),
    recordRateLimitedLoginEventOnceMock: vi.fn(),
  }),
);

vi.mock('next/headers', () => ({ cookies: async () => ({ set: cookiesSetMock }) }));
vi.mock('@/observability/events', () => ({ recordEvent: recordEventMock }));
vi.mock('@/server/db/client', () => ({ getDb: () => ({ marker: 'fake-db-handle' }) }));
// Only the assertion/record functions are mocked — `AdminLoginRateLimited` stays the real
// class (spread from `actual`) so `instanceof` checks in `route.ts` and this file's
// `mockRejectedValueOnce(new AdminLoginRateLimited())` refer to the exact same constructor,
// same shape as `pending-changes.test.ts`'s `./rate-limit` mock.
vi.mock('@/server/admin/login-rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/admin/login-rate-limit')>();

  return {
    ...actual,
    assertWithinAdminLoginRateLimit: assertWithinAdminLoginRateLimitMock,
    recordAdminLoginAttempt: recordAdminLoginAttemptMock,
    recordRateLimitedLoginEventOnce: recordRateLimitedLoginEventOnceMock,
  };
});

const ORIGINAL_SECRET = process.env.ADMIN_METRICS_SECRET;
const VALID_SECRET = 'a-very-strong-secret-that-is-32-chars-plus';

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
  recordEventMock.mockReset();
  assertWithinAdminLoginRateLimitMock.mockReset();
  recordAdminLoginAttemptMock.mockReset();
  recordRateLimitedLoginEventOnceMock.mockReset();
  assertWithinAdminLoginRateLimitMock.mockResolvedValue(undefined);
  process.env.ADMIN_METRICS_SECRET = VALID_SECRET;
});

afterEach(() => {
  process.env.ADMIN_METRICS_SECRET = ORIGINAL_SECRET;
});

describe('POST /api/admin/login', () => {
  it('redirects to /admin/login?error=1 and sets no cookie on a wrong secret', async () => {
    const response = await POST(formRequest('wrong-secret'));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/admin/login?error=1');
    expect(cookiesSetMock).not.toHaveBeenCalled();
    expect(recordAdminLoginAttemptMock).toHaveBeenCalledWith(expect.anything(), expect.any(String), false, expect.any(Date));
    expect(recordEventMock).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'admin.login_failed' }), expect.anything());
  });

  it('redirects to /admin/login?error=1 with no secret field sent at all', async () => {
    const response = await POST(formRequest());

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/admin/login?error=1');
    expect(cookiesSetMock).not.toHaveBeenCalled();
  });

  it('rejects every caller, and sets no cookie, when ADMIN_METRICS_SECRET itself is unset', async () => {
    delete process.env.ADMIN_METRICS_SECRET;

    const response = await POST(formRequest('anything'));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/admin/login?error=1');
    expect(cookiesSetMock).not.toHaveBeenCalled();
  });

  it('sets a signed, httpOnly session cookie scoped to /admin and redirects to /admin/metrics on the correct secret', async () => {
    const response = await POST(formRequest(VALID_SECRET));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/admin/metrics');
    expect(cookiesSetMock).toHaveBeenCalledTimes(1);

    const [name, value, options] = cookiesSetMock.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(name).toBe(ADMIN_SESSION_COOKIE_NAME);
    expect(value).toMatch(/^\d+\.[0-9a-f]{64}$/);
    expect(options).toMatchObject({ httpOnly: true, path: '/admin', sameSite: 'lax' });
    expect(recordAdminLoginAttemptMock).toHaveBeenCalledWith(expect.anything(), expect.any(String), true, expect.any(Date));
  });

  it('marks the cookie Secure for a non-localhost host regardless of NODE_ENV', async () => {
    const request = new Request('https://admin.example.com/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: VALID_SECRET }).toString(),
    });

    await POST(request);

    const [, , options] = cookiesSetMock.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(options.secure).toBe(true);
  });

  it('also accepts a JSON body, not only form-encoded', async () => {
    const response = await POST(
      new Request('http://localhost/api/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret: VALID_SECRET }),
      }),
    );

    expect(response.status).toBe(303);
    expect(cookiesSetMock).toHaveBeenCalledTimes(1);
  });

  it('redirect Location headers are relative — never built from request.url, closing the host-header open-redirect', async () => {
    const request = new Request('http://localhost/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', host: 'evil.example.com' },
      body: new URLSearchParams({ secret: 'wrong-secret' }).toString(),
    });

    const response = await POST(request);

    expect(response.headers.get('location')).toBe('/admin/login?error=1');
  });

  describe('rate limiting — closing the online-guessing oracle', () => {
    it('throttled callers are redirected before the secret is ever checked, and no attempt is recorded', async () => {
      assertWithinAdminLoginRateLimitMock.mockRejectedValueOnce(new AdminLoginRateLimited());

      const response = await POST(formRequest(VALID_SECRET));

      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('/admin/login?error=rate_limited');
      expect(cookiesSetMock).not.toHaveBeenCalled();
      // The whole point: a throttled call never reaches `recordAdminLoginAttempt` — the
      // correct-vs-wrong secret distinction (the thing an oracle would exploit) never happens.
      expect(recordAdminLoginAttemptMock).not.toHaveBeenCalled();
    });

    it('records the rate_limited event exactly once via the self-throttled helper', async () => {
      assertWithinAdminLoginRateLimitMock.mockRejectedValueOnce(new AdminLoginRateLimited());

      await POST(formRequest(VALID_SECRET));

      expect(recordRateLimitedLoginEventOnceMock).toHaveBeenCalledTimes(1);
    });

    it('fails closed (denies login) on a non-throttle error from the limiter, e.g. the database unreachable', async () => {
      assertWithinAdminLoginRateLimitMock.mockRejectedValueOnce(new Error('database unreachable'));

      const response = await POST(formRequest(VALID_SECRET));

      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('/admin/login?error=1');
      expect(cookiesSetMock).not.toHaveBeenCalled();
      expect(recordAdminLoginAttemptMock).not.toHaveBeenCalled();
    });
  });
});
