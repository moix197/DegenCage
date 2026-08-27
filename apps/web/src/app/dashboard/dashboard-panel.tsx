'use client';

import { useCallback, useEffect, useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { DashboardApiResponse } from '@/server/dashboard/dashboard-state';

/**
 * The dashboard's live half (Phase 7): the allowance cards and the "we saw that" feed,
 * re-read from the server on an interval so both visibly move as the rolling window slides
 * — never a client-side clock counting anything down. Same discipline as
 * `constitution/constitution-panel.tsx`'s countdown poll: `refresh()` always replaces state
 * with the last `GET /api/dashboard` response, in full, never a locally-derived guess.
 *
 * A background poll never hides the current figures — `data` only ever moves forward to a
 * newer successful response; a failed or in-flight poll leaves whatever is already on
 * screen exactly as it was (the `refreshFailed` banner is the only visible sign of it).
 */

const POLL_INTERVAL_MS = 15_000;

/**
 * Reports a failed poll without pulling `@sentry/nextjs`'s browser SDK into this page's
 * initial bundle: `error-tracking.ts` is imported statically all over the server, but a
 * client component has to load it lazily, same gate `instrumentation-client.ts` uses, or
 * every dashboard visit pays for Sentry's client runtime whether or not a poll ever fails
 * (`.ai/decisions/observability-stack.md`).
 */
function reportRefreshFailure(error: unknown): void {
  void import('@/observability/error-tracking').then(({ captureError }) => {
    captureError(error, { component: 'dashboard-panel', route: '/api/dashboard' });
  });
}

interface SimpleAllowance {
  maxUsd: string;
  totalUsd: string | null;
  withinLimit: boolean;
}

function LimitStatusBadge({ allowance }: { allowance: SimpleAllowance }) {
  if (allowance.totalUsd === null) {
    return <Badge variant="outline">unknown</Badge>;
  }

  return <Badge variant={allowance.withinLimit ? 'outline' : 'destructive'}>{allowance.withinLimit ? 'within limit' : 'over limit'}</Badge>;
}

function AllowanceCard({ title, allowance }: { title: string; allowance: SimpleAllowance | null }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        {allowance ? <LimitStatusBadge allowance={allowance} /> : null}
      </CardHeader>
      <CardContent>
        {allowance ? (
          <p className="text-2xl font-semibold">
            {allowance.totalUsd === null ? 'unknown' : `$${allowance.totalUsd}`}{' '}
            <span className="text-sm font-normal text-muted-foreground">of ${allowance.maxUsd}</span>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">No limit set.</p>
        )}
        {allowance?.totalUsd === null ? (
          <p className="mt-1 text-xs text-muted-foreground">Some trades in the window could not be priced — never assumed clean.</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function LossAllowanceCard({ lossAllowance }: { lossAllowance: DashboardApiResponse['lossAllowance'] }) {
  if (!lossAllowance) {
    return null;
  }

  if (!lossAllowance.enabled) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Realized loss</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Loss-matching is switched off right now — status unknown, never shown as clean.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-medium">Realized loss</CardTitle>
        <LimitStatusBadge allowance={lossAllowance} />
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold">
          ${lossAllowance.totalUsd} <span className="text-sm font-normal text-muted-foreground">of ${lossAllowance.maxUsd}</span>
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Covers only round-trips — bought and later sold — where both sides happened after this constitution
          activated. Not your full P&L.
        </p>
      </CardContent>
    </Card>
  );
}

function ViolationsFeed({ violations }: { violations: DashboardApiResponse['violations'] }) {
  if (violations.length === 0) {
    return <p className="mt-2 text-sm text-muted-foreground">Nothing here yet.</p>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>When</TableHead>
          <TableHead>What we saw</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {violations.map((violation) => (
          <TableRow key={`${violation.correlationId}-${violation.limitType}`}>
            <TableCell className="whitespace-nowrap text-muted-foreground">{new Date(violation.occurredAt).toLocaleString()}</TableCell>
            <TableCell>{violation.message}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export interface DashboardPanelProps {
  initial: DashboardApiResponse;
}

export function DashboardPanel({ initial }: DashboardPanelProps) {
  const [data, setData] = useState<DashboardApiResponse>(initial);
  const [refreshFailed, setRefreshFailed] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/dashboard', { cache: 'no-store' });

      if (!response.ok) {
        setRefreshFailed(true);
        reportRefreshFailure(new Error(`dashboard refresh failed with status ${response.status}`));
        return;
      }

      setData((await response.json()) as DashboardApiResponse);
      setRefreshFailed(false);
    } catch (error) {
      setRefreshFailed(true);
      reportRefreshFailure(error);
    }
  }, []);

  useEffect(() => {
    const id = setInterval(refresh, POLL_INTERVAL_MS);

    return () => clearInterval(id);
  }, [refresh]);

  return (
    <div className="flex flex-col gap-6">
      <Alert>
        <AlertTitle>Your limits reset continuously — never at midnight</AlertTitle>
        <AlertDescription>
          Each limit below is a rolling window. As trades age past the window&apos;s edge, the figure recovers on its
          own, live, without you doing anything.
        </AlertDescription>
      </Alert>

      {refreshFailed ? (
        <Alert variant="destructive">
          <AlertTitle>Could not refresh</AlertTitle>
          <AlertDescription>Showing the last figures we had — retrying in the background.</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <AllowanceCard title="Daily notional" allowance={data.allowance} />
        {data.tierAllowance ? <AllowanceCard title={`${data.tierAllowance.tier} acquisitions`} allowance={data.tierAllowance} /> : null}
        <LossAllowanceCard lossAllowance={data.lossAllowance} />
      </div>

      <Separator />

      <section>
        <h2 className="text-base font-semibold">We saw that</h2>
        <p className="text-sm text-muted-foreground">
          A record of limits you exceeded on this wallet since you activated your constitution — not a penalty, just
          the truth about what happened.
        </p>
        <ViolationsFeed violations={data.violations} />
      </section>
    </div>
  );
}
