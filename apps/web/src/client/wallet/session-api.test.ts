import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchChallenge, postProof, revokeCurrentSession } from './session-api';

/**
 * What each response *means*, with `fetch` stubbed and nothing else.
 *
 * The case that matters is the sign-out: a DELETE that failed used to be indistinguishable
 * from one that worked, so the watcher refreshed the page and the user read "signing you
 * out" while their session row was still alive and still resolving. Every assertion here
 * is that a non-success is reported as one.
 */

const fetchMock = vi.fn();

function respond(init: { ok: boolean; body?: unknown }) {
  fetchMock.mockResolvedValue({
    ok: init.ok,
    json: async () => init.body ?? {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('revokeCurrentSession', () => {
  it('reports the revocation only when the server confirms it', async () => {
    respond({ ok: true });

    await expect(revokeCurrentSession('account_switch')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/verify?reason=account_switch', {
      method: 'DELETE',
    });
  });

  /** The silent failure itself: 503 from the route, and the caller must not refresh over it. */
  it('reports failure when the server could not revoke', async () => {
    respond({ ok: false, body: { error: 'session_revoke_failed' } });

    await expect(revokeCurrentSession('account_switch')).resolves.toBe(false);
  });

  it('reports failure when the request never arrived', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(revokeCurrentSession('wallet_disconnected')).resolves.toBe(false);
  });
});

describe('postProof', () => {
  const proof = { publicKey: 'cGs=', signedMessage: 'bXNn', signature: 'c2ln' };

  it('returns the address the server bound the session to, not one we chose', async () => {
    respond({ ok: true, body: { address: 'So11111111111111111111111111111111111111112' } });

    await expect(postProof(proof)).resolves.toBe('So11111111111111111111111111111111111111112');
  });

  it('throws on a rejected sign-in instead of returning as if it worked', async () => {
    respond({ ok: false, body: { error: 'sign_in_rejected' } });

    await expect(postProof(proof)).rejects.toThrow(/was not accepted/);
  });
});

describe('fetchChallenge', () => {
  it('throws when no challenge was issued — the kill switch being the usual reason', async () => {
    respond({ ok: false, body: { error: 'wallet_connect_disabled' } });

    await expect(fetchChallenge()).rejects.toThrow(/currently unavailable/);
  });
});
