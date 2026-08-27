import { compareUsd, migrateConstitution, parseConstitution, type Constitution, type LimitRule } from '@degencage/rules';
import { and, eq, isNull, lte, sql } from 'drizzle-orm';

import { captureError } from '../../observability/error-tracking';
import { recordEvent } from '../../observability/events';
import { resolveSession, type SessionIdentity } from '../auth/session';
import { getDb } from '../db/client';
import {
  constitutionPendingChanges,
  constitutions,
  type ConstitutionPendingChangeRow,
  type ConstitutionRow,
} from '../db/schema';

/**
 * Asymmetric constitution edits (decision 12): loosening a limit is *always* the slow path,
 * tightening is *always* immediate — the same friction-only-one-way shape as the commitment
 * period in `./commitment.ts`, applied to an already-active constitution instead of a draft.
 *
 * Only `maxUsd` is editable through this module. `windowHours` and `tier` are part of a
 * `LimitRule` too, but "wider window" and "shorter window" do not map onto "looser" and
 * "stricter" the same unambiguous way `maxUsd` does (a longer window can mean *less* spend
 * allowed per unit time, not more) — deciding that direction is future scope, not this
 * phase's.
 */

/** The 48h delay a limit *increase* sits through before it is folded into `document`. */
export const DELAYED_INCREASE_MS = 48 * 60 * 60 * 1_000;

export type PendingChangeRejectionReason =
  | 'unauthenticated'
  | 'no_active_constitution'
  | 'limit_not_found'
  | 'invalid_value'
  | 'no_change'
  | 'pending_change_exists'
  | 'pending_change_not_found';

export class PendingChangeRejected extends Error {
  constructor(readonly reason: PendingChangeRejectionReason) {
    super(`pending change rejected: ${reason}`);
    this.name = 'PendingChangeRejected';
  }
}

/** The HTTP status a route/action should answer for a given rejection. */
export function httpStatusForPendingChangeRejection(reason: PendingChangeRejectionReason): number {
  switch (reason) {
    case 'unauthenticated':
      return 401;
    case 'invalid_value':
      return 400;
    case 'no_active_constitution':
    case 'limit_not_found':
    case 'no_change':
    case 'pending_change_exists':
    case 'pending_change_not_found':
      return 409;
    default:
      return 400;
  }
}

async function requireSession(): Promise<SessionIdentity> {
  const session = await resolveSession();

  if (!session) {
    throw new PendingChangeRejected('unauthenticated');
  }

  return session;
}

/** The caller's *active* constitution — the only status this module ever edits. */
async function loadActiveConstitutionForUser(userId: string): Promise<ConstitutionRow> {
  const rows = await getDb()
    .select()
    .from(constitutions)
    .where(and(eq(constitutions.userId, userId), eq(constitutions.status, 'active')))
    .limit(1);

  const row = rows[0];

  if (!row) {
    throw new PendingChangeRejected('no_active_constitution');
  }

  return row;
}

function findLimit(document: Constitution, limitId: string): LimitRule {
  const limit = document.limits.find((candidate) => candidate.id === limitId);

  if (!limit) {
    throw new PendingChangeRejected('limit_not_found');
  }

  return limit;
}

/**
 * Validates a proposed `maxUsd` by building the whole would-be document and running it
 * through `parseConstitution` — reuses the one place that already knows what a legal
 * `LimitRule` looks like, rather than re-deriving "is this a positive decimal string" here.
 */
function withMaxUsd(document: Constitution, limitId: string, newMaxUsd: string): Constitution {
  const candidate: Constitution = {
    ...document,
    limits: document.limits.map((limit) => (limit.id === limitId ? { ...limit, maxUsd: newMaxUsd } : limit)),
  };

  const parsed = parseConstitution(candidate);

  if (!parsed.ok) {
    throw new PendingChangeRejected('invalid_value');
  }

  return parsed.constitution;
}

