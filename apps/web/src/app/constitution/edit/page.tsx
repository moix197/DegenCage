import { randomUUID } from 'node:crypto';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { captureError } from '@/observability/error-tracking';
import { resolveSession } from '@/server/auth/session';
import { CONSTITUTION_AUTHOR_FLAG, loadCurrentConstitution } from '@/server/constitution/commitment';
import {
  PendingChangeRejected,
  applyDuePendingChanges,
  cancelPendingChange,
  loadPendingChangesForCurrentUser,
  requestLimitChange,
  serializePendingChange,
  type PendingChangeRejectionReason,
  type SerializedPendingChange,
} from '@/server/constitution/pending-changes';
import { isFeatureEnabled } from '@/server/flags/feature-flags';

// The session, the constitution and its pending changes are all read per request.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Edits an already-*active* constitution — decrease-is-immediate, increase-is-delayed
 * (`server/constitution/pending-changes.ts`). Deliberately a single Server Component file
 * with inline Server Actions (`'use server'` functions below) rather than a client panel
 * calling a new API route: no route file is added by this phase, and the whole surface is
 * two plain `<form>` submits, so there is nothing here that needs client-side state.
 *
 * `requestLimitChange`/`cancelPendingChange` are the only gate — this page never guesses
 * decrease-vs-increase itself, and never decides ownership itself either; both come from
 * `resolveSession()` inside those functions, exactly like `/constitution` (`../page.tsx`).
 *
 * A rejection is surfaced by redirecting back to this same page with `?error=<reason>`
 * (`describeRejection` below renders it) rather than swallowed — the only way a Server
 * Action without client-side state can hand a message back to the next render.
 */

/**
 * `PendingChangeRejectionReason` plus two reasons synthesized only here (the flag being off,
 * and an unexpected error) — this page's own rejection vocabulary is a superset of the
 * module's, so it stays a plain string-keyed map rather than `Record<PendingChangeRejectionReason, …>`.
 *
 * `rate_limited`'s wording is deliberately non-punitive ("friction, not punishment" —
 * CLAUDE.md → *What we're building*): it reads as pacing, not as a penalty for wanting to
 * loosen a limit, and it never appears at all on the decrease path, which is never throttled.
 */
const REJECTION_MESSAGES: Partial<Record<string, string>> = {
  unauthenticated: 'Your session expired — reconnect your wallet and try again.',
  no_active_constitution: 'There is no active constitution to edit.',
  limit_not_found: 'That limit no longer exists on your constitution.',
  invalid_value: 'That is not a valid limit amount.',
  no_change: 'That is already the current limit — nothing to change.',
  pending_change_exists: 'There is already a pending increase for this limit. Cancel it before requesting another.',
  pending_change_not_found: 'That pending change is already gone — it may have applied, been voided, or been cancelled already.',
  rate_limited: "You've requested a few loosening changes in a row — take a short pause before the next one. Tightening a limit is never affected by this.",
  authoring_disabled: 'Constitution editing is switched off right now. Nothing is wrong with your wallet.',
  unavailable: 'Something went wrong on our end — please try again.',
} satisfies Partial<Record<PendingChangeRejectionReason | 'authoring_disabled' | 'unavailable', string>>;

function describeRejection(reason: string): string {
  return REJECTION_MESSAGES[reason] ?? 'That request could not be completed.';
}

/**
 * Every redirect on the error path carries `correlationId` alongside `error` — CLAUDE.md
 * requires correlation end-to-end, and this is the one seam where a rejection leaves the
 * function that recorded it (in a log line, in an event payload) via a URL instead of a JSON
 * response. Without it here, a user-reported failure on this page would be untraceable back
 * to the server-side log/event that explains it, unlike every API route's `{error,
 * correlationId}` body.
 */
function errorRedirectUrl(reason: string, correlationId: string): string {
  return `/constitution/edit?error=${encodeURIComponent(reason)}&correlationId=${encodeURIComponent(correlationId)}`;
}

async function requestLimitChangeAction(formData: FormData): Promise<void> {
  'use server';

  const correlationId = randomUUID();
  const limitId = formData.get('limitId');
  const newMaxUsd = formData.get('newMaxUsd');

  if (typeof limitId !== 'string' || typeof newMaxUsd !== 'string' || newMaxUsd.trim() === '') {
    redirect(errorRedirectUrl('invalid_value', correlationId));
  }

  if (!(await isFeatureEnabled(CONSTITUTION_AUTHOR_FLAG))) {
    redirect(errorRedirectUrl('authoring_disabled', correlationId));
  }

  try {
    await requestLimitChange(limitId, newMaxUsd.trim(), correlationId);
  } catch (error) {
    if (error instanceof PendingChangeRejected) {
      redirect(errorRedirectUrl(error.reason, correlationId));
    }

    captureError(error, { correlationId, route: 'constitution.edit.requestLimitChange' });
    redirect(errorRedirectUrl('unavailable', correlationId));
  }

  revalidatePath('/constitution/edit');
}

