import { randomUUID } from 'node:crypto';

import { captureError } from '@/observability/error-tracking';
import {
  CONSTITUTION_AUTHOR_FLAG,
  ConstitutionActionRejected,
  httpStatusForRejection,
  serializeConstitutionRecord,
  startCommitment,
} from '@/server/constitution/commitment';
import { isFeatureEnabled } from '@/server/flags/feature-flags';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Starts the 20-minute commitment period on the caller's draft. `startCommitment` is
 * idempotent — a double-click re-checks the existing `committing`/`active` row rather than
 * erroring or restarting the clock, so this route never needs to distinguish "already
 * committing" as a failure.
 */
export async function POST(): Promise<Response> {
  const correlationId = randomUUID();

  if (!(await isFeatureEnabled(CONSTITUTION_AUTHOR_FLAG))) {
    return Response.json({ error: 'constitution_author_disabled', correlationId }, { status: 503 });
  }

  try {
    const record = await startCommitment(correlationId);
    const now = new Date();

    return Response.json({ constitution: serializeConstitutionRecord(record, now), correlationId });
  } catch (error) {
    if (error instanceof ConstitutionActionRejected) {
      return Response.json(
        { error: error.reason, correlationId },
        { status: httpStatusForRejection(error.reason) },
      );
    }

    captureError(error, { correlationId, route: 'constitution.commit' });

    return Response.json({ error: 'constitution_unavailable', correlationId }, { status: 503 });
  }
}
