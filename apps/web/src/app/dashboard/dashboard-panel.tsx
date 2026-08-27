'use client';

import { useCallback, useEffect, useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { DashboardApiResponse } from '@/app/api/dashboard/route';

/**
 * The dashboard's live half (Phase 7): the allowance cards and the "we saw that" feed,
 * re-read from the server on an interval so both visibly move as the rolling window slides
 * — never a client-side clock counting anything down. Same discipline as
 * `constitution/constitution-panel.tsx`'s countdown poll: `refresh()` always replaces state
 * with the last `GET /api/dashboard` response, in full, never a locally-derived guess.
 */

const POLL_INTERVAL_MS = 15_000;

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

function AllowanceCard({ title, allowance, isRefreshing }: { title: string; allowance: SimpleAllowance | null; isRefreshing: boolean }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        {allowance ? <LimitStatusBadge allowance={allowance} /> : null}
      </CardHeader>
      <CardContent>
        {isRefreshing ? <Skeleton className="h-8 w-32" /> : null}
        {!isRefreshing && allowance ? (
          <p className="text-2xl font-semibold">
            {allowance.totalUsd === null ? 'unknown' : `$${allowance.totalUsd}`}{' '}
            <span className="text-sm font-normal text-muted-foreground">of ${allowance.maxUsd}</span>
          </p>
        ) : null}
        {!isRefreshing && !allowance ? <p className="text-sm text-muted-foreground">No limit set.</p> : null}
        {!isRefreshing && allowance?.totalUsd === null ? (
          <p className="mt-1 text-xs text-muted-foreground">Some trades in the window could not be priced — never assumed clean.</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function LossAllowanceCard({ lossAllowance, isRefreshing }: { lossAllowance: DashboardApiResponse['lossAllowance']; isRefreshing: boolean }) {
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
        {isRefreshing ? (
          <Skeleton className="h-8 w-32" />
        ) : (
          <p className="text-2xl font-semibold">
            ${lossAllowance.totalUsd} <span className="text-sm font-normal text-muted-foreground">of ${lossAllowance.maxUsd}</span>
          </p>
        )}
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
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);

  const refresh = useCallback(async () => {
    setIsRefreshing(true);

    try {
      const response = await fetch('/api/dashboard', { cache: 'no-store' });

      if (!response.ok) {
        setRefreshFailed(true);
        return;
      }

      setData((await response.json()) as DashboardApiResponse);
      setRefreshFailed(false);
    } catch {
      setRefreshFailed(true);
    } finally {
      setIsRefreshing(false);
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
        <AllowanceCard title="Daily notional" allowance={data.allowance} isRefreshing={isRefreshing} />
        {data.tierAllowance ? (
          <AllowanceCard title={`${data.tierAllowance.tier} acquisitions`} allowance={data.tierAllowance} isRefreshing={isRefreshing} />
        ) : null}
        <LossAllowanceCard lossAllowance={data.lossAllowance} isRefreshing={isRefreshing} />
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