async function assertNoExistingPendingChange(constitutionId: string, limitId: string, field: string): Promise<void> {
  const rows = await getDb()
    .select({ id: constitutionPendingChanges.id })
    .from(constitutionPendingChanges)
    .where(
      and(
        eq(constitutionPendingChanges.constitutionId, constitutionId),
        eq(constitutionPendingChanges.limitId, limitId),
        eq(constitutionPendingChanges.field, field),
        isNull(constitutionPendingChanges.appliedAt),
      ),
    )
    .limit(1);

  if (rows[0]) {
    throw new PendingChangeRejected('pending_change_exists');
  }
}

export interface RequestLimitChangeResult {
  kind: 'applied' | 'pending';
  constitution: ConstitutionRow;
  pendingChange: ConstitutionPendingChangeRow | null;
}

/**
 * Decreasing `maxUsd` mutates `constitutions.document` in place, guarded by the same
 * TOCTOU-safe WHERE-carries-the-precondition shape as `commitment.ts`'s
 * `updateExistingDraft` — the UPDATE only ever matches a row that is still `active`, never a
 * preceding SELECT's stale view of it.
 */
async function applyDecreaseImmediately(
  session: SessionIdentity,
  constitutionRow: ConstitutionRow,
  document: Constitution,
  limitId: string,
  field: 'maxUsd',
  oldValue: string,
  newValue: string,
  correlationId: string,
): Promise<RequestLimitChangeResult> {
  const updated = await getDb()
    .update(constitutions)
    .set({ document })
    .where(and(eq(constitutions.id, constitutionRow.id), eq(constitutions.status, 'active')))
    .returning();

  const row = updated[0];

  if (!row) {
    throw new PendingChangeRejected('no_active_constitution');
  }

  await recordEvent({
    eventType: 'constitution.limit_decreased',
    occurredAt: new Date(),
    correlationId,
    userId: session.userId,
    payload: { constitutionId: row.id, limitId, field, oldValue, newValue },
  });

  return { kind: 'applied', constitution: row, pendingChange: null };
}

/**
 * Increasing `maxUsd` never touches `document` — it only inserts a pending row with
 * `effective_at = now() + 48h`, computed by Postgres' own clock so the delay cannot be
 * shortened by a client-claimed elapsed time, exactly like `commitment.ts`'s 20-minute
 * window.
 */
async function scheduleIncrease(
  session: SessionIdentity,
  constitutionRow: ConstitutionRow,
  limitId: string,
  field: 'maxUsd',
  oldValue: string,
  newValue: string,
  correlationId: string,
): Promise<RequestLimitChangeResult> {
  await assertNoExistingPendingChange(constitutionRow.id, limitId, field);

  const inserted = await getDb()
    .insert(constitutionPendingChanges)
    .values({
      constitutionId: constitutionRow.id,
      limitId,
      field,
      oldValue,
      newValue,
      effectiveAt: sql`now() + interval '1 millisecond' * ${DELAYED_INCREASE_MS}`,
    })
    .returning();

  const pendingChange = inserted[0]!;

  await recordEvent({
    eventType: 'constitution.limit_increase_requested',
    occurredAt: new Date(),
    correlationId,
    userId: session.userId,
    payload: {
      constitutionId: constitutionRow.id,
      limitId,
      field,
      oldValue,
      newValue,
      pendingChangeId: pendingChange.id,
      effectiveAt: pendingChange.effectiveAt.toISOString(),
    },
  });

  return { kind: 'pending', constitution: constitutionRow, pendingChange };
}

/**
 * Requests a change to one limit's `maxUsd` on the caller's active constitution. A decrease
 * applies immediately; an increase is parked for 48h (`scheduleIncrease`). Which path runs is
 * decided by `compareUsd` against the limit's *current* stored value — never by anything the
 * client claims about direction.
 */
