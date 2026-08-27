import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from './route';

/**
 * Establishes the `route.test.ts` pattern for this codebase (none existed before this
 * phase): mock the server module the route imports, not the database — the route itself
 * never touches `getDb()`. The one thing under test here is the shared-secret gate: missing
 * or wrong secret must answer 404 (never 403, which would confirm the route exists to an
 * unauthenticated caller), and the correct secret must reach `buildMetricsSnapshot`.
 */

const { buildMetricsSnapshotMock } = vi.hoisted(() => ({ buildMetricsSnapshotMock: vi.fn() }));

vi.mock('../../../../server/metrics/queries', () => ({ buildMetricsSnapshot: buildMetricsSnapshotMock }));

const ORIGINAL_SECRET = process.env.ADMIN_METRICS_SECRET;
const SECRET_HEADER = 'x-admin-metrics-secret';

function requestWithHeader(headerValue?: string): Request {
  return new Request('http://localhost/api/admin/metrics', {
    headers: headerValue !== undefined ? { [SECRET_HEADER]: headerValue } : {},
  });
}

beforeEach(() => {
  buildMetricsSnapshotMock.mockReset();
  process.env.ADMIN_METRICS_SECRET = 'correct-secret';
});

afterEach(() => {
  process.env.ADMIN_METRICS_SECRET = ORIGINAL_SECRET;
});

describe('GET /api/admin/metrics', () => {
  it('answers 404, not 403, with no secret header at all', async () => {
    const response = await GET(requestWithHeader());

    expect(response.status).toBe(404);
    expect(buildMetricsSnapshotMock).not.toHaveBeenCalled();
  });

  it('answers 404 with a wrong secret', async () => {
    const response = await GET(requestWithHeader('wrong-secret'));

    expect(response.status).toBe(404);
    expect(buildMetricsSnapshotMock).not.toHaveBeenCalled();
  });

  it('answers 404 when ADMIN_METRICS_SECRET itself is unset, even with a header sent', async () => {
    delete process.env.ADMIN_METRICS_SECRET;

    const response = await GET(requestWithHeader('anything'));

    expect(response.status).toBe(404);
    expect(buildMetricsSnapshotMock).not.toHaveBeenCalled();
  });

  it('answers 200 with the computed snapshot when the secret matches', async () => {
    const snapshot = {
      generatedAt: new Date().toISOString(),
      onboarding: { sessionUserCount: 1, activatedUserCount: 1, rate: 1 },
    };
    buildMetricsSnapshotMock.mockResolvedValueOnce(snapshot);

    const response = await GET(requestWithHeader('correct-secret'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject(snapshot);
    expect(typeof body.correlationId).toBe('string');
    expect(buildMetricsSnapshotMock).toHaveBeenCalledTimes(1);
  });
});
