import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FEEDBACK_CONTEXT_MAX_LENGTH,
  FEEDBACK_TEXT_MAX_LENGTH,
  FeedbackRejected,
  recordFeedback,
  recordFeedbackPrompt,
} from './feedback';
import { ConstitutionActionRateLimited } from '../constitution/rate-limit';

/**
 * Covers the security-review fixes: `context` is capped and charset-validated (previously
 * unbounded), and both writes are throttled per user via the existing constitution
 * rate-limit helper (previously unthrottled, letting one wallet flood `feedback.submitted`
 * and evict genuine quotes from `listRecentFeedback`'s 50-row window).
 */

const { recordEventMock, resolveSessionMock, assertWithinConstitutionActionRateLimitMock } = vi.hoisted(() => ({
  recordEventMock: vi.fn(),
  resolveSessionMock: vi.fn(),
  assertWithinConstitutionActionRateLimitMock: vi.fn(),
}));

vi.mock('../../observability/events', () => ({ recordEvent: recordEventMock }));
vi.mock('../auth/session', () => ({ resolveSession: resolveSessionMock }));
// Same mocking shape as `pending-changes.test.ts`: only the assertion function is mocked,
// `ConstitutionActionRateLimited` stays the real class so `instanceof` checks agree.
vi.mock('../constitution/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../constitution/rate-limit')>();

  return { ...actual, assertWithinConstitutionActionRateLimit: assertWithinConstitutionActionRateLimitMock };
});

const SESSION_USER_ID = 'user-1';

function sessionIdentity() {
  return {
    walletAddress: 'So11111111111111111111111111111111111111112',
    walletId: 'wallet-1',
    userId: SESSION_USER_ID,
    expiresAt: new Date(Date.now() + 60_000),
    idHash: 'session-hash',
  };
}

beforeEach(() => {
  recordEventMock.mockReset();
  resolveSessionMock.mockReset();
  assertWithinConstitutionActionRateLimitMock.mockReset();
  resolveSessionMock.mockResolvedValue(sessionIdentity());
  assertWithinConstitutionActionRateLimitMock.mockResolvedValue(undefined);
});

describe('recordFeedback: context validation', () => {
  it('accepts a well-formed context and records it', async () => {
    await recordFeedback({ text: 'great product', correlationId: 'c1', context: 'post_activation' });

    expect(recordEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { text: 'great product', context: 'post_activation' } }),
    );
  });

  it('rejects a context over the max length', async () => {
    const tooLong = 'a'.repeat(FEEDBACK_CONTEXT_MAX_LENGTH + 1);

    await expect(recordFeedback({ text: 'hi', correlationId: 'c1', context: tooLong })).rejects.toMatchObject({
      reason: 'invalid_context',
    });
    expect(recordEventMock).not.toHaveBeenCalled();
  });

  it('rejects a context with characters outside the closed charset', async () => {
    await expect(recordFeedback({ text: 'hi', correlationId: 'c1', context: 'has spaces!' })).rejects.toBeInstanceOf(FeedbackRejected);
    expect(recordEventMock).not.toHaveBeenCalled();
  });

  it('rejects an empty (whitespace-only) context rather than silently dropping it', async () => {
    await expect(recordFeedback({ text: 'hi', correlationId: 'c1', context: '   ' })).rejects.toMatchObject({ reason: 'invalid_context' });
  });
});

describe('recordFeedback: text length', () => {
  it('rejects text over the max length', async () => {
    const tooLong = 'a'.repeat(FEEDBACK_TEXT_MAX_LENGTH + 1);

    await expect(recordFeedback({ text: tooLong, correlationId: 'c1' })).rejects.toMatchObject({ reason: 'text_too_long' });
  });
});

describe('recordFeedback: rate limiting', () => {
  it('rejects with rate_limited once the throttle fires, and never records the event', async () => {
    assertWithinConstitutionActionRateLimitMock.mockRejectedValueOnce(new ConstitutionActionRateLimited());

    await expect(recordFeedback({ text: 'spammy', correlationId: 'c1' })).rejects.toMatchObject({ reason: 'rate_limited' });
    expect(recordEventMock).not.toHaveBeenCalled();
  });

  it('checks the throttle keyed on feedback.submitted', async () => {
    await recordFeedback({ text: 'hi', correlationId: 'c1' });

    expect(assertWithinConstitutionActionRateLimitMock).toHaveBeenCalledWith(SESSION_USER_ID, 'feedback.submitted', 'c1', expect.any(Date));
  });

  it('re-throws a non-throttle error from the limiter (fail closed, not a silent skip)', async () => {
    const dbError = new Error('database unreachable');
    assertWithinConstitutionActionRateLimitMock.mockRejectedValueOnce(dbError);

    await expect(recordFeedback({ text: 'hi', correlationId: 'c1' })).rejects.toBe(dbError);
    expect(recordEventMock).not.toHaveBeenCalled();
  });
});

describe('recordFeedbackPrompt', () => {
  /**
   * `prompt_shown` was throttled under the same limit as `submitted` in an earlier version,
   * which made an impression under-report relative to a submission on any session that also
   * triggered other throttled writes — inflating the apparent "shown -> submitted" conversion
   * rate. It is now deliberately exempt (see `feedback.ts`'s module doc comment): recording an
   * impression never calls the limiter at all.
   */
  it('is never throttled — recording an impression never calls the limiter', async () => {
    await recordFeedbackPrompt({ correlationId: 'c1' });

    expect(assertWithinConstitutionActionRateLimitMock).not.toHaveBeenCalled();
    expect(recordEventMock).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'feedback.prompt_shown' }));
  });

  it('still records the impression even when the submission limiter is (independently) exhausted', async () => {
    assertWithinConstitutionActionRateLimitMock.mockRejectedValue(new ConstitutionActionRateLimited());

    await recordFeedbackPrompt({ correlationId: 'c1' });

    expect(recordEventMock).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'feedback.prompt_shown' }));
  });
});