export async function requestLimitChange(
  limitId: string,
  newMaxUsd: string,
  correlationId: string,
): Promise<RequestLimitChangeResult> {
  const session = await requireSession();
  const constitutionRow = await loadActiveConstitutionForUser(session.userId);
  const document = migrateConstitution(constitutionRow.document);
  const limit = findLimit(document, limitId);
  const oldValue = limit.maxUsd;

  const candidateDocument = withMaxUsd(document, limitId, newMaxUsd);
  const direction = compareUsd(newMaxUsd, oldValue);

  if (direction === 0) {
    throw new PendingChangeRejected('no_change');
  }

  if (direction < 0) {
    return applyDecreaseImmediately(
      session,
      constitutionRow,
      candidateDocument,
      limitId,
      'maxUsd',
      oldValue,
      newMaxUsd,
      correlationId,
    );
  }

  return scheduleIncrease(session, constitutionRow, limitId, 'maxUsd', oldValue, newMaxUsd, correlationId);
}

/** The caller's in-flight pending changes — what the edit page renders as countdowns. */
export async function loadPendingChangesForCurrentUser(): Promise<ConstitutionPendingChangeRow[]> {
  const session = await resolveSession();

  if (!session) {
    return [];
  }

  const constitutionRow = await getDb()
    .select({ id: constitutions.id })
    .from(constitutions)
    .where(and(eq(constitutions.userId, session.userId), eq(constitutions.status, 'active')))
    .limit(1);

  const constitutionId = constitutionRow[0]?.id;

  if (!constitutionId) {
    return [];
  }

  return getDb()
    .select()
    .from(constitutionPendingChanges)
    .where(and(eq(constitutionPendingChanges.constitutionId, constitutionId), isNull(constitutionPendingChanges.appliedAt)));
}

/**
 * Cancels one of the caller's own not-yet-applied pending changes. Ownership is proven by
 * joining through the caller's *own* active constitution row, never by trusting the id alone
 * — the same "identity from the session, not the request" invariant as everything else in
 * `server/constitution/*`.
 */
export async function cancelPendingChange(pendingChangeId: string, correlationId: string): Promise<void> {
  const session = await requireSession();
  const constitutionRow = await loadActiveConstitutionForUser(session.userId);

  const deleted = await getDb()
    .delete(constitutionPendingChanges)
    .where(
      and(
        eq(constitutionPendingChanges.id, pendingChangeId),
        eq(constitutionPendingChanges.constitutionId, constitutionRow.id),
        isNull(constitutionPendingChanges.appliedAt),
      ),
    )
    .returning();

  const row = deleted[0];

  if (!row) {
    throw new PendingChangeRejected('pending_change_not_found');
  }

  await recordEvent({
    eventType: 'constitution.limit_increase_cancelled',
    occurredAt: new Date(),
    correlationId,
    userId: session.userId,
    payload: {
      constitutionId: constitutionRow.id,
      limitId: row.limitId,
      field: row.field,
      oldValue: row.oldValue,
      newValue: row.newValue,
      pendingChangeId: row.id,
    },
  });
}

/**
 * Atomically claims and applies exactly one due pending change, inside a single transaction
 * so "marked applied" and "folded into `document`" can never split apart on a crash. Re-reads
 * `applied_at IS NULL AND effective_at <= now()` under `FOR UPDATE` right before applying, so
 * two concurrent calls to `applyDuePendingChanges` (two app-open reconciliations racing) can
 * both attempt this row without double-applying it — the second transaction's row lock waits,
 * then sees `applied_at` already set and does nothing.
 *
 * Returns `false` when the row was already applied/cancelled/not yet due by the time this
 * transaction got the lock — never an error, since that is the expected shape of the race
 * above, not a failure.
 */
