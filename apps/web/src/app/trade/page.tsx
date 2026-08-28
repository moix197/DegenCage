import { resolveSession } from '@/server/auth/session';
import { isFeatureEnabled, TRADE_TERMINAL_FLAG } from '@/server/flags/feature-flags';
import { TradePanel } from './trade-panel';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The trading terminal's shell: flag gate, session gate, and nothing else. Every quote and
 * every verdict comes from `POST /api/swap/quote` (`server/swap/quote-service.ts`), so this
 * page never evaluates anything itself and there is no second copy of the decision to drift.
 *
 * Nothing on this page can sign or broadcast — Phase 2 stops at showing the user the verdict.
 */
export default async function TradePage() {
  const [session, terminalEnabled] = await Promise.all([resolveSession(), isFeatureEnabled(TRADE_TERMINAL_FLAG)]);

  if (!terminalEnabled) {
    return (
      <main className="mx-auto flex max-w-3xl flex-col gap-4">
        <h1 className="text-xl font-semibold">Trade</h1>
        <p className="text-sm text-muted-foreground">The trading terminal is switched off right now. Nothing is wrong with your wallet.</p>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="mx-auto flex max-w-3xl flex-col gap-4">
        <h1 className="text-xl font-semibold">Trade</h1>
        <p className="text-sm text-muted-foreground">
          Connect your wallet on <a href="/connect">/connect</a> first.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6">
      <h1 className="text-xl font-semibold">Trade</h1>
      <p className="text-sm text-muted-foreground">
        Every quote is checked against your constitution before your wallet is ever asked to sign.
      </p>
      <TradePanel />
    </main>
  );
}
