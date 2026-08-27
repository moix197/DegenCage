import { randomUUID } from 'node:crypto';

import { captureError } from '@/observability/error-tracking';
import { isFeatureEnabled } from '@/server/flags/feature-flags';
import {
  FEEDBACK_CAPTURE_FLAG,
  FeedbackRejected,
  httpStatusForFeedbackRejection,
  recordFeedback,
  recordFeedbackPrompt,
} from '@/server/feedback/feedback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The qualitative Phase 0 signal's capture endpoint. One route, two shapes: `prompt_shown`
 * marks an impression (fire-and-forget, called when the feedback prompt renders); `submitted`
 * is the free-text capture itself. Both require a session — same "identity from
 * `resolveSession()` only" invariant as `server/constitution/*`.
 */

interface FeedbackPromptBody {
  event: 'prompt_shown';
  context?: string;
}

interface FeedbackSubmittedBody {
  event: 'submitted';
  text: string;
  context?: string;
}

type FeedbackRequestBody = FeedbackPromptBody | FeedbackSubmittedBody;

function isFeedbackRequestBody(value: unknown): value is FeedbackRequestBody {
  if (typeof value !== 'object' || value === null || !('event' in value)) {
    return false;
  }

  const body = value as { event: unknown; text?: unknown; context?: unknown };

  if (body.context !== undefined && typeof body.context !== 'string') {
    return false;
  }

  if (body.event === 'prompt_shown') {
    return true;
  }

  return body.event === 'submitted' && typeof body.text === 'string';
}

export async function POST(request: Request): Promise<Response> {
  const correlationId = randomUUID();

  if (!(await isFeatureEnabled(FEEDBACK_CAPTURE_FLAG))) {
    return Response.json({ error: 'feedback_capture_disabled', correlationId }, { status: 503 });
  }

  const body = await request.json().catch(() => null);

  if (!isFeedbackRequestBody(body)) {
    return Response.json({ error: 'invalid_text', correlationId }, { status: 400 });
  }

  try {
    if (body.event === 'prompt_shown') {
      await recordFeedbackPrompt(body.context !== undefined ? { correlationId, context: body.context } : { correlationId });
    } else {
      await recordFeedback(
        body.context !== undefined ? { text: body.text, correlationId, context: body.context } : { text: body.text, correlationId },
      );
    }

    return Response.json({ correlationId });
  } catch (error) {
    if (error instanceof FeedbackRejected) {
      return Response.json({ error: error.reason, correlationId }, { status: httpStatusForFeedbackRejection(error.reason) });
    }

    captureError(error, { correlationId, route: 'feedback.post' });

    return Response.json({ error: 'feedback_unavailable', correlationId }, { status: 503 });
  }
}
