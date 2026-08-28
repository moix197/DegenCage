import { evaluateTrade, migrateConstitution, type AssetTier, type Constitution, type LimitEvaluation } from '@degencage/rules';
import { eq } from 'drizzle-orm';

import { recordEvent } from '../../observability/events';
import { classifyToken } from '../chain/classify-token';
import { lookupTokenDecimals } from '../chain/jupiter-tokens';
import { LOSS_LIMIT_ENABLED_FLAG } from '../chain/reconcile-wallet';
import { loadReconciliationState } from '../dashboard/dashboard-state';
import { getDb } from '../db/client';
import { constitutions, tradeIntents, type TradeIntentStatus } from '../db/schema';
import { isFeatureEnabled } from '../flags/feature-flags';
import { priceTrade } from '../pricing/price-trade';
import { assembleSwapTransaction, type AssembledTransaction } from './assemble-transaction';
import { expireAndReserveLiveIntent, loadEvaluableWindowedTrades, reapExpiredIntents } from './intent-lifecycle';
import { buildSwap, BLOCKHASH_SLOTS_TO_EXPIRY, JupiterBuildError, type JupiterBuildResponse } from './jupiter-client';

/**
 * The pre-trade gate: Jupiter quote in, rule-engine verdict out, before a signature exists.
 *
 * Order matters and is not incidental. Preconditions are checked *first*, before any external
 * call is made, because evaluating a trade against a non-binding document or an incomplete
 * trade history is worse than not evaluating it at all — it produces a confident "allowed"
 * that means nothing. Only then does the quote get built, priced, classified and evaluated,
 * and only a quote the rules allowed is ever assembled into signable bytes.
 *
 * Fail closed at every step, with two distinct shapes:
 *  - a *dependency* that throws (Jupiter, Helius, the database) propagates, and the route
 *    turns it into a 503 — nothing is signed, nothing is recorded as allowed;
 *  - a dependency that resolves to "unknown" (an unpriceable quote, a limit the engine cannot
 *    evaluate) folds to `unevaluable`, which this module treats as a **block** and persists as
 *    one, so the user sees why rather than a silent failure.
 */

/** Same fallback window as `reconcile-wallet.ts`: enough history for any limit the constitution carries. */
const DEFAULT_WINDOW_HOURS = 24;
/** Solana's nominal slot time — the only thing that turns a blockhash's slot lifetime into a wall clock. */
const MS_PER_SLOT = 400;
/**
 * Long enough to absorb the terminal's 500ms debounce plus a double-click against the Free
 * tier's 1 RPS org-wide budget, short enough that a quote never goes visibly stale.
 */
const QUOTE_CACHE_TTL_MS = 3_000;
const QUOTE_CACHE_MAX_ENTRIES = 500;

export type QuotePreconditionReason = 'constitution_not_active' | 'not_reconciled';

/** A refusal to quote at all — distinct from a quote the rules blocked, which is a real recorded decision. */
export class QuotePreconditionError extends Error {
  constructor(readonly reason: QuotePreconditionReason) {
    super(reason);
    this.name = 'QuotePreconditionError';
  }
}

interface CachedBuild {
  build: JupiterBuildResponse;
  expiresAt: number;
}

/**
 * Keyed on the wallet as well as the pair/amount/slippage — never on the pair alone. `taker`
 * is baked into the instructions `/build` returns (ATA derivation, transfer authority), so a
 * key without it would hand one user's assembled transaction, containing their own address, to
 * a different user's session.
 */
const buildCache = new Map<string, CachedBuild>();

function buildCacheKey(params: QuoteRequestParams): string {
  return [params.walletId, params.inputMint, params.outputMint, params.amount, params.slippageBps].join('|');
}

function evictStaleBuilds(now: number): void {
  for (const [key, entry] of buildCache) {
    if (entry.expiresAt <= now) buildCache.delete(key);
  }

  for (const key of buildCache.keys()) {
    if (buildCache.size <= QUOTE_CACHE_MAX_ENTRIES) break;
    buildCache.delete(key);
  }
}

async function buildOrReuseQuote(params: QuoteRequestParams): Promise<JupiterBuildResponse> {
  const now = Date.now();
  const key = buildCacheKey(params);
  const cached = buildCache.get(key);

  if (cached && cached.expiresAt > now) {
    return cached.build;
  }

  const build = await buildSwap({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount,
    taker: params.walletAddress,
    slippageBps: params.slippageBps,
  });

  buildCache.set(key, { build, expiresAt: now + QUOTE_CACHE_TTL_MS });
  evictStaleBuilds(now);

  return build;
}

interface ActiveConstitution {
  id: string;
  document: Constitution;
}

/**
 * The user's constitution, only if it is actually binding. A missing row, a `draft`, or a
 * `committing` row (mid-timelock by design) all mean there is nothing to evaluate against —
 * trading against any of them would let the user act before their own commitment takes effect.
 */
