import { resolveSession } from '@/server/auth/session';
import {
  CONSTITUTION_AUTHOR_FLAG,
  loadCurrentConstitution,
  serializeConstitutionRecord,
} from '@/server/constitution/commitment';
import { isFeatureEnabled } from '@/server/flags/feature-flags';

import { ConstitutionPanel } from './constitution-panel';

// The session and the constitution are read per request, so this page can never be cached.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Authors, commits and activates a trading constitution.
 *
 * The identity comes from `resolveSession()`, never from anything the client claims — same
 * invariant as `/connect` (`src/app/connect/page.tsx`). With the kill switch off there is no
 * panel and no way to author or activate anything at all.
 */
export default async function ConstitutionPage() {
  const [session, authorEnabled] = await Promise.all([
    resolveSession(),
    isFeatureEnabled(CONSTITUTION_AUTHOR_FLAG),
  ]);

  if (!authorEnabled) {
    return (
      <main>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Trading constitution</h1>
        <p>Constitution authoring is switched off right now. Nothing is wrong with your wallet.</p>
      </main>
    );
  }

  if (!session) {
    return (
      <main>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Trading constitution</h1>
        <p>
          Connect your wallet on <a href="/connect">/connect</a> first.
        </p>
      </main>
    );
  }

  const record = await loadCurrentConstitution();
  const initial = record ? serializeConstitutionRecord(record, new Date()) : null;

  return (
    <main>
      <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Trading constitution</h1>
      <ConstitutionPanel initial={initial} />
    </main>
  );
}
