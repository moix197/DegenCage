import {
  HOME_STATUS_PANEL_FLAG,
  isFeatureEnabled,
  loadFeatureFlagStatus,
} from '@/server/flags/feature-flags';

// The page is a live health read of the pooled Postgres connection, so it must
// never be prerendered at build time or cached afterwards.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function HomePage() {
  const [status, statusPanelEnabled] = await Promise.all([
    loadFeatureFlagStatus(),
    isFeatureEnabled(HOME_STATUS_PANEL_FLAG),
  ]);

  return (
    <main>
      <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>DegenCage</h1>
      <p>
        DB: {status.connected ? 'connected' : 'unreachable'}, flags loaded: {status.flagCount}
      </p>
      <p>
        {HOME_STATUS_PANEL_FLAG}: {statusPanelEnabled ? 'enabled' : 'disabled'}
      </p>
    </main>
  );
}
