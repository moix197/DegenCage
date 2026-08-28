'use client';

import { useEffect, useRef, useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useSwapSigning, type SigningCapability } from '@/client/wallet/use-swap-signing';

/**
 * The terminal's client half: pick a swap, wait out the debounce, and see the rule engine's
 * verdict on that exact trade alongside the quote.
 *
 * The verdict is never computed here. This component renders whatever `POST /api/swap/quote`
 * returned and nothing else — a client-side "looks fine to me" would be trivially bypassable
 * and would drift from the server's decision the moment either changed.
 *
 * The same is true of Approve. Disabling the button for a blocked quote is a courtesy, not the
 * enforcement: `POST /api/swap/submit` re-verifies the signed bytes against the intent the
 * server itself approved and re-runs the rule engine before anything is broadcast, so a user
 * who re-enables the button in devtools gets a `409`, not a trade. All this component does is
 * hand the server's own compiled message to the wallet and post back what comes out.
 *
 * Signing lives behind `use-swap-signing`, in `src/client/wallet/` — nothing wallet-standard or
 * Kit-shaped is imported here (`.ai/decisions/wallet-standard-ui-dependency.md`).
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
  /** Present only for an allowed quote — the server assembles nothing for a trade the rules refused. */
  transaction: { messageBase64: string; txMessageHash: string } | null;
  correlationId: string;
}

