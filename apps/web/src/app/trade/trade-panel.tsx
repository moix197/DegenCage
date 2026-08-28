'use client';

import { useEffect, useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * The terminal's client half: pick a swap, wait out the debounce, and see the rule engine's
 * verdict on that exact trade alongside the quote.
 *
 * The verdict is never computed here. This component renders whatever `POST /api/swap/quote`
 * returned and nothing else — a client-side "looks fine to me" would be trivially bypassable
 * and would drift from the server's decision the moment either changed. The submit control
 * exists but is permanently disabled in this phase: nothing signs yet.
 */

/**
 * The debounce is a rate-limit requirement, not a UX nicety: Jupiter's Free tier is 1 RPS
 * shared org-wide across `/swap/v2/build` and the token search the same quote depends on, so
 * a keystroke-per-request terminal would 429 itself.
 */
const QUOTE_DEBOUNCE_MS = 500;

/**
 * The sell side is a fixed list so the amount the user types can be converted to base units
 * exactly, with no float and no extra decimals lookup. The buy side accepts any mint.
 */
const SELLABLE_TOKENS = [
  { mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL', decimals: 9 },
  { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6 },
  { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT', decimals: 6 },
] as const;

interface LimitEvaluationView {
  limitId: string;
  type: string;
  verdict: 'allow' | 'violation' | 'unevaluable';
  maxUsd: string;
  windowHours: number;
  priorUsd: string | null;
  totalUsd: string | null;
  reason: string;
}

interface QuoteResponse {
  intentId: string;
  verdict: 'allow' | 'block';
  evaluations: LimitEvaluationView[];
  expiresAt: string;
  quote: {
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    otherAmountThreshold: string;
    slippageBps: number;
    priceImpactPct: string;
    routeLabels: string[];
    usdValue: string | null;
    acquiredTier: string;
  };
  correlationId: string;
}

/** Exact decimal-to-base-units conversion via digit strings — never `parseFloat`, which loses lamports. */
function toBaseUnits(amount: string, decimals: number): string | null {
  if (!/^[0-9]*\.?[0-9]*$/.test(amount) || amount === '' || amount === '.') {
    return null;
  }

  const [wholePart = '', fractionPart = ''] = amount.split('.');

  if (fractionPart.length > decimals) {
    return null;
  }

  const digits = `${wholePart}${fractionPart.padEnd(decimals, '0')}`.replace(/^0+/, '');

  return digits === '' ? null : digits;
}

const ERROR_COPY: Record<string, string> = {
  constitution_not_active: 'Your constitution is not active yet. Finish activating it before trading through DegenCage.',
  not_reconciled: 'We could not confirm your full trade history just now, so no trade can be checked against your limits. Reopen your dashboard to reconcile.',
  unauthenticated: 'Your session ended. Connect your wallet again.',
  invalid_request: 'That mint address or amount is not valid.',
  trade_terminal_disabled: 'The trading terminal is switched off right now.',
  quote_unavailable: 'We could not get a verdict for this trade, so it is blocked. Nothing about your wallet is wrong — try again shortly.',
};

function VerdictAlert({ result }: { result: QuoteResponse }) {
  if (result.verdict === 'allow') {
    return (
      <Alert>
        <AlertTitle>Within your limits</AlertTitle>
        <AlertDescription>This trade fits every limit in your constitution.</AlertDescription>
      </Alert>
    );
  }

  const blocking = result.evaluations.filter((evaluation) => evaluation.verdict !== 'allow');

  return (
    <Alert variant="destructive">
      <AlertTitle>Blocked by your own rules</AlertTitle>
      <AlertDescription>
        <ul>
          {blocking.map((evaluation) => (
            <li key={evaluation.limitId}>
              {evaluation.type} — {evaluation.reason}
              {evaluation.totalUsd !== null ? ` (${evaluation.totalUsd} of ${evaluation.maxUsd} over ${evaluation.windowHours}h)` : ''}
            </li>
          ))}
        </ul>
        <p>
          You wrote these limits while calm. If you still want to change them,{' '}
          <a href="/constitution/edit">edit your constitution</a> — a loosening takes 48 hours.
        </p>
      </AlertDescription>
    </Alert>
  );
}

function QuoteDetails({ result }: { result: QuoteResponse }) {
  const { quote } = result;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Quote</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1 text-sm">
        <p>Selling {quote.inAmount} base units</p>
        <p>Estimated out: {quote.outAmount} base units</p>
        <p>Minimum received: {quote.otherAmountThreshold} base units (slippage {quote.slippageBps} bps)</p>
        <p>Price impact: {quote.priceImpactPct}</p>
        <p>Route: {quote.routeLabels.length > 0 ? quote.routeLabels.join(' → ') : 'direct'}</p>
        <p>Counted against your limits as: {quote.usdValue === null ? 'unpriced — never assumed free' : `$${quote.usdValue}`}</p>
        <p>Acquiring: {quote.acquiredTier}</p>
      </CardContent>
    </Card>
  );
}

export function TradePanel() {
  const [inputMint, setInputMint] = useState<string>(SELLABLE_TOKENS[0].mint);
  const [outputMint, setOutputMint] = useState('');
  const [amount, setAmount] = useState('');
  const [result, setResult] = useState<QuoteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const decimals = SELLABLE_TOKENS.find((token) => token.mint === inputMint)?.decimals ?? 0;
  const baseUnits = toBaseUnits(amount, decimals);
  const ready = baseUnits !== null && outputMint.length > 0 && outputMint !== inputMint;

  useEffect(() => {
    if (!ready) {
      setResult(null);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);

    const timer = setTimeout(async () => {
      try {
        const response = await fetch('/api/swap/quote', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ inputMint, outputMint, amount: baseUnits }),
        });
        const body = (await response.json()) as QuoteResponse & { error?: string };

        if (cancelled) return;

        if (!response.ok) {
          setResult(null);
          setError(ERROR_COPY[body.error ?? ''] ?? 'This trade could not be checked, so it is blocked.');
          return;
        }

        setResult(body);
        setError(null);
      } catch {
        if (!cancelled) {
          setResult(null);
          setError(ERROR_COPY.quote_unavailable!);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, QUOTE_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [ready, inputMint, outputMint, baseUnits]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="trade-input-mint">Sell</Label>
        <Select value={inputMint} onValueChange={(value) => setInputMint(value as string)}>
          <SelectTrigger id="trade-input-mint">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SELLABLE_TOKENS.map((token) => (
              <SelectItem key={token.mint} value={token.mint}>
                {token.symbol}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="trade-amount">Amount</Label>
        <Input id="trade-amount" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.0" />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="trade-output-mint">Buy (mint address)</Label>
        <Input id="trade-output-mint" value={outputMint} onChange={(event) => setOutputMint(event.target.value.trim())} placeholder="Mint address" />
      </div>

      {loading ? <Skeleton className="h-24 w-full" /> : null}

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>No verdict, so no trade</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {result && !loading ? (
        <>
          <VerdictAlert result={result} />
          <QuoteDetails result={result} />
        </>
      ) : null}

      {/* Present, and permanently disabled in this phase: signing lands next, and the server
          blocks regardless of what this button does. */}
      <Button disabled type="button">
        Approve and sign — not available yet
      </Button>
    </div>
  );
}
