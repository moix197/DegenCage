import { migrateConstitution, parseConstitution, type Constitution } from '@degencage/rules';
import { and, eq, sql } from 'drizzle-orm';

import { captureError } from '../../observability/error-tracking';
import { recordEvent } from '../../observability/events';
import { resolveSession } from '../auth/session';
import { getDb } from '../db/client';
import { constitutions, type ConstitutionRow, type ConstitutionStatus } from '../db/schema';
import { assertWithinConstitutionActionRateLimit, ConstitutionActionRateLimited } from './rate-limit';

/**
 * Authoring, committing and activating a trading constitution.
 *
 * `resolveSession()` is the only source of caller identity here, exactly as in
 * `server/auth/session.ts` — no function in this module takes a wallet or user id as a
 * parameter, so a forged `wallet_id` in a request body has nothing to attach to. The
 * 20-minute commitment period is enforced against `commitment_started_at` compared to a
 * server `Date`, never a client-claimed elapsed time.
 */

/** The commitment period a drafted constitution must sit through before it can activate. */
export const COMMITMENT_PERIOD_MS = 20 * 60 * 1_000;

/** Kill switch for the whole authoring flow — seeded by `src/server/db/seed.ts`. */
export const CONSTITUTION_AUTHOR_FLAG = 'constitution.author';

export type ConstitutionRejectionReason =
  | 'unauthenticated'
  | 'invalid_document'
  | 'not_editable'
  | 'no_draft_to_commit'
  | 'no_committing_constitution'
  | 'commitment_not_elapsed';

export class ConstitutionActionRejected extends Error {
  constructor(readonly reason: ConstitutionRejectionReason) {
    super(`constitution action rejected: ${reason}`);
    this.name = 'ConstitutionActionRejected';
  }
}

/** The HTTP status a route should answer for a given rejection — kept next to the reasons. */
export function httpStatusForRejection(reason: ConstitutionRejectionReason): number {
  switch (reason) {
    case 'unauthenticated':
      return 401;
    case 'invalid_document':
      return 400;
    case 'not_editable':
    case 'no_draft_to_commit':
    case 'no_committing_constitution':
      return 409;
    case 'commitment_not_elapsed':
      // 425 Too Early (RFC 8470) — the precise semantics of "the server refuses this until
      // a condition it tracks has been met", not a generic conflict or bad request.
      return 425;
    default:
      return 400;
  }
}

export interface ConstitutionRecord {
  id: string;
  userId: string;
  walletId: string;
  status: ConstitutionStatus;
  document: Constitution;
  commitmentStartedAt: Date | null;
  activatedAt: Date | null;
}

function toRecord(row: ConstitutionRow): ConstitutionRecord {
  return {
    id: row.id,
    userId: row.userId,
    walletId: row.walletId,
    status: row.status,
    document: migrateConstitution(row.document),
    commitmentStartedAt: row.commitmentStartedAt,
    activatedAt: row.activatedAt,
  };
}

async function loadConstitutionForUser(userId: string): Promise<ConstitutionRow | undefined> {
  const rows = await getDb()
    .select()
    .from(constitutions)
    .where(eq(constitutions.userId, userId))
    .limit(1);

  return rows[0];
}

async function requireSession() {
  const session = await resolveSession();

  if (!session) {
    throw new ConstitutionActionRejected('unauthenticated');
  }

  return session;
}

/**
 * Records an event, but never faster than that event type's per-user rate limit allows
 * (`./rate-limit.ts`). Guards the WRITE only, never the action it describes — a session
 * looping `/activate` before the deadline still gets its (correct) rejection every time;
 * only the audit trail stops growing once it has enough rows to prove the pattern. A
 * rate-limit-check failure — throttled or not — never turns a successful user action into
 * a 503: it just skips the write, the same way `recordSignInRejection` fails closed on its
 * own bookkeeping without failing the sign-in it describes.
 */
async function recordEventWithinRateLimit(
  eventType: string,
  userId: string,
  correlationId: string,
  occurredAt: Date,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await assertWithinConstitutionActionRateLimit(userId, eventType, correlationId, occurredAt);
  } catch (error) {
    if (error instanceof ConstitutionActionRateLimited) {
      return;
    }

    captureError(error, { correlationId, operation: 'constitutionActionRateLimit', eventType });

    return;
  }

  await recordEvent({ eventType, occurredAt, correlationId, userId, payload });
}

