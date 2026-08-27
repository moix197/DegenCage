import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { logger } from '../../observability/logger';

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
 * Below this length, `ADMIN_METRICS_SECRET` is treated as **not configured at all** — the
 * gate refuses everyone, including whoever holds the weak value, rather than accept a
 * guessable one. 32 characters is a floor, not a target: generate with `openssl rand -base64
 * 32` (or equivalent), never a memorized phrase — see `.env.example`.
 */
export const MIN_ADMIN_SECRET_LENGTH = 32;

/**
 * The one place that reads `ADMIN_METRICS_SECRET` from the environment. Every gate calls
 * this rather than `process.env.ADMIN_METRICS_SECRET` directly, so a too-short value is
 * treated identically to an unset one everywhere at once — never valid in one check and
 * silently accepted in another.
 */
export function getConfiguredAdminSecret(): string | undefined {
  const secret = process.env.ADMIN_METRICS_SECRET;

  if (!secret || secret.length < MIN_ADMIN_SECRET_LENGTH) {
    return undefined;
  }

  return secret;
}

/**
 * Logged once at process startup (`instrumentation.ts`) — a weak/missing secret does not
 * crash the app (an admin-only surface failing closed is not worth taking the whole product
 * down for), but it must be visible in logs immediately, not discovered later while
 * debugging why `/api/admin/metrics` 404s for everyone including the real secret.
 */
export function warnIfAdminSecretMisconfigured(): void {
  const raw = process.env.ADMIN_METRICS_SECRET;

  if (!raw) {
    logger.warn('ADMIN_METRICS_SECRET is not set — the admin gate refuses every caller until it is');
    return;
  }

  if (raw.length < MIN_ADMIN_SECRET_LENGTH) {
    logger.warn('ADMIN_METRICS_SECRET is shorter than the minimum length — the admin gate refuses every caller, including the real value, until a stronger secret is set', {
      length: raw.length,
      minimumLength: MIN_ADMIN_SECRET_LENGTH,
    });
  }
}

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
  const expected = getConfiguredAdminSecret();
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
