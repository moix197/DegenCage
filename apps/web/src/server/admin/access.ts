import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Shared admin-secret primitives — the one constant-time comparison and the one signed,
 * expiring session-cookie format every admin-gated surface uses:
 * `api/admin/metrics/route.ts` (header-bearer, for programmatic/curl callers),
 * `api/admin/login/route.ts` (issues the cookie), and `admin/metrics/page.tsx` (verifies
 * it). One implementation, never copied — see `.ai/decisions/admin-metrics-secret-gate.md`.
 */

export const ADMIN_SECRET_HEADER = 'x-admin-metrics-secret';
export const ADMIN_SESSION_COOKIE_NAME = 'degencage_admin_session';
/** How long a browser login lasts before the cookie stops verifying, regardless of activity — not sliding, no server-side revocation list to check (there is no session store; the signature itself is the only state). */
export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1_000;

/**
 * `timingSafeEqual` throws on a length mismatch rather than returning `false` — hashing both
 * sides first normalizes them to the same length before the constant-time comparison, so a
 * caller who sends a shorter/longer guess doesn't get a fast-fail that itself leaks a timing
 * signal about the secret's length. The unauthorized-vs-authorized timing delta this route
 * has *by design* (an immediate reject vs. `buildMetricsSnapshot`'s ~9 queries) is a separate,
 * accepted, documented gap — see the decision doc — not something this function tries to close.
 */
export function secretsMatch(provided: string, expected: string): boolean {
  const providedDigest = createHash('sha256').update(provided).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();

  return timingSafeEqual(providedDigest, expectedDigest);
}

/** Header-bearer check for `GET /api/admin/metrics` — unchanged mechanism from the route's first version, just centralized here so `api/admin/login` can reuse `secretsMatch` without a second copy. */
export function hasValidAdminSecretHeader(request: Request): boolean {
  const expected = process.env.ADMIN_METRICS_SECRET;
  const provided = request.headers.get(ADMIN_SECRET_HEADER);

  if (!expected || !provided) {
    return false;
  }

  return secretsMatch(provided, expected);
}

function signExpiry(secret: string, expiresAtMs: number): string {
  return createHmac('sha256', secret).update(String(expiresAtMs)).digest('hex');
}

/**
 * `${expiresAtMs}.${hmacHex}` — stateless and self-contained: nothing is stored server-side,
 * so a cookie is valid exactly when its own signature (keyed by the current
 * `ADMIN_METRICS_SECRET`) proves it was issued by someone who held the secret, and its own
 * embedded expiry hasn't passed. Rotating the secret invalidates every outstanding cookie at
 * once, with no session table to clear.
 */
export function createAdminSessionCookieValue(secret: string, ttlMs: number, now: Date = new Date()): string {
  const expiresAtMs = now.getTime() + ttlMs;

  return `${expiresAtMs}.${signExpiry(secret, expiresAtMs)}`;
}

export function verifyAdminSessionCookie(cookieValue: string, secret: string, now: Date = new Date()): boolean {
  const [expiresAtRaw, signature] = cookieValue.split('.');

  if (!expiresAtRaw || !signature) {
    return false;
  }

  const expiresAtMs = Number(expiresAtRaw);

  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime()) {
    return false;
  }

  const expectedSignature = signExpiry(secret, expiresAtMs);
  const signatureBuf = Buffer.from(signature, 'hex');
  const expectedBuf = Buffer.from(expectedSignature, 'hex');

  // Both are sha256 hex digests (64 chars) whenever the cookie wasn't tampered with — a
  // length mismatch here just means "not a valid signature", not something to hash-normalize
  // the way `secretsMatch` does for arbitrary-length caller input.
  if (signatureBuf.length !== expectedBuf.length) {
    return false;
  }

  return timingSafeEqual(signatureBuf, expectedBuf);
}
