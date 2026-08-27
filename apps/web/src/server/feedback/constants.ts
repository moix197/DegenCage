/**
 * Pure constants only — no `next/headers`, no drizzle, no server-only imports of any kind.
 * `feedback.ts` re-exports these for its own callers; `dashboard/feedback-prompt.tsx` (a
 * `'use client'` component) imports directly from here instead, so the client bundle never
 * pulls in `feedback.ts`'s `resolveSession`/`getDb`/rate-limit chain just to read a length cap.
 */

/** Enough room for the "killer signal" quote this exists to capture, capped against abuse — an explicit bound, not an unbounded text column. */
export const FEEDBACK_TEXT_MAX_LENGTH = 2000;

/** `context` is an internal label (e.g. `post_activation`, `after_violation`), not free text — short and closed-charset on purpose, unlike `text`. */
export const FEEDBACK_CONTEXT_MAX_LENGTH = 64;