async function loadActiveConstitution(userId: string): Promise<ActiveConstitution | null> {
  const rows = await getDb().select().from(constitutions).where(eq(constitutions.userId, userId)).limit(1);
  const row = rows[0];

  if (!row || row.status !== 'active') {
    return null;
  }

  return { id: row.id, document: migrateConstitution(row.document) };
}

function maxWindowHours(constitution: Constitution): number {
  return constitution.limits.reduce((max, limit) => Math.max(max, limit.windowHours), DEFAULT_WINDOW_HOURS);
}

/**
 * Decision 4's fold: one violation blocks, and so does anything the engine could not evaluate.
 * "Unevaluable" is never treated as "fine" — that is the whole difference between a rule engine
 * and a suggestion.
 */
export function foldVerdict(evaluations: LimitEvaluation[]): 'allow' | 'block' {
  return evaluations.every((evaluation) => evaluation.verdict === 'allow') ? 'allow' : 'block';
}

/**
 * Prices the quote for the *ceiling* limits (`daily_notional_usd`, `asset_tier_acquisition_usd`)
 * off the **sold leg**, named explicitly rather than inferred: `inAmount` is the amount we
 * hand Jupiter for an exact-in swap, so it is fixed no matter how the swap fills, and nothing
 * in the request can shrink it.
 *
 * Neither the optimistic `outAmount` nor the `otherAmountThreshold` floor may denominate a
 * ceiling limit. The threshold is `inAmount * (1 - slippageBps/1e4)` in spirit — pricing a
 * ceiling off it lets a caller understate its own recorded notional by raising its slippage,
 * and understatement is the direction that lets a trade through a limit that should have
 * blocked it (`.ai/decisions/pre-trade-slippage-pricing.md`). `otherAmountThreshold` is still
 * carried on the trade as the bought leg, because that is the right — worst-case — figure
 * for the floor-type direction (`rolling_loss_usd` proceeds).
 */
async function priceCeilingLimits(build: JupiterBuildResponse, occurredAt: Date): Promise<{ usdValue: string | null; priceSource: string | null }> {
  const decimals = await lookupTokenDecimals([build.inputMint, build.outputMint]);
  const soldDecimals = decimals.get(build.inputMint);
  const boughtDecimals = decimals.get(build.outputMint);

  // A guessed decimal scale misprices by orders of magnitude, so an unresolved one is
  // `usd_value: null` — unpriced, never `$0` — which folds every ceiling limit to a block.
  if (soldDecimals === undefined || boughtDecimals === undefined) {
    return { usdValue: null, priceSource: null };
  }

  return priceTrade({
    soldMint: build.inputMint,
    boughtMint: build.outputMint,
    soldAmountBaseUnits: build.inAmount,
    boughtAmountBaseUnits: build.otherAmountThreshold,
    soldDecimals,
    boughtDecimals,
    occurredAt,
    leg: 'sold',
  });
}

/**
 * `/build` carries no quote TTL — only the blockhash's `lastValidBlockHeight`, which we have no
 * current block height to measure against. Since we ask for a known slot lifetime
 * (`BLOCKHASH_SLOTS_TO_EXPIRY`), the honest derivation is that lifetime from the moment Jupiter
 * fetched the blockhash. This is *our* estimate, deliberately conservative, never an
 * authoritative value Jupiter handed us.
 */
export function deriveExpiresAt(build: JupiterBuildResponse, fallbackNow: Date): Date {
  const fetchedAtSecs = build.blockhashWithMetadata.fetchedAt?.secs_since_epoch;
  const fetchedAt = typeof fetchedAtSecs === 'number' ? fetchedAtSecs * 1_000 : fallbackNow.getTime();

  return new Date(fetchedAt + BLOCKHASH_SLOTS_TO_EXPIRY * MS_PER_SLOT);
}

export interface QuoteRequestParams {
  walletId: string;
  walletAddress: string;
  userId: string;
  inputMint: string;
  outputMint: string;
  /** Base units of `inputMint`, as a decimal-digit string. */
  amount: string;
  slippageBps: number;
  correlationId: string;
}

export interface QuoteView {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  priceImpactPct: string;
  routeLabels: string[];
  usdValue: string | null;
  acquiredTier: AssetTier;
}

export interface QuoteResult {
  intentId: string;
  verdict: 'allow' | 'block';
  evaluations: LimitEvaluation[];
  expiresAt: string;
  quote: QuoteView;
  /** Present only for an allowed quote — nothing is assembled for a trade the rules refused. */
  transaction: { messageBase64: string; txMessageHash: string } | null;
}