async function applyOneDuePendingChange(pendingChangeId: string, correlationId: string): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const pendingRows = await tx
      .select()
      .from(constitutionPendingChanges)
      .where(
        and(
          eq(constitutionPendingChanges.id, pendingChangeId),
          isNull(constitutionPendingChanges.appliedAt),
          lte(constitutionPendingChanges.effectiveAt, sql`now()`),
        ),
      )
      .for('update')
      .limit(1);

    const pending = pendingRows[0];

    if (!pending) {
      return false;
    }

    const constitutionRows = await tx
      .select()
      .from(constitutions)
      .where(eq(constitutions.id, pending.constitutionId))
      .for('update')
      .limit(1);

    const constitutionRow = constitutionRows[0];

    if (!constitutionRow) {
      // The constitution this pending row referenced is gone — should be unreachable (rows
      // are never deleted), but fail closed and make it visible rather than throwing away the
      // pending row silently.
      captureError(new Error('pending change references a missing constitution'), {
        correlationId,
        pendingChangeId: pending.id,
      });

      return false;
    }

    const document = migrateConstitution(constitutionRow.document);
    const newDocument = withMaxUsd(document, pending.limitId, pending.newValue);

    await tx.update(constitutions).set({ document: newDocument }).where(eq(constitutions.id, constitutionRow.id));

    const appliedRows = await tx
      .update(constitutionPendingChanges)
      .set({ appliedAt: sql`now()` })
      .where(eq(constitutionPendingChanges.id, pending.id))
      .returning();

    const appliedAt = appliedRows[0]?.appliedAt ?? new Date();

    await recordEvent(
      {
        eventType: 'constitution.limit_increase_applied',
        occurredAt: appliedAt,
        correlationId,
        userId: constitutionRow.userId,
        payload: {
          constitutionId: constitutionRow.id,
          limitId: pending.limitId,
          field: pending.field,
          oldValue: pending.oldValue,
          newValue: pending.newValue,
          pendingChangeId: pending.id,
        },
      },
      tx,
    );

    return true;
  });
}

/**
 * Applies every pending change whose 48h has elapsed, across every user's constitution.
 * Piggybacks on the existing app-open reconciliation entry point
 * (`POST /api/wallet/reconcile`) rather than a scheduler — this is Phase 0's only "lazy cron"
 * pattern (`.ai/decisions/hosting-and-growth-path.md`), already used the same way for chain
 * reconciliation itself.
 *
 * Deliberately not scoped to the caller's own session: whoever happens to open the app first
 * after a change's `effective_at` passes is what applies it, for every user with a due row —
 * not only their own — so a change that becomes due while its owner is away still applies
 * "even if the user reloads, closes the tab, or the change is checked well past its due time"
 * (this phase's success criteria), the moment *anyone's* reconcile call runs.
 */
export async function applyDuePendingChanges(correlationId: string): Promise<number> {
  const dueRows = await getDb()
    .select({ id: constitutionPendingChanges.id })
    .from(constitutionPendingChanges)
    .where(and(isNull(constitutionPendingChanges.appliedAt), lte(constitutionPendingChanges.effectiveAt, sql`now()`)));

  let appliedCount = 0;

  for (const dueRow of dueRows) {
    try {
      const applied = await applyOneDuePendingChange(dueRow.id, correlationId);

      if (applied) {
        appliedCount += 1;
      }
    } catch (error) {
      captureError(error, { correlationId, operation: 'applyDuePendingChanges', pendingChangeId: dueRow.id });
    }
  }

  return appliedCount;
}

/** The wire shape the edit page renders — one place computing the countdown-to-effective. */
export interface SerializedPendingChange {
  id: string;
  limitId: string;
  field: string;
  oldValue: string;
  newValue: string;
  effectiveAt: string;
  remainingMs: number;
}

export function serializePendingChange(row: ConstitutionPendingChangeRow, now: Date): SerializedPendingChange {
  return {
    id: row.id,
    limitId: row.limitId,
    field: row.field,
    oldValue: row.oldValue,
    newValue: row.newValue,
    effectiveAt: row.effectiveAt.toISOString(),
    remainingMs: Math.max(0, row.effectiveAt.getTime() - now.getTime()),
  };
}