/**
 * The TOCTOU-safe half of `saveDraftConstitution`'s write: the WHERE carries the
 * precondition, not a preceding SELECT, exactly like `verifyWalletSignIn`'s nonce-consume
 * guard in `server/auth/solana-siws.ts`. Closes the race where `startCommitment` (or a
 * concurrent save) flips this row to `committing` between the read above and this write —
 * without this guard the UPDATE would match on `id` alone and silently overwrite the
 * document, and reset nothing about the clock, on a constitution the caller no longer has
 * open authoring rights over.
 */
async function updateExistingDraft(
  constitutionId: string,
  values: { document: Constitution; schemaVersion: number },
): Promise<ConstitutionRow> {
  const updated = await getDb()
    .update(constitutions)
    .set(values)
    .where(and(eq(constitutions.id, constitutionId), eq(constitutions.status, 'draft')))
    .returning();

  const row = updated[0];

  if (!row) {
    throw new ConstitutionActionRejected('not_editable');
  }

  return row;
}

/**
 * Creates or updates the caller's draft constitution.
 *
 * Validated against `parseConstitution` before it ever reaches the database — the server
 * accepts any well-formed `LimitRule`, even the two types the authoring UI does not offer
 * yet, so Phases 5/6 can add UI for them without a server change. Only a `draft` may be
 * edited this way; loosening or replacing an already-committed/active constitution is
 * Phase 8's timelocked pending-change mechanism, not this endpoint.
 */
export async function saveDraftConstitution(
  rawDocument: unknown,
  correlationId: string,
): Promise<ConstitutionRecord> {
  const session = await requireSession();

  const parsed = parseConstitution(rawDocument);

  if (!parsed.ok) {
    throw new ConstitutionActionRejected('invalid_document');
  }

  const existing = await loadConstitutionForUser(session.userId);

  if (existing && existing.status !== 'draft') {
    throw new ConstitutionActionRejected('not_editable');
  }

  const values = {
    document: parsed.constitution,
    schemaVersion: parsed.constitution.schemaVersion,
  };

  const row = existing
    ? await updateExistingDraft(existing.id, values)
    : (
        await getDb()
          .insert(constitutions)
          .values({ userId: session.userId, walletId: session.walletId, status: 'draft', ...values })
          .returning()
      )[0]!;

  await recordEventWithinRateLimit('constitution.drafted', session.userId, correlationId, new Date(), {
    constitutionId: row.id,
    limitTypes: parsed.constitution.limits.map((limit) => limit.type),
  });

  return toRecord(row);
}

/** The caller's constitution, if any — used to render the authoring page and drive the countdown. */
export async function loadCurrentConstitution(): Promise<ConstitutionRecord | null> {
  const session = await resolveSession();

  if (!session) {
    return null;
  }

  const row = await loadConstitutionForUser(session.userId);

  return row ? toRecord(row) : null;
}

/**
 * Starts the 20-minute commitment period on the caller's draft.
 *
 * Idempotent: re-calling while already `committing` re-checks and returns the existing
 * row rather than resetting `commitment_started_at` or erroring — a double-click must not
 * restart the clock.
 */
export async function startCommitment(correlationId: string): Promise<ConstitutionRecord> {
  const session = await requireSession();

  // Written as the database's own `now()`, not this process' `Date`: `activateConstitution`
  // compares this column against the database's clock too, so the 20-minute window is
  // measured entirely by one clock, regardless of which app instance answers either request.
  const started = await getDb()
    .update(constitutions)
    .set({ status: 'committing', commitmentStartedAt: sql`now()` })
    .where(and(eq(constitutions.userId, session.userId), eq(constitutions.status, 'draft')))
    .returning();

  if (started[0]) {
    await recordEvent({
      eventType: 'constitution.commitment_started',
      occurredAt: started[0].commitmentStartedAt ?? new Date(),
      correlationId,
      userId: session.userId,
      payload: { constitutionId: started[0].id },
    });

    return toRecord(started[0]);
  }

  const current = await loadConstitutionForUser(session.userId);

  if (!current) {
    throw new ConstitutionActionRejected('no_draft_to_commit');
  }

  // Already committing or active — a re-click, or a race with another request that won.
  // Re-check rather than error: the caller's next poll/activate sees accurate state.
  return toRecord(current);
}

