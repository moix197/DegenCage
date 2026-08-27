import { describe, expect, it } from 'vitest';

import { createAdminSessionCookieValue, secretsMatch, verifyAdminSessionCookie } from './access';

/**
 * The core cryptographic logic behind the admin cookie gate (`admin/metrics/page.tsx`) and
 * the header gate (`api/admin/metrics/route.ts`) — pure, no `next/headers`, so this covers
 * "unauthenticated → rejected" / "valid session → accepted" at the level that actually
 * decides both surfaces, without needing to render either one.
 */

describe('secretsMatch', () => {
  it('matches equal secrets', () => {
    expect(secretsMatch('shared-secret', 'shared-secret')).toBe(true);
  });

  it('rejects a different secret of the same length', () => {
    expect(secretsMatch('wrong-secret', 'right-secret')).toBe(false);
  });

  it('rejects secrets of different lengths without throwing', () => {
    expect(secretsMatch('short', 'a-much-longer-secret')).toBe(false);
  });
});

describe('admin session cookie: create then verify', () => {
  const SECRET = 'shared-secret';

  it('round-trips: a freshly signed cookie verifies against the same secret before expiry', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const cookieValue = createAdminSessionCookieValue(SECRET, 60_000, now);

    expect(verifyAdminSessionCookie(cookieValue, SECRET, now)).toBe(true);
  });

  it('rejects an unauthenticated caller with no cookie at all', () => {
    expect(verifyAdminSessionCookie('', SECRET)).toBe(false);
  });

  it('rejects a malformed cookie value', () => {
    expect(verifyAdminSessionCookie('not-a-valid-cookie', SECRET)).toBe(false);
    expect(verifyAdminSessionCookie('12345', SECRET)).toBe(false);
  });

  it('rejects a cookie once its embedded expiry has passed', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const cookieValue = createAdminSessionCookieValue(SECRET, 60_000, now);
    const afterExpiry = new Date(now.getTime() + 60_001);

    expect(verifyAdminSessionCookie(cookieValue, SECRET, afterExpiry)).toBe(false);
  });

  it('rejects a cookie signed under a different secret (e.g. after rotation)', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const cookieValue = createAdminSessionCookieValue('old-secret', 60_000, now);

    expect(verifyAdminSessionCookie(cookieValue, SECRET, now)).toBe(false);
  });

  it('rejects a tampered signature', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const cookieValue = createAdminSessionCookieValue(SECRET, 60_000, now);
    const [expiresAt] = cookieValue.split('.');

    expect(verifyAdminSessionCookie(`${expiresAt}.${'0'.repeat(64)}`, SECRET, now)).toBe(false);
  });

  it('rejects a forged expiry extension — changing expiresAt invalidates the signature', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const cookieValue = createAdminSessionCookieValue(SECRET, 60_000, now);
    const [, signature] = cookieValue.split('.');
    const forgedExpiry = now.getTime() + 999_999_999;

    expect(verifyAdminSessionCookie(`${forgedExpiry}.${signature}`, SECRET, now)).toBe(false);
  });
});
