import { createHash, randomBytes } from 'node:crypto';

import { and, eq, isNull } from 'drizzle-orm';
import { cookies } from 'next/headers';

import { captureError } from '../../observability/error-tracking';
import { recordEvent, type DatabaseExecutor } from '../../observability/events';
import { logger } from '../../observability/logger';
import { getDb } from '../db/client';
import { sessions, users, wallets } from '../db/schema';
import { expireAllLiveIntentsForWallet } from '../swap/intent-lifecycle';

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

/**
 * The ceiling the sliding window cannot climb over: measured from `created_at`, so it is a
 * function of when the wallet last *proved* it holds the key and of nothing the holder of
 * the cookie does afterwards.
 *
 * A purely sliding session is immortal — stay active and it never has to be re-proved,
 * which is exactly the property a stolen cookie wants. In a product whose whole premise is
 * that the user's rules outlive their impulses, "this wallet is still yours" is a claim
 * that has to be renewed on a schedule, not one that renews itself by being used. Ninety
 * days: long enough that a disciplined user is not re-signing constantly, short enough that
 * a session outliving the wallet that opened it is measured in weeks, not years.
 */
export const SESSION_ABSOLUTE_MAX_LIFETIME_MS = 90 * 24 * 60 * 60 * 1_000;

/** The instant a session dies no matter how recently it was used. */
function absoluteDeadline(createdAt: Date): Date {
  return new Date(createdAt.getTime() + SESSION_ABSOLUTE_MAX_LIFETIME_MS);
}

export interface SessionIdentity {
  walletAddress: string;
  walletId: string;
  userId: string;
  expiresAt: Date;
  /**
   * The session's key at rest — the hash, never the cookie value, which never leaves the
   * browser. Carried so the supersede *inside* a sign-in transaction can revoke this
   * exact session — the one the request arrived with — from an executor that has no
   * request context of its own to read a cookie from.
   */
  idHash: string;
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

function earlier(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
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
  const idHash = hashSessionId(sessionId);
  const expiresAt = sessionExpiryFrom(new Date());

  await executor.insert(sessions).values({ idHash, walletAddress, expiresAt });

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
    idHash,
    cookie: buildSessionCookie(sessionId, expiresAt),
  };
}

async function readSessionCookie(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE_NAME)?.value;
}

export interface StoredSession {
  walletAddress: string;
  /** When the signature that created this session was verified — the absolute clock's zero. */
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  walletId: string;
  userId: string;
}

/**
 * Pure decision: is this stored session still good? Revocation, the absolute ceiling and
 * the sliding expiry are checked here rather than folded into the `WHERE` clause so each is
 * visible, individually testable, and cannot be silently lost in a query rewrite.
 *
 * The ceiling is checked *independently* of `expires_at`, and not by clamping the stored
 * value: a row written before the cap existed, or by a future code path that forgets to
 * clamp, still dies on time.
 */
export function isSessionUsable(row: StoredSession | undefined, now: Date): row is StoredSession {
  if (!row) {
    return false;
  }

  if (row.revokedAt !== null) {
    return false;
  }

  if (absoluteDeadline(row.createdAt).getTime() <= now.getTime()) {
    return false;
  }

  return row.expiresAt.getTime() > now.getTime();
}

