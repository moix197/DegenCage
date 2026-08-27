'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { AssetTier } from '@degencage/rules';
import type { SerializedConstitution } from '@/server/constitution/commitment';

/**
 * The interactive half of `/constitution`: author a daily-notional limit and, since Phase 5,
 * an optional per-asset-tier acquisition limit, commit them, watch a server-driven countdown,
 * then activate.
 *
 * The countdown is cosmetic between polls only — `remainingMs` always comes from the last
 * `GET /api/constitution` response, never from a client-side clock counting down on its
 * own, and the "Activate" button being enabled is never itself the gate: the server
 * re-checks elapsed time from `commitment_started_at` the moment it is clicked.
 */

const POLL_INTERVAL_MS = 5_000;

/**
 * Hardcoded here rather than imported: `packages/rules` keeps `ASSET_TIERS` internal (its
 * public surface is unchanged in shape by Phase 5 — only the `AssetTier` type's members
 * changed), and the daily-notional limit's `type` literal is already hardcoded the same way
 * just below.
 */
const ASSET_TIER_OPTIONS: readonly AssetTier[] = ['STABLE', 'LARGE_CAP', 'MID_CAP', 'SMALL_CAP', 'MICRO_CAP'];

interface ConstitutionResponse {
  constitution: SerializedConstitution | null;
  error?: string;
}

async function readJson(response: Response): Promise<ConstitutionResponse> {
  return (await response.json().catch(() => ({ constitution: null }))) as ConstitutionResponse;
}

function formatRemaining(remainingMs: number): string {
  const totalSeconds = Math.ceil(remainingMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export interface ConstitutionPanelProps {
  initial: SerializedConstitution | null;
}

export function ConstitutionPanel({ initial }: ConstitutionPanelProps) {
  const [constitution, setConstitution] = useState<SerializedConstitution | null>(initial);
  const [maxUsd, setMaxUsd] = useState('');
  const [tierMaxUsd, setTierMaxUsd] = useState('');
  const [tier, setTier] = useState<AssetTier>('MICRO_CAP');
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  // Seeded from the stored limit's id when one already exists — Phase 8's pending-change
  // mechanism keys a loosening/tightening off this id, so minting a fresh one on every
  // mount would silently detach a draft edit from the limit it is meant to describe.
  const limitIdRef = useRef<string>(
    initial?.document.limits.find((limit) => limit.type === 'daily_notional_usd')?.id ?? crypto.randomUUID(),
  );
  const tierLimitIdRef = useRef<string>(
    initial?.document.limits.find((limit) => limit.type === 'asset_tier_acquisition_usd')?.id ?? crypto.randomUUID(),
  );

  const refresh = useCallback(async () => {
    const response = await fetch('/api/constitution', { cache: 'no-store' });
    const body = await readJson(response);

    if (response.ok) {
      setConstitution(body.constitution);
    }
  }, []);

  // Server-driven countdown: re-read the source of truth on an interval rather than
  // trusting a client-side timer to know when 20 minutes have actually passed.
  useEffect(() => {
    if (constitution?.status !== 'committing') {
      return;
    }

    const id = setInterval(refresh, POLL_INTERVAL_MS);

    return () => clearInterval(id);
  }, [constitution?.status, refresh]);

  async function handleCommit() {
    setError(null);
    setIsBusy(true);

    try {
      const limits: unknown[] = [
        {
          id: limitIdRef.current,
          type: 'daily_notional_usd',
          maxUsd,
          windowHours: 24,
        },
      ];

      // The tier limit is optional — an empty field means the user only wants the daily
      // total for now, not a rejected draft.
      if (tierMaxUsd.trim() !== '') {
        limits.push({
          id: tierLimitIdRef.current,
          type: 'asset_tier_acquisition_usd',
          tier,
          maxUsd: tierMaxUsd,
          windowHours: 24,
        });
      }

      const draftResponse = await fetch('/api/constitution', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 1, limits }),
      });
      const draftBody = await readJson(draftResponse);

      if (!draftResponse.ok) {
        setError(draftBody.error ?? 'Could not save the draft.');
        return;
      }

      const commitResponse = await fetch('/api/constitution/commit', { method: 'POST' });
      const commitBody = await readJson(commitResponse);

      if (!commitResponse.ok) {
        setError(commitBody.error ?? 'Could not start the commitment period.');
        return;
      }

      setConstitution(commitBody.constitution);
    } finally {
      setIsBusy(false);
    }
  }

  async function handleActivate() {
    setError(null);
    setIsBusy(true);

    try {
      const response = await fetch('/api/constitution/activate', { method: 'POST' });
      const body = await readJson(response);

      if (!response.ok) {
        setError(
          body.error === 'commitment_not_elapsed'
            ? 'The 20-minute commitment period has not elapsed yet.'
            : (body.error ?? 'Could not activate.'),
        );
        await refresh();

        return;
      }

      setConstitution(body.constitution);
    } finally {
      setIsBusy(false);
    }
  }

  if (constitution?.status === 'active') {
    const limit = constitution.document.limits.find((rule) => rule.type === 'daily_notional_usd');
    const tierLimit = constitution.document.limits.find(
      (rule): rule is Extract<typeof rule, { type: 'asset_tier_acquisition_usd' }> =>
        rule.type === 'asset_tier_acquisition_usd',
    );

    return (
      <section>
        <p>Active. Daily notional limit: ${limit?.maxUsd ?? '—'}/day.</p>
        {tierLimit ? (
          <p>
            {tierLimit.tier} acquisition limit: ${tierLimit.maxUsd}/{tierLimit.windowHours}h.
          </p>
        ) : null}
      </section>
    );
  }

  if (constitution?.status === 'committing') {
    const remainingMs = constitution.remainingMs ?? 0;
    const elapsed = remainingMs <= 0;

    return (
      <section>
        <p>{elapsed ? 'Commitment period complete.' : `Time remaining: ${formatRemaining(remainingMs)}`}</p>
        <button disabled={!elapsed || isBusy} onClick={handleActivate}>
          Activate
        </button>
        {error ? <p role="alert">{error}</p> : null}
      </section>
    );
  }

  return (
    <section>
      <label>
        Daily total-notional limit (USD)
        <input
          type="text"
          inputMode="decimal"
          value={maxUsd}
          onChange={(event) => setMaxUsd(event.target.value)}
          placeholder="500"
        />
      </label>
      <fieldset>
        <legend>Per-asset-tier acquisition limit (optional)</legend>
        <label>
          Tier
          <select value={tier} onChange={(event) => setTier(event.target.value as AssetTier)}>
            {ASSET_TIER_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label>
          Max USD acquired into this tier per 24h
          <input
            type="text"
            inputMode="decimal"
            value={tierMaxUsd}
            onChange={(event) => setTierMaxUsd(event.target.value)}
            placeholder="100"
          />
        </label>
      </fieldset>
      <button disabled={isBusy || maxUsd.trim() === ''} onClick={handleCommit}>
        Commit
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