async function cancelPendingChangeAction(formData: FormData): Promise<void> {
  'use server';

  const correlationId = randomUUID();
  const pendingChangeId = formData.get('pendingChangeId');

  if (typeof pendingChangeId !== 'string') {
    redirect(errorRedirectUrl('pending_change_not_found', correlationId));
  }

  if (!(await isFeatureEnabled(CONSTITUTION_AUTHOR_FLAG))) {
    redirect(errorRedirectUrl('authoring_disabled', correlationId));
  }

  try {
    await cancelPendingChange(pendingChangeId, correlationId);
  } catch (error) {
    if (error instanceof PendingChangeRejected) {
      redirect(errorRedirectUrl(error.reason, correlationId));
    }

    captureError(error, { correlationId, route: 'constitution.edit.cancelPendingChange' });
    redirect(errorRedirectUrl('unavailable', correlationId));
  }

  revalidatePath('/constitution/edit');
}

function formatRemaining(remainingMs: number): string {
  const totalHours = remainingMs / 3_600_000;

  if (totalHours >= 1) {
    return `${Math.ceil(totalHours)}h remaining`;
  }

  return `${Math.max(1, Math.ceil(remainingMs / 60_000))}m remaining`;
}

/**
 * An explicit UTC timestamp, not `toLocaleString()` — this renders in a Server Component, so
 * `toLocaleString()` would format in the *server's* timezone, not the viewer's, and the exact
 * effective time is this phase's success criterion. `YYYY-MM-DD HH:mm UTC` is unambiguous
 * regardless of where the server or the viewer sits.
 */
function formatEffectiveAtUtc(effectiveAtIso: string): string {
  return `${effectiveAtIso.slice(0, 16).replace('T', ' ')} UTC`;
}

function PendingIncrease({ pending }: { pending: SerializedPendingChange }) {
  return (
    <div>
      <p>
        Increase to ${pending.newValue} requested — effective at {formatEffectiveAtUtc(pending.effectiveAt)} (
        {formatRemaining(pending.remainingMs)})
      </p>
      <form action={cancelPendingChangeAction}>
        <input type="hidden" name="pendingChangeId" value={pending.id} />
        <button type="submit">Cancel pending increase</button>
      </form>
    </div>
  );
}

export default async function ConstitutionEditPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const [session, authorEnabled, resolvedSearchParams] = await Promise.all([
    resolveSession(),
    isFeatureEnabled(CONSTITUTION_AUTHOR_FLAG),
    searchParams,
  ]);
  const rawErrorReason = resolvedSearchParams.error;
  const errorReason = Array.isArray(rawErrorReason) ? rawErrorReason[0] : rawErrorReason;
  const rawErrorCorrelationId = resolvedSearchParams.correlationId;
  const errorCorrelationId = Array.isArray(rawErrorCorrelationId) ? rawErrorCorrelationId[0] : rawErrorCorrelationId;

  if (!authorEnabled) {
    return (
      <main>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Edit constitution</h1>
        <p>Constitution authoring is switched off right now. Nothing is wrong with your wallet.</p>
      </main>
    );
  }

  if (!session) {
    return (
      <main>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Edit constitution</h1>
        <p>
          Connect your wallet on <a href="/connect">/connect</a> first.
        </p>
      </main>
    );
  }

  // The real app-open trigger for due changes: `POST /api/wallet/reconcile` has no caller of
  // its own, so opening this page (and the dashboard's) is what actually resolves one.
  // Best-effort — a failure here must never block viewing or editing the constitution.
  try {
    await applyDuePendingChanges(randomUUID());
  } catch (error) {
    captureError(error, { page: 'constitution.edit', operation: 'applyDuePendingChanges' });
  }

  const record = await loadCurrentConstitution();

  if (!record || record.status !== 'active') {
    return (
      <main>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Edit constitution</h1>
        <p>
          There is no active constitution to edit yet. Author and activate one on{' '}
          <a href="/constitution">/constitution</a> first.
        </p>
      </main>
    );
  }

  const now = new Date();
  const pendingRows = await loadPendingChangesForCurrentUser();
  const pendingByLimitId = new Map(pendingRows.map((row) => [row.limitId, serializePendingChange(row, now)]));

  return (
    <main>
      <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Edit constitution</h1>
      <p>Decreasing a limit applies immediately. Increasing a limit takes effect 48 hours after you request it.</p>
      {errorReason ? (
        <p role="alert">
          {describeRejection(errorReason)}
          {errorCorrelationId ? ` (ref: ${errorCorrelationId})` : ''}
        </p>
      ) : null}
      <ul>
        {record.document.limits.map((limit) => {
          const pending = pendingByLimitId.get(limit.id);

          return (
            <li key={limit.id}>
              <p>
                {limit.type}
                {'tier' in limit ? ` (${limit.tier})` : ''}: ${limit.maxUsd}/{limit.windowHours}h
              </p>
              {pending ? (
                <PendingIncrease pending={pending} />
              ) : (
                <form action={requestLimitChangeAction}>
                  <input type="hidden" name="limitId" value={limit.id} />
                  <label>
                    New max USD
                    <input type="text" inputMode="decimal" name="newMaxUsd" placeholder={limit.maxUsd} />
                  </label>
                  <button type="submit">Update limit</button>
                </form>
              )}
            </li>
          );
        })}
      </ul>
    </main>
  );
}