async function loadSession(idHash: string): Promise<StoredSession | undefined> {
  const rows = await getDb()
    .select({
      walletAddress: sessions.walletAddress,
      createdAt: sessions.createdAt,
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

export interface ResolveSessionOptions {
  /**
   * Push the expiry horizon back out (decision 15). Off for a caller that is only
   * identifying the session in order to revoke it: sliding a session forward one
   * statement before killing it is pointless write traffic, and it briefly extends the
   * life of exactly the session we decided should not have one.
   */
  slideExpiry?: boolean;
}

/**
 * The one caller-identity read. Fails closed: no cookie, unknown id, revoked, expired, or
 * a database that will not answer all resolve to `null`.
 *
 * @param sessionId - Defaults to the request's cookie; passed explicitly only by tests.
 */
export async function resolveSession(
  sessionId: string | undefined = undefined,
  { slideExpiry = true }: ResolveSessionOptions = {},
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

    // The slide may push the horizon out, never past the ceiling — so a session's last
    // hours are not silently extended into another thirty days by one late request.
    const expiresAt = slideExpiry
      ? earlier(sessionExpiryFrom(now), absoluteDeadline(row.createdAt))
      : row.expiresAt;

    if (slideExpiry) {
      await getDb()
        .update(sessions)
        .set({ lastSeenAt: now, expiresAt })
        .where(eq(sessions.idHash, idHash));
    }

    return {
      walletAddress: row.walletAddress,
      walletId: row.walletId,
      userId: row.userId,
      expiresAt,
      idHash,
    };
  } catch (error) {
    captureError(error, { failedClosed: true, operation: 'resolveSession' });

    return null;
  }
}

/**
 * Why a session died. A closed set, resolved server-side: a caller may *annotate* a
 * revocation it asked for, but it can never invent one — an unrecognised value collapses
 * to `client_request` rather than being written into the audit trail verbatim.
 */
export const SESSION_REVOCATION_REASONS = [
  'account_switch',
  'wallet_disconnected',
  'superseded_by_sign_in',
  'client_request',
] as const;

export type SessionRevocationReason = (typeof SESSION_REVOCATION_REASONS)[number];

export function parseRevocationReason(value: string | null | undefined): SessionRevocationReason {
  return SESSION_REVOCATION_REASONS.includes(value as SessionRevocationReason)
    ? (value as SessionRevocationReason)
    : 'client_request';
}

/**
 * The account-switch half of session revocation (Phase 4): the wallet's quote-slot intent
 * (`quoted`/`approved`) dies with the session, unconditionally — not just the ones that
 * happened to have timed out. An unsigned quote must never outlive the wallet it was quoted
 * against.
 *
 * A `signed`/`submitted` intent is deliberately left alone: it already left the building
 * before the switch, and its reservation must keep holding allowance against the *old* wallet
 * until Phase 5 reconciliation resolves it — expiring it here would free that allowance while
 * the broadcast trade is still outstanding.
 *
 * Only ever called with a real `walletId` from `revokeSessionByIdHash`, below, and only when
 * `reason === 'account_switch'` — never for an ordinary logout or supersede-by-same-wallet,
 * which have nothing to invalidate.
 */
async function expireLiveIntentsForSwitchedWallet(
  executor: DatabaseExecutor,
  correlationId: string,
  userId: string | null,
  walletId: string,
): Promise<void> {
  const expiredIds = await expireAllLiveIntentsForWallet(walletId, executor);

  for (const intentId of expiredIds) {
    await recordEvent(
      {
        eventType: 'trade.intent_expired',
        occurredAt: new Date(),
        correlationId,
        userId,
        payload: { intentId, walletId, reason: 'account_switch' },
      },
      executor,
    );
  }
}

/**
 * Revokes one session by its key at rest, through whichever executor the caller is in.
 *
 * `WHERE revoked_at IS NULL` keeps it idempotent: a second revoke of the same row matches
 * nothing, so a retry cannot re-stamp the time of death or double-record the event.
 *
 * @param executor - Pass an open transaction to make the revoke atomic with whatever
 *   replaces the session; defaults to the pooled client for a standalone revoke.
 * @param walletId - The wallet the dying session was bound to, when the caller already has
 *   it (`supersedePreviousSession` does, from `previous.walletId`; the client-watcher's
 *   `revokeSession` is handed it by the route that already resolved it for
 *   `auth.wallet_account_switched`). `null` skips the account-switch intent expiry below
 *   rather than looking the wallet up — this function must not gain a new query path that a
 *   test mocking only `sessions` cannot see coming.
 * @returns Whether this call was the one that killed it.
 */
async function revokeSessionByIdHash(
  executor: DatabaseExecutor,
  idHash: string,
  correlationId: string,
  reason: SessionRevocationReason,
  userId: string | null = null,
  walletId: string | null = null,
): Promise<boolean> {
  const revoked = await executor
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.idHash, idHash), isNull(sessions.revokedAt)))
    .returning({ walletAddress: sessions.walletAddress });

  const row = revoked[0];

  if (!row) {
    return false;
  }

  logger.warn('session revoked', { correlationId, reason, walletAddress: row.walletAddress });

  await recordEvent(
    {
      eventType: 'auth.session_revoked',
      occurredAt: new Date(),
      correlationId,
      userId,
      payload: { walletAddress: row.walletAddress, reason },
    },
    executor,
  );

  if (reason === 'account_switch' && walletId) {
    await expireLiveIntentsForSwitchedWallet(executor, correlationId, userId, walletId);
  }

  return true;
}

