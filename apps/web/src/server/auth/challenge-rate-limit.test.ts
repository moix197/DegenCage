import { and, eq, gt } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { siwsChallenges } from '../db/schema';
import {
  assertWithinChallengeRateLimit,
  ChallengeRateLimited,
  CHALLENGE_RATE_LIMIT_MAX,
  CHALLENGE_RATE_LIMIT_WINDOW_MS,
  clientKeyForRequest,
} from './challenge-rate-limit';

const NOW = new Date('2026-08-26T12:00:00Z');
const CLIENT_KEY = 'client-key-hash';

const selectMock = vi.fn();
const whereSpy = vi.fn();

/** Mimics drizzle's `select().from().where()` chain, which resolves without a `.limit()`. */
function countReturning(result: number | Error) {
  selectMock.mockReturnValue({
    from: () => ({
      where: (predicate: unknown) => {
        whereSpy(predicate);

        return result instanceof Error
          ? Promise.reject(result)
          : Promise.resolve([{ issued: result }]);
      },
    }),
  });
}

function executor() {
  return { select: selectMock } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('clientKeyForRequest', () => {
  function requestWith(headers: Record<string, string>): Request {
    return new Request('https://degencage.test/api/auth/nonce', { method: 'POST', headers });
  }

  it('never uses the address itself as the key', () => {
    const key = clientKeyForRequest(requestWith({ 'x-forwarded-for': '203.0.113.7' }));

    expect(key).not.toContain('203.0.113.7');
    expect(key).toMatch(/^[0-9a-f]{32}$/);
  });

  it('gives the same caller the same bucket and a different caller a different one', () => {
    const one = clientKeyForRequest(requestWith({ 'x-forwarded-for': '203.0.113.7' }));
    const same = clientKeyForRequest(requestWith({ 'x-forwarded-for': '203.0.113.7' }));
    const other = clientKeyForRequest(requestWith({ 'x-forwarded-for': '198.51.100.4' }));

    expect(same).toBe(one);
    expect(other).not.toBe(one);
  });

  /**
   * The rest of `X-Forwarded-For` is our own proxy chain, which every caller shares — key
   * on that and the whole internet lands in one bucket.
   */
  it('keys on the first hop, not on our proxy chain', () => {
    const direct = clientKeyForRequest(requestWith({ 'x-forwarded-for': '203.0.113.7' }));
    const proxied = clientKeyForRequest(
      requestWith({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1, 10.0.0.2' }),
    );

    expect(proxied).toBe(direct);
  });

  /**
   * Vercel overwrites plain `x-forwarded-for`, but documents that a proxy layered in front
   * of it may rewrite that header again. `x-vercel-forwarded-for` is the one Vercel sets
   * for itself, so it wins wherever both are present.
   */
  it('prefers the vercel-specific forwarded header over x-forwarded-for', () => {
    const key = clientKeyForRequest(
      requestWith({
        'x-vercel-forwarded-for': '203.0.113.7',
        'x-forwarded-for': '198.51.100.4',
        'x-real-ip': '198.51.100.9',
      }),
    );

    expect(key).toBe(clientKeyForRequest(requestWith({ 'x-forwarded-for': '203.0.113.7' })));
  });

  it('keys on the first hop of the vercel header too', () => {
    const proxied = clientKeyForRequest(
      requestWith({ 'x-vercel-forwarded-for': '203.0.113.7, 10.0.0.1' }),
    );

    expect(proxied).toBe(clientKeyForRequest(requestWith({ 'x-vercel-forwarded-for': '203.0.113.7' })));
  });

  it('falls back to x-forwarded-for where the vercel header is absent or empty', () => {
    const expected = clientKeyForRequest(requestWith({ 'x-forwarded-for': '203.0.113.7' }));

    expect(
      clientKeyForRequest(
        requestWith({ 'x-vercel-forwarded-for': '  ', 'x-forwarded-for': '203.0.113.7' }),
      ),
    ).toBe(expected);
  });

  it('falls back to x-real-ip', () => {
    const key = clientKeyForRequest(requestWith({ 'x-real-ip': '203.0.113.7' }));

    expect(key).toBe(clientKeyForRequest(requestWith({ 'x-forwarded-for': '203.0.113.7' })));
  });

  /**
   * Fail closed: a caller we cannot tell apart does not get an allowance of its own, which
   * would be no limit at all. Everyone unidentifiable shares one.
   */
  it('puts every caller it cannot identify in one shared bucket', () => {
    const first = clientKeyForRequest(requestWith({}));
    const second = clientKeyForRequest(requestWith({ 'x-forwarded-for': '   ' }));

    expect(second).toBe(first);
  });
});

describe('assertWithinChallengeRateLimit', () => {
  it('lets a caller through while it still has allowance left', async () => {
    countReturning(CHALLENGE_RATE_LIMIT_MAX - 1);

    await expect(
      assertWithinChallengeRateLimit(executor(), CLIENT_KEY, 'trade-intent-1', NOW),
    ).resolves.toBeUndefined();
  });

  it('trips on the call that would exceed the window', async () => {
    countReturning(CHALLENGE_RATE_LIMIT_MAX);

    await expect(
      assertWithinChallengeRateLimit(executor(), CLIENT_KEY, 'trade-intent-2', NOW),
    ).rejects.toThrow(ChallengeRateLimited);
  });

  it('counts only this client, inside the current window', async () => {
    countReturning(0);

    await assertWithinChallengeRateLimit(executor(), CLIENT_KEY, 'trade-intent-3', NOW);

    expect(whereSpy).toHaveBeenCalledWith(
      and(
        eq(siwsChallenges.clientKey, CLIENT_KEY),
        gt(siwsChallenges.issuedAt, new Date(NOW.getTime() - CHALLENGE_RATE_LIMIT_WINDOW_MS)),
      ),
    );
  });

  /**
   * The limit must not evaporate at the moment the database is already struggling — that is
   * when a flood is cheapest. An unanswerable count is a refusal, not a free pass.
   */
  it('fails closed when the count cannot be read', async () => {
    countReturning(new Error('connection terminated'));

    await expect(
      assertWithinChallengeRateLimit(executor(), CLIENT_KEY, 'trade-intent-4', NOW),
    ).rejects.toThrow('connection terminated');
  });
});