async function assertPreconditions(params: QuoteRequestParams): Promise<ActiveConstitution> {
  const constitution = await loadActiveConstitution(params.userId);

  if (!constitution) {
    throw new QuotePreconditionError('constitution_not_active');
  }

  // Same survivorship-bias constraint the dashboard enforces: an incomplete history
  // under-counts the rolling allowance, which could approve a trade full history would block.
  if ((await loadReconciliationState(params.walletId)) !== 'current') {
    throw new QuotePreconditionError('not_reconciled');
  }

  return constitution;
}

/**
 * The premise the whole sold-leg pricing rule stands on
 * (`.ai/decisions/pre-trade-slippage-pricing.md`): `inAmount` is a number the request already
 * declared and execution cannot move *only* while the swap is exact-in for the amount we asked
 * for. An exact-out route, or a `/build` that resized the trade, would denominate every ceiling
 * limit in something the user never committed to — so a mismatch fails closed like any other
 * Jupiter failure (throws, `503`, no intent recorded) rather than pricing off it.
 */
function assertExactInPremise(params: QuoteRequestParams, build: JupiterBuildResponse): void {
  if (build.swapMode !== 'ExactIn') {
    throw new JupiterBuildError(`Jupiter /swap/v2/build returned swapMode '${build.swapMode}'; sold-leg pricing requires 'ExactIn'`);
  }

  if (build.inAmount !== params.amount) {
    throw new JupiterBuildError(`Jupiter /swap/v2/build returned inAmount ${build.inAmount} for a requested amount of ${params.amount}`);
  }
}

interface EvaluatedQuote {
  build: JupiterBuildResponse;
  usdValue: string | null;
  acquiredTier: AssetTier;
  evaluations: LimitEvaluation[];
  verdict: 'allow' | 'block';
  occurredAt: Date;
}

/**
 * Everything between "we have a quote" and "we have a verdict". A swap always acquires exactly
 * one tier — the bought leg's — so `isAcquisition` is unconditionally true here, matching
 * `reconcile-wallet.ts`'s treatment of every real trade.
 *
 * `isRoundTripClose`/`realizedLossUsd` are left unset on purpose: there is no lot-matching
 * pre-trade, and decision 4 requires `rolling_loss_usd` to stay evaluable against the window's
 * *known* losses rather than going structurally-unevaluable over this trade's own unknown one.
 */
async function evaluateQuote(params: QuoteRequestParams, constitution: Constitution, build: JupiterBuildResponse): Promise<EvaluatedQuote> {
  // Server clock at build time (decision 15) — never a client-supplied instant.
  const occurredAt = new Date();
  const [{ usdValue }, classification, lossLimitEnabled] = await Promise.all([
    priceCeilingLimits(build, occurredAt),
    classifyToken(build.outputMint),
    isFeatureEnabled(LOSS_LIMIT_ENABLED_FLAG),
  ]);

  // Decision 3's allowance union: persisted `trades` plus any other live intent for this
  // wallet (the prior quote a second concurrent request must see reserved). No exclusion id —
  // this intent has not been inserted yet, so it cannot appear in its own history.
  const windowedHistory = await loadEvaluableWindowedTrades(params.walletId, maxWindowHours(constitution), occurredAt);

  const decision = evaluateTrade(constitution, windowedHistory, {
    occurredAt,
    usdValue,
    isAcquisition: true,
    acquiredTier: classification.tier,
    lossLimitEnabled,
  });

  return {
    build,
    usdValue,
    acquiredTier: classification.tier,
    evaluations: decision.evaluations,
    verdict: foldVerdict(decision.evaluations),
    occurredAt,
  };
}

function toQuoteView(evaluated: EvaluatedQuote): QuoteView {
  const { build } = evaluated;

  return {
    inputMint: build.inputMint,
    outputMint: build.outputMint,
    inAmount: build.inAmount,
    outAmount: build.outAmount,
    otherAmountThreshold: build.otherAmountThreshold,
    slippageBps: build.slippageBps,
    priceImpactPct: build.priceImpactPct,
    routeLabels: build.routePlan.map((step) => step.swapInfo.label),
    usdValue: evaluated.usdValue,
    acquiredTier: evaluated.acquiredTier,
  };
}

/**
 * The intent row and both its events are written in one transaction: a decision that reached
 * the user must be reconstructable from the audit trail, and a half-written one would leave a
 * live intent nothing explains (or an explanation for an intent that does not exist).
 *
 * Wrapped in `expireAndReserveLiveIntent` (`intent-lifecycle.ts`) rather than a plain
 * `getDb().transaction()`: requesting this quote is what expires the wallet's prior live
 * intent (decision 3), and the expire, the `trade.intent_expired` event and this insert all
 * have to land atomically, under the same wallet-row lock, or two concurrent quote requests
 * for the same wallet could both expire the same prior intent or both insert a live row.
 */
