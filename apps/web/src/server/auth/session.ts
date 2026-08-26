import { createHash, randomBytes } from 'node:crypto';

import { and, eq, isNull } from 'drizzle-orm';
import { cookies } from 'next/headers';

import { captureError } from '../../observability/error-tracking';
import { recordEvent, type DatabaseExecutor } from '../../observability/events';
import { logger } from '../../observability/logger';
import { getDb } from '../db/client';
import { sessions, users, wallets } from '../db/schema';

/**
 * Session issuance and, more importantly, `resolveSession` — the **only** legitimate
 * answer to "which wallet is this request for". No route may take a wallet id or address
 * from a request body instead; doing so would make every rule in the product opt-out.
 *
 * Opaque id in an httpOnly cookie, hashed at rest, revocable by row (decision 15). Not a
 * JWT: an account switch or a compromised session has to be killable server-side, now.
 */

export const SESSION_COOKIE_NAME = 'degencage_session';

/** Sliding, per decision 15: every resolved request pushes the horizon back out. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export interface SessionIdentity {
  walletAddress: string;
  walletId: string;
  userId: string;
  expiresAt: Date;
}

export interface SessionCookie {
  name: string;
  value: string;
  options: {
    httpOnly: true;
    secure: true;
    sameSite: 'lax';
    path: '/';
    expires: Date;
  };
}

function hashSessionId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex');
}

export function sessionExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + SESSION_TTL_MS);
}

/**
 * `SameSite=Lax` (not `Strict`) so a link back into the app keeps the user signed in;
 * the cookie authorizes nothing by itself — every mutation still needs a wallet signature.
 */
export function buildSessionCookie(sessionId: string, expiresAt: Date): SessionCookie {
  return {
    name: SESSION_COOKIE_NAME,
    value: sessionId,
    options: {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      expires: expiresAt,
    },
  };
}

/** One user, one wallet in Phase 0 (decision 2) — a returning address reuses its row. */
async function upsertWalletOwner(
  executor: DatabaseExecutor,
  walletAddress: string,
): Promise<{ walletId: string; userId: string }> {
  const existing = await executor
    .select({ id: wallets.id, userId: wallets.userId })
    .from(wallets)
    .where(eq(wallets.address, walletAddress))
    .limit(1);

  const found = existing[0];
  if (found) {
    return { walletId: found.id, userId: found.userId };
  }

  const inserted = await executor.insert(users).values({}).returning({ id: users.id });
  const userId = inserted[0]!.id;
  const wallet = await executor
    .insert(wallets)
    .values({ userId, address: walletAddress, custody: 'external' })
    .returning({ id: wallets.id });

  return { walletId: wallet[0]!.id, userId };
}

export interface EstablishedSession extends SessionIdentity {
  cookie: SessionCookie;
}

/**
 * Creates the user/wallet/session rows for an *already verified* wallet address.
 *
 * Takes an executor rather than reaching for the pool so the caller can put this in the
 * same transaction that consumes the SIWS nonce — a crash between the two must not leave
 * a burnt nonce with no session to show for it.
 */
export async function establishSession(
  executor: DatabaseExecutor,
  walletAddress: string,
  correlationId: string,
): Promise<EstablishedSession> {
  const { walletId, userId } = await upsertWalletOwner(executor, walletAddress);

  const sessionId = randomBytes(32).toString('base64url');
  const expiresAt = sessionExpiryFrom(new Date());

  await executor.insert(sessions).values({
    idHash: hashSessionId(sessionId),
    walletAddress,
    expiresAt,
  });

  await recordEvent(
    {
      eventType: 'auth.session_created',
      occurredAt: new Date(),
      correlationId,
      userId,
      payload: { walletAddress, walletId, expiresAt: expiresAt.toISOString() },
    },
    executor,
  );

  return {
    walletAddress,
    walletId,
    userId,
    expiresAt,
    cookie: buildSessionCookie(sessionId, expiresAt),
  };
}

async function readSessionCookie(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE_NAME)?.value;
}

export interface StoredSession {
  walletAddress: string;
  expiresAt: Date;
  revokedAt: Date | null;
  walletId: string;
  userId: string;
}

/**
 * Pure decision: is this stored session still good? Revocation and expiry are checked
 * here rather than folded into the `WHERE` clause so both are visible, individually
 * testable, and cannot be silently lost in a query rewrite.
 */
export function isSessionUsable(row: StoredSession | undefined, now: Date): row is StoredSession {
  if (!row) {
    return false;
  }

  if (row.revokedAt !== null) {
    return false;
  }

  return row.expiresAt.getTime() > now.getTime();
}

async function loadSession(idHash: string): Promise<StoredSession | undefined> {
  const rows = await getDb()
    .select({
      walletAddress: sessions.walletAddress,
      expiresAt: sessions.expiresAt,
      revokedAt: sessions.revokedAt,
      walletId: wallets.id,
      userId: wallets.userId,
    })
    .from(sessions)
    .innerJoin(wallets, eq(wallets.address, sessions.walletAddress))
    .where(eq(sessions.idHash, idHash))
    .limit(1);

  return rows[0];
}

/**
 * The one caller-identity read. Fails closed: no cookie, unknown id, revoked, expired, or
 * a database that will not answer all resolve to `null`.
 *
 * @param sessionId - Defaults to the request's cookie; passed explicitly only by tests.
 */
export async function resolveSession(
  sessionId: string | undefined = undefined,
): Promise<SessionIdentity | null> {
  const id = sessionId ?? (await readSessionCookie());

  if (!id) {
    return null;
  }

  const idHash = hashSessionId(id);
  const now = new Date();

  try {
    const row = await loadSession(idHash);

    if (!isSessionUsable(row, now)) {
      logger.info('session rejected', { known: row !== undefined });
      return null;
    }

    const expiresAt = sessionExpiryFrom(now);
    await getDb()
      .update(sessions)
      .set({ lastSeenAt: now, expiresAt })
      .where(eq(sessions.idHash, idHash));

    return {
      walletAddress: row.walletAddress,
      walletId: row.walletId,
      userId: row.userId,
      expiresAt,
    };
  } catch (error) {
    captureError(error, { failedClosed: true, operation: 'resolveSession' });

    return null;
  }
}

/**
 * Kills a session immediately — the account-switch path. The wallet the extension is now
 * pointing at is not the wallet this session was issued for, so the session must die
 * before anything can act under the wrong identity.
 */
export async function revokeSession(
  correlationId: string,
  sessionId: string | undefined = undefined,
): Promise<void> {
  const id = sessionId ?? (await readSessionCookie());

  if (!id) {
    return;
  }

  const revoked = await getDb()
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.idHash, hashSessionId(id)), isNull(sessions.revokedAt)))
    .returning({ walletAddress: sessions.walletAddress });

  const row = revoked[0];

  if (!row) {
    return;
  }

  await recordEvent({
    eventType: 'auth.session_revoked',
    occurredAt: new Date(),
    correlationId,
    payload: { walletAddress: row.walletAddress },
  });
}

/** Clears the cookie in the browser after a revoke; the row is already dead server-side. */
export function buildClearedSessionCookie(): SessionCookie {
  return buildSessionCookie('', new Date(0));
}
