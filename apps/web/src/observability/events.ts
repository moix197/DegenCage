import { getDb, type Database } from '../server/db/client';
import { events } from '../server/db/schema';
import { logger } from './logger';

/**
 * The one write path into `events`. Nothing else inserts into that table.
 *
 * This is the third observability stream, distinct from pino (operational logs) and
 * Sentry (errors): behavioral events are *product data* — Phase 5's dashboard and every
 * discipline metric are computed from them, so they live in Postgres under the same
 * durability rules as the rest of the source of truth
 * (`.ai/decisions/observability-stack.md`).
 */

/**
 * Anything that can run a write: the pooled client, or an open transaction.
 *
 * It lives here because `recordEvent` is the first thing that needs it, and every other
 * consumer (`server/auth/*`) already depends on this module — so the type flows one way
 * and no cycle appears.
 */
export type DatabaseExecutor = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

export interface RecordEventInput {
  eventType: string;
  /**
   * When the thing happened. Must trace back to a chain timestamp or a server clock —
   * never a raw client value, which a caller could backdate to rewrite a streak
   * (`.ai/decisions/event-time-vs-observation-time.md`).
   */
  occurredAt: Date;
  /** Ties every log line, span and event of one user action together. */
  correlationId: string;
  userId?: string | null;
  payload?: Record<string, unknown>;
}

/**
 * `observed_at` is ours alone. A caller that supplies one is either confused or hostile;
 * either way the value is dropped rather than stored, and the attempt is logged so it is
 * visible instead of silent.
 */
function warnOnCallerSuppliedObservedAt(input: RecordEventInput): void {
  if ('observedAt' in input || 'observed_at' in input) {
    logger.warn('ignored caller-supplied observed_at on event', {
      eventType: input.eventType,
      correlationId: input.correlationId,
    });
  }
}

/**
 * @param executor - Pass an open transaction to make the event atomic with the state
 *   change it describes; defaults to the pooled client for standalone events.
 */
export async function recordEvent(
  input: RecordEventInput,
  executor: DatabaseExecutor = getDb(),
): Promise<void> {
  warnOnCallerSuppliedObservedAt(input);

  await executor.insert(events).values({
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    // Stamped here, always. Never read from `input`.
    observedAt: new Date(),
    correlationId: input.correlationId,
    userId: input.userId ?? null,
    payload: input.payload ?? {},
  });

  logger.info('event recorded', {
    eventType: input.eventType,
    correlationId: input.correlationId,
  });
}
