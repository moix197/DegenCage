import { desc, eq } from 'drizzle-orm';

import { recordEvent, type DatabaseExecutor } from '../../observability/events';
import { resolveSession } from '../auth/session';
import { getDb } from '../db/client';
import { events } from '../db/schema';

/**
 * The qualitative Phase 0 signal (plan's Phase 9): "I know I can bypass this, but I don't
 * want to" is not computable from telemetry alone, so it is captured as free text and
 * reviewed manually rather than forced into a fake proxy metric. `recordFeedbackPrompt`/
 * `recordFeedback` write `feedback.prompt_shown`/`feedback.submitted`; `listRecentFeedback`
 * reads the latter back, verbatim, for `/admin/metrics` to render — never interpreted or
 * scored here, only displayed.
 *
 * Session-gated like every other write in this codebase: `resolveSession()` is the only
 * source of caller identity, same invariant `server/constitution/*` and `server/auth/*`
 * hold (no route may take a user id from a request body).
 */

/**
 * Ships dark (CLAUDE.md → *Feature flags for anything user-facing*): deliberately not added
 * to `src/server/db/seed.ts` in this phase, so it defaults to off (unseeded = fail closed,
 * same as every other flag in this codebase) until product decides to roll the prompt out.
 */
export const FEEDBACK_CAPTURE_FLAG = 'feedback.capture';

/** Enough room for the "killer signal" quote this exists to capture, capped against abuse — an explicit bound, not an unbounded text column. */
export const FEEDBACK_TEXT_MAX_LENGTH = 2000;

const FEEDBACK_LIST_LIMIT = 50;

export type FeedbackRejectionReason = 'unauthenticated' | 'invalid_text' | 'text_too_long';

export class FeedbackRejected extends Error {
  constructor(readonly reason: FeedbackRejectionReason) {
    super(`feedback rejected: ${reason}`);
    this.name = 'FeedbackRejected';
  }
}

export function httpStatusForFeedbackRejection(reason: FeedbackRejectionReason): number {
  switch (reason) {
    case 'unauthenticated':
      return 401;
    case 'invalid_text':
    case 'text_too_long':
      return 400;
    default:
      return 400;
  }
}

async function requireSession() {
  const session = await resolveSession();

  if (!session) {
    throw new FeedbackRejected('unauthenticated');
  }

  return session;
}

export interface RecordFeedbackPromptParams {
  correlationId: string;
  /** Where the prompt was shown — e.g. `post_activation`, `after_violation`. Opaque label, not validated against a fixed set. */
  context?: string;
}

export async function recordFeedbackPrompt({ correlationId, context }: RecordFeedbackPromptParams): Promise<void> {
  const session = await requireSession();

  await recordEvent({
    eventType: 'feedback.prompt_shown',
    occurredAt: new Date(),
    correlationId,
    userId: session.userId,
    payload: context ? { context } : {},
  });
}

export interface RecordFeedbackParams {
  text: string;
  correlationId: string;
  context?: string;
}

/**
 * Stores `text` as-is, opaque — never parsed, scored, or trusted as anything but "text a user
 * wrote". Length-capped; empty/whitespace-only text is rejected rather than recorded as a
 * meaningless row.
 */
export async function recordFeedback({ text, correlationId, context }: RecordFeedbackParams): Promise<void> {
  const session = await requireSession();
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    throw new FeedbackRejected('invalid_text');
  }

  if (trimmed.length > FEEDBACK_TEXT_MAX_LENGTH) {
    throw new FeedbackRejected('text_too_long');
  }

  await recordEvent({
    eventType: 'feedback.submitted',
    occurredAt: new Date(),
    correlationId,
    userId: session.userId,
    payload: context ? { text: trimmed, context } : { text: trimmed },
  });
}

export interface FeedbackSubmission {
  occurredAt: Date;
  userId: string | null;
  text: string;
  context: string | null;
}

/** Fails closed on a malformed payload — skips the row rather than throwing or guessing, same shape as `dashboard/violations-feed.ts`'s `readDecisionRecordedPayload`. */
function readFeedbackSubmissionPayload(payload: Record<string, unknown>): { text: string; context: string | null } | null {
  if (typeof payload.text !== 'string') {
    return null;
  }

  return { text: payload.text, context: typeof payload.context === 'string' ? payload.context : null };
}

/** The raw, opaque text list `/admin/metrics` renders for manual review — never scored or summarized (the plan's own explicit call-out that this signal isn't computable). */
export async function listRecentFeedback(executor: DatabaseExecutor = getDb()): Promise<FeedbackSubmission[]> {
  const rows = await executor
    .select({ occurredAt: events.occurredAt, userId: events.userId, payload: events.payload })
    .from(events)
    .where(eq(events.eventType, 'feedback.submitted'))
    .orderBy(desc(events.occurredAt))
    .limit(FEEDBACK_LIST_LIMIT);

  return rows.flatMap((row) => {
    const decoded = readFeedbackSubmissionPayload(row.payload);

    return decoded ? [{ occurredAt: row.occurredAt, userId: row.userId, text: decoded.text, context: decoded.context }] : [];
  });
}
