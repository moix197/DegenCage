import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT } from './route';

/**
 * `route.test.ts` pattern for this codebase: mock the server module the route imports, not
 * the database — the route itself never touches `getDb()`. Under test: the shared-secret
 * gate (missing/wrong/unset secret must answer 404, never 403, which would confirm the route
 * exists to an unauthenticated caller) and — the code-review/security-audit fix — that no
 * response is distinguishable from "unregistered route" by content-type, and that every
 * non-GET method 404s instead of letting Next's auto-405/`Allow` header confirm the route
 * exists regardless of auth.
 */

const { buildMetricsSnapshotMock } = vi.hoisted(() => ({ buildMetricsSnapshotMock: vi.fn() }));

vi.mock('@/server/metrics/queries', () => ({ buildMetricsSnapshot: buildMetricsSnapshotMock }));

const ORIGINAL_SECRET = process.env.ADMIN_METRICS_SECRET;
const SECRET_HEADER = 'x-admin-metrics-secret';

function requestWithHeader(method: string, headerValue?: string): Request {
  return new Request('http://localhost/api/admin/metrics', {
    method,
    headers: headerValue !== undefined ? { [SECRET_HEADER]: headerValue } : {},
  });
}

beforeEach(() => {
  buildMetricsSnapshotMock.mockReset();
  process.env.ADMIN_METRICS_SECRET = 'a-very-strong-secret-that-is-32-chars-plus';
});

afterEach(() => {
  process.env.ADMIN_METRICS_SECRET = ORIGINAL_SECRET;
});

describe('GET /api/admin/metrics', () => {
  it('answers 404, not 403, with no secret header at all', async () => {
    const response = await GET(requestWithHeader('GET'));

    expect(response.status).toBe(404);
    expect(buildMetricsSnapshotMock).not.toHaveBeenCalled();
  });

  it('answers 404 with a wrong secret', async () => {
    const response = await GET(requestWithHeader('GET', 'wrong-secret'));

    expect(response.status).toBe(404);
    expect(buildMetricsSnapshotMock).not.toHaveBeenCalled();
  });

  it('answers 404 when ADMIN_METRICS_SECRET itself is unset, even with a header sent', async () => {
    delete process.env.ADMIN_METRICS_SECRET;

    const response = await GET(requestWithHeader('GET', 'anything'));

    expect(response.status).toBe(404);
    expect(buildMetricsSnapshotMock).not.toHaveBeenCalled();
  });

  it('never returns an empty body with no content-type on rejection — that shape alone would be fingerprintable', async () => {
    const response = await GET(requestWithHeader('GET'));

    expect(response.headers.get('content-type')).toBeTruthy();
    const body = await response.text();
    expect(body.length).toBeGreaterThan(0);
  });

  it('answers 200 with the computed snapshot when the secret matches', async () => {
    const snapshot = {
      generatedAt: new Date().toISOString(),
      onboarding: { sessionUserCount: 1, activatedUserCount: 1, rate: 1 },
    };
    buildMetricsSnapshotMock.mockResolvedValueOnce(snapshot);

    const response = await GET(requestWithHeader('GET', 'a-very-strong-secret-that-is-32-chars-plus'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject(snapshot);
    expect(typeof body.correlationId).toBe('string');
    expect(buildMetricsSnapshotMock).toHaveBeenCalledTimes(1);
  });
});

describe('non-GET methods on /api/admin/metrics', () => {
  it.each([
    ['POST', POST],
    ['PUT', PUT],
    ['PATCH', PATCH],
    ['DELETE', DELETE],
    ['HEAD', HEAD],
    ['OPTIONS', OPTIONS],
  ])('%s answers 404, not an auto-405 with an Allow header, even with the correct secret', async (method, handler) => {
    const response = await handler(requestWithHeader(method, 'a-very-strong-secret-that-is-32-chars-plus'));

    expect(response.status).toBe(404);
    expect(response.headers.get('allow')).toBeNull();
    expect(buildMetricsSnapshotMock).not.toHaveBeenCalled();
  });
});
