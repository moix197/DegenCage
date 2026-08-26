import { randomUUID } from 'node:crypto';

import { captureError } from '@/observability/error-tracking';
import {
  CONSTITUTION_AUTHOR_FLAG,
  ConstitutionActionRejected,
  httpStatusForRejection,
  loadCurrentConstitution,
  saveDraftConstitution,
  serializeConstitutionRecord,
} from '@/server/constitution/commitment';
import { isFeatureEnabled } from '@/server/flags/feature-flags';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Reads the caller's current constitution — hydrates the authoring page and the countdown poll. */
export async function GET(): Promise<Response> {
  const correlationId = randomUUID();

  if (!(await isFeatureEnabled(CONSTITUTION_AUTHOR_FLAG))) {
    return Response.json({ error: 'constitution_author_disabled', correlationId }, { status: 503 });
  }

  try {
    const record = await loadCurrentConstitution();
    const now = new Date();

    return Response.json({
      constitution: record ? serializeConstitutionRecord(record, now) : null,
      now: now.toISOString(),
      correlationId,
    });
  } catch (error) {
    captureError(error, { correlationId, route: 'constitution.get' });

    return Response.json({ error: 'constitution_unavailable', correlationId }, { status: 503 });
  }
}

/**
 * Creates or updates the caller's draft constitution. Gated by `constitution.author`, and
 * fails closed with the flag off — no draft can be authored at all.
 */
export async function POST(request: Request): Promise<Response> {
  const correlationId = randomUUID();

  if (!(await isFeatureEnabled(CONSTITUTION_AUTHOR_FLAG))) {
    return Response.json({ error: 'constitution_author_disabled', correlationId }, { status: 503 });
  }

  try {
    const body = await request.json().catch(() => null);
    const record = await saveDraftConstitution(body, correlationId);
    const now = new Date();

    return Response.json({ constitution: serializeConstitutionRecord(record, now), correlationId });
  } catch (error) {
    if (error instanceof ConstitutionActionRejected) {
      return Response.json(
        { error: error.reason, correlationId },
        { status: httpStatusForRejection(error.reason) },
      );
    }

    captureError(error, { correlationId, route: 'constitution.post' });

    return Response.json({ error: 'constitution_unavailable', correlationId }, { status: 503 });
  }
}
