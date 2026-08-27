import { randomUUID } from 'node:crypto';

import { revalidatePath } from 'next/cache';

import { captureError } from '@/observability/error-tracking';
import { resolveSession } from '@/server/auth/session';
import { CONSTITUTION_AUTHOR_FLAG, loadCurrentConstitution } from '@/server/constitution/commitment';
import {
  PendingChangeRejected,
  cancelPendingChange,
  loadPendingChangesForCurrentUser,
  requestLimitChange,
  serializePendingChange,
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
 */

async function requestLimitChangeAction(formData: FormData): Promise<void> {
  'use server';

  const limitId = formData.get('limitId');
  const newMaxUsd = formData.get('newMaxUsd');

  if (typeof limitId !== 'string' || typeof newMaxUsd !== 'string' || newMaxUsd.trim() === '') {
    return;
  }

  const correlationId = randomUUID();

  if (!(await isFeatureEnabled(CONSTITUTION_AUTHOR_FLAG))) {
    return;
  }

  try {
    await requestLimitChange(limitId, newMaxUsd.trim(), correlationId);
  } catch (error) {
    if (!(error instanceof PendingChangeRejected)) {
      captureError(error, { correlationId, route: 'constitution.edit.requestLimitChange' });
    }
  }

  revalidatePath('/constitution/edit');
}

async function cancelPendingChangeAction(formData: FormData): Promise<void> {
  'use server';

  const pendingChangeId = formData.get('pendingChangeId');

  if (typeof pendingChangeId !== 'string') {
    return;
  }

  const correlationId = randomUUID();

  if (!(await isFeatureEnabled(CONSTITUTION_AUTHOR_FLAG))) {
    return;
  }

  try {
    await cancelPendingChange(pendingChangeId, correlationId);
  } catch (error) {
    if (!(error instanceof PendingChangeRejected)) {
      captureError(error, { correlationId, route: 'constitution.edit.cancelPendingChange' });
    }
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

function PendingIncrease({ pending }: { pending: SerializedPendingChange }) {
  return (
    <div>
      <p>
        Increase to ${pending.newValue} requested — effective at {new Date(pending.effectiveAt).toLocaleString()} (
        {formatRemaining(pending.remainingMs)})
      </p>
      <form action={cancelPendingChangeAction}>
        <input type="hidden" name="pendingChangeId" value={pending.id} />
        <button type="submit">Cancel pending increase</button>
      </form>
    </div>
  );
}

export default async function ConstitutionEditPage() {
  const [session, authorEnabled] = await Promise.all([
    resolveSession(),
    isFeatureEnabled(CONSTITUTION_AUTHOR_FLAG),
  ]);

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
