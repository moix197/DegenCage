import { compareUsd, migrateConstitution, parseConstitution, type Constitution, type LimitRule } from '@degencage/rules';
import { and, asc, count, eq, isNull, lte, sql, type SQL } from 'drizzle-orm';

import { captureError } from '../../observability/error-tracking';
import { recordEvent } from '../../observability/events';
import { logger } from '../../observability/logger';
import { resolveSession, type SessionIdentity } from '../auth/session';
import { getDb } from '../db/client';
import {
  constitutionPendingChanges,
  constitutions,
  type ConstitutionPendingChangeRow,
  type ConstitutionRow,
} from '../db/schema';
import { isFeatureEnabled } from '../flags/feature-flags';

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

/**
 * Dedicated kill switch for the *apply* half of this module — separate from
 * `CONSTITUTION_AUTHOR_FLAG` (which gates requesting/cancelling a change) and from
 * `CHAIN_HELIUS_RECONCILE_FLAG` (an unrelated integration switch that `POST
 * /api/wallet/reconcile` happens to also be gated by). Off, `applyDuePendingChanges` is a
 * no-op: a due increase stays pending rather than applying while this surface is being
 * rolled back, and no row is claimed, voided, or otherwise mutated. Seeded enabled by
 * `src/server/db/seed.ts`, same as every other flag in this codebase — unseeded would mean
 * "always off" (fail closed), which would silently reintroduce "a due increase never
 * applies" by default.
 */
export const CONSTITUTION_PENDING_CHANGE_APPLY_FLAG = 'constitution.pending_change_apply';

/** Caps how many due rows one `applyDuePendingChanges` call processes — see finding #8. */
const PENDING_CHANGE_APPLY_BATCH_LIMIT = 50;

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

/** Still actionable: neither applied nor voided yet. */
function stillPending(...conditions: (SQL | undefined)[]): SQL | undefined {
  return and(...conditions, isNull(constitutionPendingChanges.appliedAt), isNull(constitutionPendingChanges.voidedAt));
}