interface SubmitResponse {
  intentId: string;
  status: string;
  signature: string;
  /**
   * True while `chain.broadcast` is off: the signed transaction was verified by simulation, not
   * sent. `null` on a replay whose original submit has not recorded an outcome yet — unknown,
   * which is neither of the two.
   */
  dryRun: boolean | null;
  replayed: boolean;
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

const SUBMIT_ERROR_COPY: Record<string, string> = {
  wallet_mismatch: 'That quote belongs to a different wallet. Request a new one for the account you have connected.',
  intent_expired: 'This quote expired before it was signed. Request a new one — prices and your allowance have both moved on.',
  intent_not_signable: 'This quote is no longer in a state that can be submitted. Request a new one.',
  intent_not_found: 'We no longer have that quote on file. Request a new one.',
  message_hash_mismatch: 'The signed transaction did not match the one we approved, so nothing was submitted.',
  fee_payer_mismatch: 'The signed transaction pays from a different account than your session. Nothing was submitted.',
  missing_signature: 'Your wallet returned an unsigned transaction. Nothing was submitted.',
  malformed_transaction: 'We could not read what your wallet returned, so nothing was submitted.',
  constitution_not_active: 'Your constitution is no longer active, so this trade could not be re-checked. Nothing was submitted.',
  constitution_changed: 'Your constitution changed after this quote was made, so it was re-checked against rules it was never evaluated under. Request a new quote.',
  rules_now_block: 'Your own limits no longer allow this trade — something moved between the quote and your signature. Nothing was submitted.',
  broadcast_failed: 'The signed transaction did not verify against the network, so nothing was submitted.',
  submit_unavailable: 'We could not verify this trade, so it was not submitted.',
  invalid_request: 'That submission was malformed, so nothing was submitted.',
};

const CAPABILITY_COPY: Record<Exclude<SigningCapability, 'sign_transaction'>, string> = {
  unsupported: 'Connect a signing wallet to approve trades — this account can only be watched.',
  sign_and_send_only:
    'This wallet can only sign and broadcast in one step, which would skip DegenCage checking the signed transaction. Connect a wallet that can sign on its own.',
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

/**
 * `dryRun` is not a detail to hide: while `chain.broadcast` is off the transaction was verified
 * against the network and deliberately *not* sent, and telling the user it traded would be a
 * lie. An unknown outcome gets its own wording for the same reason — guessing either way is
 * that same lie in one of its two directions.
 */
const OUTCOME_COPY = {
  dry_run: {
    title: 'Verified — not broadcast',
    body: 'Your signature was checked against the transaction we approved and simulated on chain. Broadcasting is switched off, so no funds moved.',
  },
  broadcast: { title: 'Submitted', body: 'Your signed transaction was broadcast.' },
  unknown: {
    title: 'Already submitted',
    body: 'This submission was already handled and its outcome is still being recorded. Check the dashboard for the result.',
  },
} as const;

function outcomeCopyFor(dryRun: boolean | null) {
  if (dryRun === null) return OUTCOME_COPY.unknown;

  return dryRun ? OUTCOME_COPY.dry_run : OUTCOME_COPY.broadcast;
}

/** Matches `dashboard-panel.tsx` — one cadence for every status poll in the app. */
const STATUS_POLL_INTERVAL_MS = 15_000;

/**
 * Statuses reconciliation can no longer move off. Polling stops here: anything else would keep
 * a timer alive forever for an intent whose story is already over.
 */
const TERMINAL_INTENT_STATUSES = new Set(['confirmed', 'failed', 'expired']);

/**
 * Reconciliation's verdict, once Helius has actually seen the transaction — distinct from the
 * submit-time outcome above, which only ever says what *we* did with the signed bytes. Until
 * one of these lands the trade is genuinely unresolved, and saying so is more honest than
 * leaving the submit message as the last word.
 *
 * `failed`'s wording deliberately doesn't claim either "never landed" or "landed": that status
 * covers both a transaction that never made it on chain at all (`sweepStrandedSubmittedIntents`,
 * `reconcile-wallet.ts`) and one that did land but wasn't a swap we can account for
 * (`no_net_change`/`pure_send`/`pure_receive`, per `resolveIntentOutcome` in that same file) —
 * the status this component polls carries no field distinguishing the two, so asserting either
 * one specifically would sometimes be a lie.
 */
const STATUS_COPY: Record<string, string> = {
  submitted: 'Waiting for the network to confirm this trade.',
  signed: 'Waiting for the network to confirm this trade.',
  confirmed: 'Confirmed on chain.',
  failed:
    'This trade did not complete as a swap we can account for — either it never landed on chain, or it landed without completing the swap. Your allowance has been released.',
  expired: 'This quote expired before the trade landed. Your allowance has been released.',
};

/** What happened after the user signed. */
function SubmitOutcome({ outcome, liveStatus }: { outcome: SubmitResponse; liveStatus: string | null }) {
  const copy = outcomeCopyFor(outcome.dryRun);
  const statusLine = liveStatus ? STATUS_COPY[liveStatus] : null;

  return (
    <Alert>
      <AlertTitle>{copy.title}</AlertTitle>
      <AlertDescription>
        <p>{copy.body}</p>
        <p>Signature: {outcome.signature}</p>
        {outcome.replayed ? <p>This submission had already been processed — nothing was done twice.</p> : null}
        {statusLine ? <p>{statusLine}</p> : null}
      </AlertDescription>
    </Alert>
  );
}

export function TradePanel() {
  const [inputMint, setInputMint] = useState<string>(SELLABLE_TOKENS[0].mint);
  const [outputMint, setOutputMint] = useState('');
  const [amount, setAmount] = useState('');
  const [result, setResult] = useState<QuoteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitOutcome, setSubmitOutcome] = useState<SubmitResponse | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [accountSwitchNotice, setAccountSwitchNotice] = useState(false);
  const [intentStatus, setIntentStatus] = useState<string | null>(null);
  const { capability, isSigning, error: signingError, sign, connectedAddress } = useSwapSigning();

  /**
   * `connectedAddress` is `useSwapSigning`'s own `wallet-account-watch.ts` subscription
   * (`.ai` Phase 4 mechanisms doc — "reuses the existing wallet-account-watch.ts
   * subscription"), not a second one: the account-switch server-side path
   * (`server/auth/session.ts`) is already expiring this wallet's live intent by the time this
   * fires, so any quote sitting on screen belongs to a wallet this session no longer trusts —
   * clearing it here rather than leaving a stale verdict up is the point, not a courtesy.
   */
  const previousConnectedAddress = useRef<string | null>(null);

  useEffect(() => {
    const previous = previousConnectedAddress.current;
    previousConnectedAddress.current = connectedAddress;

    if (previous !== null && connectedAddress !== previous) {
      setResult(null);
      setError(null);
      setSubmitOutcome(null);
      setIntentStatus(null);
      setSubmitError(null);
      setAccountSwitchNotice(true);
    }
  }, [connectedAddress]);

  /**
   * Reconciliation (Phase 5) is what actually resolves a submitted intent, and it runs on its
   * own Helius-driven schedule — so the terminal polls rather than being told. Stops as soon as
   * the intent reaches a status reconciliation can no longer move it off, and a failed poll is
   * left to the next tick: a stale status line is not worth surfacing an error over.
   */
  const polledIntentId = submitOutcome?.intentId ?? null;

  // Read inside the interval/poll closures below instead of listed as an effect dependency:
  // that keeps the effect itself keyed on `polledIntentId` alone, so a status transition never
  // tears down and rebuilds the interval — only a new intent to poll does.
  const intentStatusRef = useRef<string | null>(null);

  useEffect(() => {
    intentStatusRef.current = intentStatus;
  }, [intentStatus]);

  useEffect(() => {
    if (polledIntentId === null) {
      return;
    }

    let cancelled = false;
    let inFlight = false;

    async function poll(): Promise<void> {
      const status = intentStatusRef.current;

      if (inFlight || (status !== null && TERMINAL_INTENT_STATUSES.has(status))) {
        return;
      }

      inFlight = true;

      try {
        const response = await fetch(`/api/swap/intent/${polledIntentId}`);

        if (!response.ok) return;

        const body = (await response.json()) as { status?: string };

        if (!cancelled && typeof body.status === 'string') {
          setIntentStatus(body.status);
        }
      } catch {
        // Next tick will try again.
      } finally {
        inFlight = false;
      }
    }

    // Fires once immediately, per intent — a just-submitted intent should never sit on a stale
    // status for a full interval before its first real check — then continues on the same
    // cadence for as long as this same intent is being polled, regardless of how many status
    // transitions it goes through before reaching a terminal one.
    void poll();
    const id = setInterval(() => void poll(), STATUS_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [polledIntentId]);

  const decimals = SELLABLE_TOKENS.find((token) => token.mint === inputMint)?.decimals ?? 0;
  const baseUnits = toBaseUnits(amount, decimals);
  const ready = baseUnits !== null && outputMint.length > 0 && outputMint !== inputMint;

  useEffect(() => {
    // A new quote invalidates the last submission's outcome: what is on screen must always
    // describe the quote currently in hand, never a previous one.
    setSubmitOutcome(null);
    setIntentStatus(null);
    setSubmitError(null);
    setAccountSwitchNotice(false);

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

  const canApprove =
    result !== null && result.verdict === 'allow' && result.transaction !== null && capability === 'sign_transaction' && !isSigning && !submitting && !loading;

  async function postSignedTransaction(intentId: string, signedTransaction: string): Promise<void> {
    setSubmitting(true);

    try {
      const response = await fetch('/api/swap/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ intentId, signedTransaction }),
      });
      const body = (await response.json()) as SubmitResponse & { error?: string };

      if (!response.ok) {
        setSubmitError(SUBMIT_ERROR_COPY[body.error ?? ''] ?? 'This trade could not be verified, so nothing was submitted.');
        return;
      }

      setSubmitOutcome(body);
      setIntentStatus(body.status);
    } catch {
      setSubmitError(SUBMIT_ERROR_COPY.submit_unavailable!);
    } finally {
      setSubmitting(false);
    }
  }

  async function approve(): Promise<void> {
    if (!result?.transaction) {
      return;
    }

    setSubmitError(null);
    setSubmitOutcome(null);
    setIntentStatus(null);

    // A refused signature is already described by the hook's own `error`; adding a second
    // message here would say the same thing twice.
    const signedTransaction = await sign(result.transaction.messageBase64);

    if (signedTransaction) {
      await postSignedTransaction(result.intentId, signedTransaction);
    }
  }

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

      {accountSwitchNotice ? (
        <Alert>
          <AlertTitle>Wallet switched accounts</AlertTitle>
          <AlertDescription>Your connected wallet changed, so this quote was reset. Request a new one for the account you are using now.</AlertDescription>
        </Alert>
      ) : null}

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

      {result?.verdict === 'allow' ? (
        <p className="text-sm text-muted-foreground">
          Approving prompts your wallet to sign a real mainnet transaction. There is no test network here — check the amounts above before you sign.
        </p>
      ) : null}

      {capability !== null && capability !== 'sign_transaction' ? (
        <Alert>
          <AlertTitle>This wallet cannot approve trades</AlertTitle>
          <AlertDescription>{CAPABILITY_COPY[capability]}</AlertDescription>
        </Alert>
      ) : null}

      {signingError ? (
        <Alert variant="destructive">
          <AlertTitle>Nothing was submitted</AlertTitle>
          <AlertDescription>{signingError}</AlertDescription>
        </Alert>
      ) : null}

      {submitError ? (
        <Alert variant="destructive">
          <AlertTitle>Nothing was submitted</AlertTitle>
          <AlertDescription>{submitError}</AlertDescription>
        </Alert>
      ) : null}

      {submitOutcome ? <SubmitOutcome outcome={submitOutcome} liveStatus={intentStatus} /> : null}

      {/* Disabled is a courtesy; `/api/swap/submit` refuses a blocked or expired intent
          regardless of what this button allows. */}
      <Button disabled={!canApprove} type="button" onClick={() => void approve()}>
        {isSigning ? 'Waiting for your wallet…' : submitting ? 'Verifying…' : 'Approve and sign'}
      </Button>
    </div>
  );
}