async function persistIntent(
  params: QuoteRequestParams,
  constitutionId: string,
  evaluated: EvaluatedQuote,
  assembled: AssembledTransaction | null,
  expiresAt: Date,
): Promise<string> {
  const status: TradeIntentStatus = evaluated.verdict === 'allow' ? 'quoted' : 'blocked';

  return expireAndReserveLiveIntent(params.walletId, async (tx, expiredIntentId) => {
    if (expiredIntentId) {
      await recordEvent(
        {
          eventType: 'trade.intent_expired',
          occurredAt: evaluated.occurredAt,
          correlationId: params.correlationId,
          userId: params.userId,
          payload: { intentId: expiredIntentId, walletId: params.walletId, reason: 'new_quote_requested' },
        },
        tx,
      );
    }

    const inserted = await tx
      .insert(tradeIntents)
      .values({
        walletId: params.walletId,
        constitutionId,
        status,
        inputMint: evaluated.build.inputMint,
        outputMint: evaluated.build.outputMint,
        inAmount: evaluated.build.inAmount,
        outAmount: evaluated.build.outAmount,
        usdValue: evaluated.usdValue,
        acquiredTier: evaluated.acquiredTier,
        evaluations: evaluated.evaluations,
        quoteResponse: evaluated.build as unknown as Record<string, unknown>,
        txMessageHash: assembled?.txMessageHash ?? null,
        expiresAt,
      })
      .returning({ id: tradeIntents.id });

    const intentId = inserted[0]!.id;
    const payload = {
      intentId,
      inputMint: evaluated.build.inputMint,
      outputMint: evaluated.build.outputMint,
      inAmount: evaluated.build.inAmount,
      outAmount: evaluated.build.outAmount,
      otherAmountThreshold: evaluated.build.otherAmountThreshold,
      slippageBps: evaluated.build.slippageBps,
      usdValue: evaluated.usdValue,
      acquiredTier: evaluated.acquiredTier,
    };

    await recordEvent(
      {
        eventType: 'trade.intent_created',
        occurredAt: evaluated.occurredAt,
        correlationId: params.correlationId,
        userId: params.userId,
        payload: { ...payload, status, expiresAt: expiresAt.toISOString() },
      },
      tx,
    );

    // Deliberately a separate event type from `rule.decision_recorded`, which reconciliation
    // writes for a trade that already happened: this one is a decision made *before* the trade,
    // and Phase 5's dashboard has to be able to tell the two apart.
    await recordEvent(
      {
        eventType: 'rule.pre_trade_decision',
        occurredAt: evaluated.occurredAt,
        correlationId: params.correlationId,
        userId: params.userId,
        payload: { ...payload, verdict: evaluated.verdict, evaluations: evaluated.evaluations },
      },
      tx,
    );

    return intentId;
  });
}

/**
 * Quote a swap and decide whether the user's own rules permit it.
 *
 * @throws QuotePreconditionError when there is nothing binding to evaluate against, or the
 *   wallet's history is not fully reconciled — the caller surfaces these as `409`, distinct
 *   from a rule block, which is a successful `200` carrying `verdict: 'block'`.
 */
export async function createQuote(params: QuoteRequestParams): Promise<QuoteResult> {
  const constitution = await assertPreconditions(params);
  // Reaped here, before the unconditional expire-prior-intent step further down in
  // `persistIntent` (`.ai` mechanisms doc's "Active expiry reaping" — called from two places),
  // so a wallet whose only live intent silently timed out is never mistaken for one this quote
  // needs to expire, and so `evaluateQuote`'s live-intent sum below never counts a
  // wall-clock-expired row.
  await reapExpiredIntents(params.walletId);
  // Read before `/build`, not after: this is the fallback for a response that carries no
  // `fetchedAt`, and a clock read once the call has already returned dates the blockhash
  // later than it was fetched — which would push `expires_at` past the real lifetime.
  const requestedAt = new Date();
  const build = await buildOrReuseQuote(params);
  assertExactInPremise(params, build);
  const evaluated = await evaluateQuote(params, constitution.document, build);

  // Only an allowed quote is turned into signable bytes: assembling a blocked one would spend
  // a Helius simulation on a trade that must never be signed, and would hand the browser a
  // message it has no business holding.
  const assembled = evaluated.verdict === 'allow' ? await assembleSwapTransaction(build, params.walletAddress) : null;
  const expiresAt = deriveExpiresAt(build, requestedAt);
  const intentId = await persistIntent(params, constitution.id, evaluated, assembled, expiresAt);

  return {
    intentId,
    verdict: evaluated.verdict,
    evaluations: evaluated.evaluations,
    expiresAt: expiresAt.toISOString(),
    quote: toQuoteView(evaluated),
    transaction: assembled ? { messageBase64: assembled.messageBase64, txMessageHash: assembled.txMessageHash } : null,
  };
}
