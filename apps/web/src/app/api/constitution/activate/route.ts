import { randomUUID } from 'node:crypto';

import { captureError } from '@/observability/error-tracking';
import {
  CONSTITUTION_AUTHOR_FLAG,
  ConstitutionActionRejected,
  activateConstitution,
  httpStatusForRejection,
  serializeConstitutionRecord,
} from '@/server/constitution/commitment';
import { isFeatureEnabled } from '@/server/flags/feature-flags';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Activates the caller's constitution. This is the server-side gate a replayed or forged
 * "activate now" request cannot get past: `activateConstitution` re-checks
 * `commitment_started_at` against Postgres' own `now()` and rejects
 * (`commitment_not_elapsed`, 425) regardless of what the client claims. Re-activating an
 * already-active constitution is a no-op, not an error.
 */
export async function POST(): Promise<Response> {
  const correlationId = randomUUID();

  if (!(await isFeatureEnabled(CONSTITUTION_AUTHOR_FLAG))) {
    return Response.json({ error: 'constitution_author_disabled', correlationId }, { status: 503 });
  }

  try {
    const record = await activateConstitution(correlationId);
    const now = new Date();

    return Response.json({ constitution: serializeConstitutionRecord(record, now), correlationId });
  } catch (error) {
    if (error instanceof ConstitutionActionRejected) {
      return Response.json(
        { error: error.reason, correlationId },
        { status: httpStatusForRejection(error.reason) },
      );
    }

    captureError(error, { correlationId, route: 'constitution.activate' });

    return Response.json({ error: 'constitution_unavailable', correlationId }, { status: 503 });
  }
}
