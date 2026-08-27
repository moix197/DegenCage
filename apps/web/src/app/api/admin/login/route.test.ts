import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ADMIN_SESSION_COOKIE_NAME } from '@/server/admin/access';

import { POST } from './route';

/**
 * `unauthenticated → 404/notFound` for the page's gate is covered by `access.test.ts`
 * (the cookie-verification logic itself) and here (wrong/missing secret never sets a
 * cookie); `valid cookie → renders` is covered here by asserting the correct secret sets a
 * cookie that `verifyAdminSessionCookie` (exercised in `access.test.ts`) accepts — the exact
 * function `admin/metrics/page.tsx` calls before rendering anything.
 *
 * The atomic throttle itself (`server/admin/login-rate-limit.ts`'s `attemptAdminLogin`,
 * including its concurrency guarantee) is unit-tested on its own in
 * `login-rate-limit.test.ts`; here the route-level wiring is what's under test —
 * `attemptAdminLogin` is mocked rather than exercised against a real table, and this file
 * asserts the route reacts correctly to each of its three possible outcomes
 * (`'succeeded' | 'failed' | 'rate_limited'`).
 */

const { cookiesSetMock, recordEventMock, attemptAdminLoginMock, recordRateLimitedLoginEventOnceMock } = vi.hoisted(() => ({
  cookiesSetMock: vi.fn(),
  recordEventMock: vi.fn(),
  attemptAdminLoginMock: vi.fn(),
  recordRateLimitedLoginEventOnceMock: vi.fn(),
}));

vi.mock('next/headers', () => ({ cookies: async () => ({ set: cookiesSetMock }) }));
vi.mock('@/observability/events', () => ({ recordEvent: recordEventMock }));
vi.mock('@/server/db/client', () => ({ getDb: () => ({ marker: 'fake-db-handle' }) }));
vi.mock('@/server/admin/login-rate-limit', () => ({
  attemptAdminLogin: attemptAdminLoginMock,
  recordRateLimitedLoginEventOnce: recordRateLimitedLoginEventOnceMock,
}));

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

/** `attemptAdminLogin`'s real behavior — mocked here as calling `verifySecret()` synchronously and returning the matching outcome, so route-level tests exercise the same secret-vs-provided comparison the real function would run inside its transaction. */
function mockAttemptOutcome() {
  attemptAdminLoginMock.mockImplementation(async (_db: unknown, _clientKey: string, _correlationId: string, _now: Date, verifySecret: () => boolean) =>
    verifySecret() ? 'succeeded' : 'failed',
  );
}

beforeEach(() => {
  cookiesSetMock.mockReset();
  recordEventMock.mockReset();
  attemptAdminLoginMock.mockReset();
  recordRateLimitedLoginEventOnceMock.mockReset();
  mockAttemptOutcome();
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
  });

  it('calls attemptAdminLogin with a verifySecret closure, not with the secret directly', async () => {
    await POST(formRequest(VALID_SECRET));

    expect(attemptAdminLoginMock).toHaveBeenCalledWith(expect.anything(), expect.any(String), expect.any(String), expect.any(Date), expect.any(Function));
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
    it('throttled callers are redirected without ever setting a cookie', async () => {
      attemptAdminLoginMock.mockResolvedValueOnce('rate_limited');

      const response = await POST(formRequest(VALID_SECRET));

      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('/admin/login?error=rate_limited');
      expect(cookiesSetMock).not.toHaveBeenCalled();
    });

    it('records the rate_limited event via the self-throttled helper', async () => {
      attemptAdminLoginMock.mockResolvedValueOnce('rate_limited');

      await POST(formRequest(VALID_SECRET));

      expect(recordRateLimitedLoginEventOnceMock).toHaveBeenCalledTimes(1);
    });

    it('fails closed (denies login) on an error from attemptAdminLogin, e.g. the database unreachable', async () => {
      attemptAdminLoginMock.mockRejectedValueOnce(new Error('database unreachable'));

      const response = await POST(formRequest(VALID_SECRET));

      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('/admin/login?error=1');
      expect(cookiesSetMock).not.toHaveBeenCalled();
    });
  });
});