async function assertNoExistingPendingChange(constitutionId: string, limitId: string, field: string): Promise<void> {
  const rows = await getDb()
    .select({ id: constitutionPendingChanges.id })
    .from(constitutionPendingChanges)
    .where(
      stillPending(
        eq(constitutionPendingChanges.constitutionId, constitutionId),
        eq(constitutionPendingChanges.limitId, limitId),
        eq(constitutionPendingChanges.field, field),
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
    .where(stillPending(eq(constitutionPendingChanges.constitutionId, constitutionId)));
}

/**
 * Cancels one of the caller's own not-yet-resolved pending changes. Ownership is proven by
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
      stillPending(
        eq(constitutionPendingChanges.id, pendingChangeId),
        eq(constitutionPendingChanges.constitutionId, constitutionRow.id),
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

/** What became of one due row after `applyOneDuePendingChange` got the lock on it. */
type ApplyOutcome = 'applied' | 'voided' | 'none';

/**
 * Atomically claims and resolves exactly one due pending change, inside a single transaction
 * so "marked resolved" and "folded into `document`" (when it applies) can never split apart
 * on a crash. Re-reads `applied_at IS NULL AND voided_at IS NULL AND effective_at <= now()`
 * under `FOR UPDATE` right before resolving, so two concurrent calls to
 * `applyDuePendingChanges` (two app-open loads racing) can both attempt this row without
 * double-resolving it — the second transaction's row lock waits, then sees the row already
 * resolved and does nothing.
 *
 * Before applying, re-checks the limit's *current* `maxUsd` against `pending.oldValue`
 * (`asymmetric-constitution-edits.md`, `.ai/decisions/`): if a decrease — or a different
 * increase — already moved the value since this row was requested, `pending.newValue` is no
 * longer an increase *from the value the user actually saw*. Applying it anyway would grant
 * an increase nobody asked for from the constitution's current state. That row is voided
 * instead — `voided_at` set, `document` untouched, `constitution.limit_increase_voided`
 * recorded with both the expected and observed values — never silently dropped or applied.
 *
 * Returns `'none'` when the row was already resolved or not yet due by the time this
 * transaction got the lock — never an error, since that is the expected shape of the race
 * above, not a failure.
 */
async function applyOneDuePendingChange(pendingChangeId: string, correlationId: string): Promise<ApplyOutcome> {
  return getDb().transaction(async (tx) => {
    const pendingRows = await tx
      .select()
      .from(constitutionPendingChanges)
      .where(
        and(
          eq(constitutionPendingChanges.id, pendingChangeId),
          isNull(constitutionPendingChanges.appliedAt),
          isNull(constitutionPendingChanges.voidedAt),
          lte(constitutionPendingChanges.effectiveAt, sql`now()`),
        ),
      )
      .for('update')
      .limit(1);

    const pending = pendingRows[0];

    if (!pending) {
      return 'none';
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

      return 'none';
    }

    const document = migrateConstitution(constitutionRow.document);
    const currentLimit = document.limits.find((limit) => limit.id === pending.limitId);

    // Decimal-value comparison, not string equality: `"500"` and `"500.00"` are the same
    // value and must not void a legitimate pending increase just because the stored digit
    // string's formatting differs (`compareUsd` is the same exact-decimal helper
    // `requestLimitChange` uses to decide direction in the first place).
    if (!currentLimit || compareUsd(currentLimit.maxUsd, pending.oldValue) !== 0) {
      const voidedRows = await tx
        .update(constitutionPendingChanges)
        .set({ voidedAt: sql`now()` })
        .where(eq(constitutionPendingChanges.id, pending.id))
        .returning();

      const voidedAt = voidedRows[0]?.voidedAt ?? new Date();

      await recordEvent(
        {
          eventType: 'constitution.limit_increase_voided',
          occurredAt: voidedAt,
          correlationId,
          userId: constitutionRow.userId,
          payload: {
            constitutionId: constitutionRow.id,
            limitId: pending.limitId,
            field: pending.field,
            expectedOldValue: pending.oldValue,
            observedCurrentValue: currentLimit?.maxUsd ?? null,
            newValue: pending.newValue,
            pendingChangeId: pending.id,
          },
        },
        tx,
      );

      return 'voided';
    }

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

    return 'applied';
  });
}

export interface ApplyDuePendingChangesResult {
  appliedCount: number;
  voidedCount: number;
}

/** `effective_at <= now()` and not yet resolved — the due-rows scan's own predicate, shared with the stranded-row count query below so the two can never drift apart. */
function dueCondition(): SQL | undefined {
  return stillPending(lte(constitutionPendingChanges.effectiveAt, sql`now()`));
}

/** How many rows are currently due — used only on the kill-switch-off path, to make a silent skip visible. */
async function countDueRows(): Promise<number> {
  const rows = await getDb().select({ total: count() }).from(constitutionPendingChanges).where(dueCondition());

  return rows[0]?.total ?? 0;
}

/**
 * Resolves up to `PENDING_CHANGE_APPLY_BATCH_LIMIT` pending changes whose 48h has elapsed,
 * across every user's constitution, oldest-due first. Piggybacks on the existing app-open
 * trigger — the dashboard load and the `/constitution/edit` load, and `POST
 * /api/wallet/reconcile` — rather than a scheduler; this is Phase 0's only "lazy cron"
 * pattern (`.ai/decisions/hosting-and-growth-path.md`), already used the same way for chain
 * reconciliation itself.
 *
 * Deliberately not scoped to the caller's own session: whoever happens to open the app first
 * after a change's `effective_at` passes is what resolves it, for every user with a due row —
 * not only their own — so a change that becomes due while its owner is away still resolves
 * "even if the user reloads, closes the tab, or the change is checked well past its due time"
 * (this phase's success criteria), the moment *anyone's* app-open trigger runs. The batch cap
 * bounds one call's work; a backlog beyond it is picked up by the next trigger, not held open
 * in one unbounded scan — ordered oldest-`effective_at`-first so a backlog drains in the order
 * it became due, rather than in whatever order Postgres happens to return rows.
 *
 * Both a kill-switch skip and a batch-cap backlog are logged (CLAUDE.md → *No silent
 * failures*: a stranded pending row must be visible in telemetry, not just quietly waiting for
 * the next pass) — the first only when there is actually something stranded to report, the
 * second only when the cap was actually hit.
 */
export async function applyDuePendingChanges(correlationId: string): Promise<ApplyDuePendingChangesResult> {
  if (!(await isFeatureEnabled(CONSTITUTION_PENDING_CHANGE_APPLY_FLAG))) {
    const strandedCount = await countDueRows();

    if (strandedCount > 0) {
      logger.warn('constitution pending-change apply skipped: kill switch is off', {
        correlationId,
        strandedCount,
      });
    }

    return { appliedCount: 0, voidedCount: 0 };
  }

  // Fetched one over the cap so a full page (`length > PENDING_CHANGE_APPLY_BATCH_LIMIT`)
  // proves there is a backlog beyond this batch, without a second round trip to count it.
  const dueRows = await getDb()
    .select({ id: constitutionPendingChanges.id })
    .from(constitutionPendingChanges)
    .where(dueCondition())
    .orderBy(asc(constitutionPendingChanges.effectiveAt))
    .limit(PENDING_CHANGE_APPLY_BATCH_LIMIT + 1);

  const batchCapHit = dueRows.length > PENDING_CHANGE_APPLY_BATCH_LIMIT;
  const rowsToProcess = batchCapHit ? dueRows.slice(0, PENDING_CHANGE_APPLY_BATCH_LIMIT) : dueRows;

  if (batchCapHit) {
    logger.warn('constitution pending-change apply batch cap hit; rows remain due', {
      correlationId,
      batchLimit: PENDING_CHANGE_APPLY_BATCH_LIMIT,
      strandedAtLeast: dueRows.length - PENDING_CHANGE_APPLY_BATCH_LIMIT,
    });
  }

  let appliedCount = 0;
  let voidedCount = 0;

  for (const dueRow of rowsToProcess) {
    try {
      const outcome = await applyOneDuePendingChange(dueRow.id, correlationId);

      if (outcome === 'applied') {
        appliedCount += 1;
      } else if (outcome === 'voided') {
        voidedCount += 1;
      }
    } catch (error) {
      captureError(error, { correlationId, operation: 'applyDuePendingChanges', pendingChangeId: dueRow.id });
    }
  }

  return { appliedCount, voidedCount };
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