/**
 * Attempts the activation write atomically: it only ever matches a row that is still
 * `committing`, belongs to this user, *and* whose commitment period has actually elapsed —
 * exactly as `verifyWalletSignIn`'s nonce-consume guards a single-use row. This is what
 * makes two concurrent activation attempts safe — at most one flips the row.
 *
 * The deadline is computed by the database's own `now()`, never this process' `Date`:
 * `commitment_started_at` was written by whichever app instance handled `startCommitment`,
 * so comparing it against *this* instance's clock would let the 20-minute window drift by
 * however far the two instances' clocks disagree. One clock, in Postgres, on both sides.
 */
async function attemptAtomicActivation(userId: string): Promise<ConstitutionRow | undefined> {
  const rows = await getDb()
    .update(constitutions)
    .set({ status: 'active', activatedAt: sql`now()` })
    .where(
      and(
        eq(constitutions.userId, userId),
        eq(constitutions.status, 'committing'),
        sql`${constitutions.commitmentStartedAt} <= now() - interval '1 millisecond' * ${COMMITMENT_PERIOD_MS}`,
      ),
    )
    .returning();

  return rows[0];
}

/**
 * Activates the caller's constitution — the server-side gate a replayed or forged
 * "activate now" request cannot get past.
 *
 * Elapsed time is computed entirely from `commitment_started_at` (set by `startCommitment`)
 * against `new Date()` on this server; nothing about the request body factors in. Idempotent:
 * re-activating an already-active constitution is a no-op, not an error, and a race between
 * two activation attempts after the deadline never produces a false
 * `activation_rejected_early` for the request that merely lost the race.
 */
export async function activateConstitution(correlationId: string): Promise<ConstitutionRecord> {
  const session = await requireSession();

  const activated = await attemptAtomicActivation(session.userId);

  if (activated) {
    await recordEvent({
      eventType: 'constitution.activated',
      occurredAt: activated.activatedAt ?? new Date(),
      correlationId,
      userId: session.userId,
      payload: { constitutionId: activated.id },
    });

    return toRecord(activated);
  }

  const current = await loadConstitutionForUser(session.userId);
  const now = new Date();

  if (!current || current.status === 'draft') {
    throw new ConstitutionActionRejected('no_committing_constitution');
  }

  if (current.status === 'active') {
    // Already active: a re-click after success, or the loser of a race the atomic update
    // above already resolved correctly. Idempotent no-op, not a rejection.
    return toRecord(current);
  }

  if (current.commitmentStartedAt === null) {
    // Should be unreachable: `commitmentStartedAt` is only nullable in the type because the
    // column is, but every row this branch can see has `status = 'committing'`, which only
    // `startCommitment` sets, and it always sets both together. Never trust that invariant
    // with a non-null assertion on a money-adjacent path — fail closed and make it visible.
    captureError(new Error('constitution is committing with no commitmentStartedAt'), {
      correlationId,
      constitutionId: current.id,
    });

    throw new ConstitutionActionRejected('no_committing_constitution');
  }

  // Still committing, and the atomic update above proves the deadline has not passed —
  // otherwise it would have matched. This is the early/forged/replayed activation case.
  const elapsedMs = now.getTime() - current.commitmentStartedAt.getTime();

  await recordEventWithinRateLimit('constitution.activation_rejected_early', session.userId, correlationId, now, {
    constitutionId: current.id,
    elapsedMs,
    requiredMs: COMMITMENT_PERIOD_MS,
  });

  throw new ConstitutionActionRejected('commitment_not_elapsed');
}

/** The wire shape all three routes answer with — one place computing the countdown. */
export interface SerializedConstitution {
  id: string;
  status: ConstitutionStatus;
  document: Constitution;
  commitmentStartedAt: string | null;
  activatedAt: string | null;
  /**
   * Server-computed remaining time on the commitment period, or `null` outside `committing`.
   * The client reads this rather than deriving "20 minutes have passed" from its own clock;
   * the authoritative check happens again, server-side, the moment "Activate" is clicked.
   */
  remainingMs: number | null;
}

export function serializeConstitutionRecord(record: ConstitutionRecord, now: Date): SerializedConstitution {
  const remainingMs =
    record.status === 'committing' && record.commitmentStartedAt
      ? Math.max(0, record.commitmentStartedAt.getTime() + COMMITMENT_PERIOD_MS - now.getTime())
      : null;

  return {
    id: record.id,
    status: record.status,
    document: record.document,
    commitmentStartedAt: record.commitmentStartedAt?.toISOString() ?? null,
    activatedAt: record.activatedAt?.toISOString() ?? null,
    remainingMs,
  };
}