/**
 * Kills a session immediately — the account-switch path. The wallet the extension is now
 * pointing at is not the wallet this session was issued for, so the session must die
 * before anything can act under the wrong identity.
 *
 * Which session dies is decided by the cookie alone. A throw here is *not* swallowed: the
 * caller must translate it into a failed response rather than report a sign-out that did
 * not happen.
 *
 * @param walletId - The wallet this session was bound to, when the caller already resolved it
 *   (`app/api/auth/verify/route.ts`'s `DELETE` handler, for `reason: 'account_switch'`) — see
 *   `revokeSessionByIdHash`'s doc for why this is threaded through rather than looked up here.
 * @param userId - Same shape, for the `trade.intent_expired` events the switch may write.
 */
export async function revokeSession(
  correlationId: string,
  reason: SessionRevocationReason,
  sessionId: string | undefined = undefined,
  walletId: string | null = null,
  userId: string | null = null,
): Promise<void> {
  const id = sessionId ?? (await readSessionCookie());

  if (!id) {
    return;
  }

  await revokeSessionByIdHash(getDb(), hashSessionId(id), correlationId, reason, userId, walletId);
}

/**
 * The server-side half of account-switch detection, and the reason a stale session cannot
 * outlive a re-connect.
 *
 * A sign-in proves ownership of exactly one address. Whatever session the request arrived
 * with is superseded by that proof — always, so sessions never pile up — and when the two
 * addresses disagree the old one was bound to an identity the wallet has moved off. That
 * is the switch, observed where it cannot be skipped: the client watcher can miss it (the
 * extension may simply stop reporting an account), this cannot.
 *
 * Both addresses come from the server: `previous` from `resolveSession()` (the cookie),
 * `verifiedAddress` from the signature. Nothing here is taken from the request body, and
 * the only session it can ever touch is the caller's own — `previous.idHash` is derived
 * from the cookie that arrived on this request, never from anything the caller can name.
 *
 * **Runs inside the sign-in transaction.** Revoke, nonce-consume and new-session-insert
 * commit together or not at all. Split across transactions, a failed revoke left the old
 * wrong-identity session live *and* cookied while the nonce was already burnt and the new
 * session already committed — the exact hole this whole path exists to close. A throw
 * here must therefore roll the sign-in back, so it is deliberately not caught.
 */
export async function supersedePreviousSession(
  executor: DatabaseExecutor,
  previous: SessionIdentity | null,
  verifiedAddress: string,
  correlationId: string,
): Promise<void> {
  if (!previous) {
    return;
  }

  const switched = previous.walletAddress !== verifiedAddress;

  if (switched) {
    logger.warn('wallet account switch detected', {
      correlationId,
      previousAddress: previous.walletAddress,
      verifiedAddress,
    });

    await recordEvent(
      {
        eventType: 'auth.wallet_account_switched',
        occurredAt: new Date(),
        correlationId,
        userId: previous.userId,
        payload: { previousAddress: previous.walletAddress, verifiedAddress },
      },
      executor,
    );
  }

  const revoked = await revokeSessionByIdHash(
    executor,
    previous.idHash,
    correlationId,
    switched ? 'account_switch' : 'superseded_by_sign_in',
    previous.userId,
    previous.walletId,
  );

  if (!revoked) {
    // Already dead — revoked by the watcher or a racing sign-in between our read and this
    // write. Nothing survives the transaction either way, but a session that resolved a
    // moment ago and is gone now is worth seeing.
    logger.info('previous session was already revoked', { correlationId });
  }
}

/** Clears the cookie in the browser after a revoke; the row is already dead server-side. */
export function buildClearedSessionCookie(): SessionCookie {
  return buildSessionCookie('', new Date(0));
}
