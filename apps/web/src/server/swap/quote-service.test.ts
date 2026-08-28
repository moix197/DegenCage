import type { Constitution } from '@degencage/rules';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { tradeIntents, trades } from '../db/schema';
import { createQuote, foldVerdict, QuotePreconditionError } from './quote-service';
import type { JupiterBuildResponse } from './jupiter-client';

/**
 * The gate itself: what blocks, what does not, and what gets written down.
 *
 * `priceTrade` is deliberately **not** mocked — the slippage-safe leg rule is the thing under
 * test in the pricing cases, and mocking it would assert only that a mock was called. Its
 * stablecoin paths need no I/O, so every fixture here sells or buys a stablecoin leg.
 */

const {
  loadReconciliationStateMock,
  classifyTokenMock,
  lookupTokenDecimalsMock,
  loadWindowedTradesMock,
  isFeatureEnabledMock,
  buildSwapMock,
  assembleSwapTransactionMock,
  recordEventMock,
  selectMock,
  updateMock,
  transactionMock,
  insertedValuesSpy,
  getSolUsdPriceMock,
  getBirdeyeUsdPriceMock,
} = vi.hoisted(() => ({
  loadReconciliationStateMock: vi.fn(),
  classifyTokenMock: vi.fn(),
  lookupTokenDecimalsMock: vi.fn(),
  loadWindowedTradesMock: vi.fn(),
  isFeatureEnabledMock: vi.fn(),
  buildSwapMock: vi.fn(),
  assembleSwapTransactionMock: vi.fn(),
  recordEventMock: vi.fn(),
  selectMock: vi.fn(),
  updateMock: vi.fn(),
  transactionMock: vi.fn(),
  insertedValuesSpy: vi.fn(),
  getSolUsdPriceMock: vi.fn(),
  getBirdeyeUsdPriceMock: vi.fn(),
}));

vi.mock('../dashboard/dashboard-state', () => ({ loadReconciliationState: loadReconciliationStateMock }));
vi.mock('../chain/classify-token', () => ({ classifyToken: classifyTokenMock }));
vi.mock('../chain/jupiter-tokens', () => ({ lookupTokenDecimals: lookupTokenDecimalsMock }));
vi.mock('../chain/reconcile-wallet', () => ({ LOSS_LIMIT_ENABLED_FLAG: 'rules.loss_limit_enabled' }));
vi.mock('../rules/rolling-allowance', () => ({ loadWindowedTrades: loadWindowedTradesMock }));
vi.mock('../flags/feature-flags', () => ({ isFeatureEnabled: isFeatureEnabledMock }));
vi.mock('./jupiter-client', () => ({ buildSwap: buildSwapMock, BLOCKHASH_SLOTS_TO_EXPIRY: 150, JupiterBuildError: Error }));
vi.mock('./assemble-transaction', () => ({ assembleSwapTransaction: assembleSwapTransactionMock }));
vi.mock('../../observability/events', () => ({ recordEvent: recordEventMock }));
vi.mock('../db/client', () => ({ getDb: () => ({ select: selectMock, update: updateMock, transaction: transactionMock }) }));
// The leaf price *sources* are mocked so no case here makes a network call; `priceTrade`
// itself stays real, since which leg it prices is the thing under test.
vi.mock('../pricing/binance-klines', () => ({
  getSolUsdPrice: getSolUsdPriceMock,
  SOL_MINT: 'So11111111111111111111111111111111111111112',
}));
vi.mock('../pricing/birdeye-price', () => ({ getBirdeyeUsdPrice: getBirdeyeUsdPriceMock }));

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const SOL = 'So11111111111111111111111111111111111111112';
const WALLET_ADDRESS = 'BPFLoaderUpgradeab1e11111111111111111111111';

function dailyNotional(maxUsd: string): Constitution {
  return { schemaVersion: 1, limits: [{ id: 'limit-daily', type: 'daily_notional_usd', maxUsd, windowHours: 24 }] };
}

const DAILY_NOTIONAL: Constitution = dailyNotional('500');

/**
 * Each test uses a distinct amount so the module-level short-TTL quote cache never leaks
 * between them — and they stay within a base unit of each other, since the amount is now also
 * the priced sold leg ($100 of 6-decimal USDC, comfortably under `DAILY_NOTIONAL`'s $500).
 */
let amountCounter = 0;

function nextAmount(): string {
  amountCounter += 1;
  return `${100_000_000 + amountCounter}`;
}

function constitutionRow(status: string, document: Constitution = DAILY_NOTIONAL) {
  return { id: 'constitution-1', userId: 'user-1', status, document, activatedAt: new Date() };
}

/**
 * The `constitutions` lookup keeps its original one-shape mock; `tradeIntents`/`trades` — the
 * two tables `intent-lifecycle.ts`'s live-intent reservation reads — always answer empty here,
 * since no test in this file is exercising that reservation itself (`intent-lifecycle.test.ts`
 * owns that). Discriminating on the real table object `.from()` is called with, the same
 * convention `reconcile-wallet.test.ts`'s fake `tx()` uses, is what lets one shared
 * `selectMock` serve three different query shapes without every existing test having to know
 * about the two it does not care about.
 */
function selectReturns(constitutionRows: unknown[]): void {
  selectMock.mockImplementation(() => ({
    from: (table: unknown) => {
      if (table === tradeIntents || table === trades) {
        return { where: () => Promise.resolve([]) };
      }

      return { where: () => ({ limit: async () => constitutionRows }) };
    },
  }));
}

function buildResponse(overrides: Partial<JupiterBuildResponse> = {}): JupiterBuildResponse {
  return {
    inputMint: USDC,
    outputMint: BONK,
    inAmount: '100000000',
    outAmount: '900000000',
    otherAmountThreshold: '800000000',
    swapMode: 'ExactIn',
    slippageBps: 50,
    priceImpactPct: '0.001',
    routePlan: [{ swapInfo: { ammKey: 'amm', label: 'Orca', inputMint: USDC, outputMint: BONK, inAmount: '1', outAmount: '2' }, percent: 100 }],
    computeBudgetInstructions: [],
    setupInstructions: [],
    swapInstruction: { programId: USDC, accounts: [], data: '' },
    cleanupInstruction: null,
    otherInstructions: [],
    tipInstruction: null,
    addressesByLookupTableAddress: null,
    blockhashWithMetadata: { blockhash: [1, 2, 3], lastValidBlockHeight: 300_000_000, fetchedAt: { secs_since_epoch: 1_800_000_000, nanos_since_epoch: 0 } },
    ...overrides,
  };
}

/**
 * `/build` echoes the amount it was asked for — the exact-in premise `createQuote` asserts —
 * so the fixture derives `inAmount` from the request rather than pinning it independently.
 */
function buildSwapReturns(overrides: Partial<JupiterBuildResponse> = {}): void {
  buildSwapMock.mockImplementation(async ({ amount }: { amount: string }) => buildResponse({ inAmount: amount, ...overrides }));
}

function quoteParams(overrides: Record<string, unknown> = {}) {
  return {
    walletId: 'wallet-1',
    walletAddress: WALLET_ADDRESS,
    userId: 'user-1',
    inputMint: USDC,
    outputMint: BONK,
    amount: nextAmount(),
    slippageBps: 50,
    correlationId: 'correlation-1',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  selectReturns([constitutionRow('active')]);
  loadReconciliationStateMock.mockResolvedValue('current');
  classifyTokenMock.mockResolvedValue({ tier: 'MICRO_CAP', classification: 'known' });
  lookupTokenDecimalsMock.mockResolvedValue(new Map([[USDC, 6], [BONK, 5]]));
  loadWindowedTradesMock.mockResolvedValue([]);
  getSolUsdPriceMock.mockResolvedValue(null);
  getBirdeyeUsdPriceMock.mockResolvedValue(null);
  isFeatureEnabledMock.mockResolvedValue(true);
  buildSwapReturns();
  assembleSwapTransactionMock.mockResolvedValue({
    messageBase64: 'bWVzc2FnZQ==',
    txMessageHash: 'a'.repeat(64),
    computeUnitLimit: 120_000,
    blockhash: 'Blockhash1111111111111111111111111111111111',
    lastValidBlockHeight: 300_000_000,
  });
  recordEventMock.mockResolvedValue(undefined);
  // `reapExpiredIntents` (top of `createQuote`, and inside `loadLiveIntentUsd`) — no live
  // intent to reap by default in any of these tests.
  updateMock.mockReturnValue({ set: () => ({ where: () => ({ returning: async () => [] }) }) });
  transactionMock.mockImplementation(async (callback: (tx: unknown) => Promise<string>) =>
    callback({
      // `expireAndReserveLiveIntent`'s wallet-row lock — the row itself is never read.
      select: () => ({ from: () => ({ where: () => ({ for: () => ({ limit: async () => [{ id: 'wallet-1' }] }) }) }) }),
      // `expireAndReserveLiveIntent`'s guarded expire of the wallet's prior live intent — no
      // prior live intent by default, so `persistIntent` never records `trade.intent_expired`
      // unless a test overrides this.
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
      insert: () => ({
        values: (values: unknown) => {
          insertedValuesSpy(values);
          return { returning: async () => [{ id: 'intent-1' }] };
        },
      }),
    }),
  );
});

describe('foldVerdict', () => {
  it('allows only when every limit allowed', () => {
    expect(foldVerdict([{ verdict: 'allow' }, { verdict: 'allow' }] as never)).toBe('allow');
  });

  it('blocks on a single violation', () => {
    expect(foldVerdict([{ verdict: 'allow' }, { verdict: 'violation' }] as never)).toBe('block');
  });

  it('blocks on an unevaluable limit — never treats "we could not check" as "fine"', () => {
    expect(foldVerdict([{ verdict: 'allow' }, { verdict: 'unevaluable' }] as never)).toBe('block');
  });
});

describe('createQuote preconditions', () => {
  it('refuses to quote when the user has no constitution at all', async () => {
    selectReturns([]);

    await expect(createQuote(quoteParams())).rejects.toMatchObject({ reason: 'constitution_not_active' });
    expect(buildSwapMock).not.toHaveBeenCalled();
  });

  it.each(['draft', 'committing'])('refuses to quote against a %s constitution', async (status) => {
    selectReturns([constitutionRow(status)]);

    await expect(createQuote(quoteParams())).rejects.toBeInstanceOf(QuotePreconditionError);
    expect(buildSwapMock).not.toHaveBeenCalled();
  });

  it('proceeds once the constitution is active', async () => {
    const result = await createQuote(quoteParams());

    expect(result.verdict).toBe('allow');
    expect(buildSwapMock).toHaveBeenCalledOnce();
  });

  it.each(['never', 'in_progress', 'failed'])('refuses to quote when reconciliation is %s', async (state) => {
    loadReconciliationStateMock.mockResolvedValue(state);

    await expect(createQuote(quoteParams())).rejects.toMatchObject({ reason: 'not_reconciled' });
    expect(buildSwapMock).not.toHaveBeenCalled();
  });
});

describe('createQuote fold rule', () => {
  it('records an allowed quote as `quoted`, with the assembled message hash', async () => {
    const result = await createQuote(quoteParams());

    expect(result.verdict).toBe('allow');
    expect(result.transaction?.txMessageHash).toBe('a'.repeat(64));
    expect(insertedValuesSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'quoted', txMessageHash: 'a'.repeat(64) }));
  });

  it('blocks and records `blocked` when a limit is violated, and never assembles signable bytes', async () => {
    loadWindowedTradesMock.mockResolvedValue([{ occurredAt: new Date(), usdValue: '480' }]);

    const result = await createQuote(quoteParams());

    expect(result.verdict).toBe('block');
    expect(result.evaluations[0]!.verdict).toBe('violation');
    expect(result.transaction).toBeNull();
    expect(assembleSwapTransactionMock).not.toHaveBeenCalled();
    expect(insertedValuesSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'blocked', txMessageHash: null }));
  });

  it('blocks when a dependency leaves the trade unpriceable — unevaluable, never a silent allow', async () => {
    lookupTokenDecimalsMock.mockResolvedValue(new Map());

    const result = await createQuote(quoteParams());

    expect(result.verdict).toBe('block');
    expect(result.evaluations[0]).toMatchObject({ verdict: 'unevaluable', reason: 'trade_unpriced' });
    expect(insertedValuesSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'blocked', usdValue: null }));
  });

  it('blocks when the wallet’s own history contains an unpriced trade', async () => {
    loadWindowedTradesMock.mockResolvedValue([{ occurredAt: new Date(), usdValue: null }]);

    const result = await createQuote(quoteParams());

    expect(result.verdict).toBe('block');
    expect(result.evaluations[0]).toMatchObject({ verdict: 'unevaluable', reason: 'history_contains_unpriced_trade' });
  });

  it('keeps rolling_loss_usd evaluable against known window losses despite this trade’s own unknown loss', async () => {
    selectReturns([
      constitutionRow('active', { schemaVersion: 1, limits: [{ id: 'limit-loss', type: 'rolling_loss_usd', maxUsd: '200', windowHours: 168 }] }),
    ]);
    loadWindowedTradesMock.mockResolvedValue([{ occurredAt: new Date(), usdValue: '10', isRoundTripClose: true, realizedLossUsd: '-50' }]);

    const result = await createQuote(quoteParams());

    expect(result.evaluations[0]).toMatchObject({ verdict: 'allow', priorUsd: '50', totalUsd: '50' });
    expect(result.verdict).toBe('allow');
  });

  it('blocks when the loss-matching kill switch is off, rather than reporting a vacuous $0 of losses', async () => {
    selectReturns([
      constitutionRow('active', { schemaVersion: 1, limits: [{ id: 'limit-loss', type: 'rolling_loss_usd', maxUsd: '200', windowHours: 168 }] }),
    ]);
    isFeatureEnabledMock.mockResolvedValue(false);

    const result = await createQuote(quoteParams());

    expect(result.evaluations[0]).toMatchObject({ verdict: 'unevaluable', reason: 'loss_matching_disabled' });
    expect(result.verdict).toBe('block');
  });

  it('propagates a Jupiter failure rather than returning a quote with no verdict', async () => {
    buildSwapMock.mockRejectedValue(new Error('jupiter.swap_build is disabled'));

    await expect(createQuote(quoteParams())).rejects.toThrow(/jupiter.swap_build is disabled/);
    expect(insertedValuesSpy).not.toHaveBeenCalled();
  });

  it('propagates an assembly failure rather than recording an allowed intent nothing can sign', async () => {
    assembleSwapTransactionMock.mockRejectedValue(new Error('swap simulation failed'));

    await expect(createQuote(quoteParams())).rejects.toThrow(/swap simulation failed/);
    expect(insertedValuesSpy).not.toHaveBeenCalled();
  });
});

describe('createQuote exact-in premise', () => {
  it('blocks the quote when /build comes back exact-out, rather than pricing a leg that is not fixed', async () => {
    buildSwapReturns({ swapMode: 'ExactOut' });

    await expect(createQuote(quoteParams())).rejects.toThrow(/ExactIn/);
    expect(lookupTokenDecimalsMock).not.toHaveBeenCalled();
    expect(insertedValuesSpy).not.toHaveBeenCalled();
  });

  it('blocks the quote when /build returns an inAmount the request never asked for', async () => {
    buildSwapMock.mockResolvedValue(buildResponse({ inAmount: '777' }));

    await expect(createQuote(quoteParams())).rejects.toThrow(/inAmount 777/);
    expect(lookupTokenDecimalsMock).not.toHaveBeenCalled();
    expect(insertedValuesSpy).not.toHaveBeenCalled();
  });
});

describe('createQuote instrumentation', () => {
  it('writes both events inside the same transaction as the intent row', async () => {
    await createQuote(quoteParams());

    const executors = recordEventMock.mock.calls.map((call) => call[1]);
    expect(recordEventMock).toHaveBeenCalledTimes(2);
    expect(recordEventMock.mock.calls.map((call) => (call[0] as { eventType: string }).eventType)).toEqual([
      'trade.intent_created',
      'rule.pre_trade_decision',
    ]);
    expect(executors[0]).toBe(executors[1]);
    expect(executors[0]).toBeDefined();
  });

  it('carries the verdict and the evaluations that produced it on the decision event', async () => {
    loadWindowedTradesMock.mockResolvedValue([{ occurredAt: new Date(), usdValue: '480' }]);

    await createQuote(quoteParams());

    const decisionEvent = recordEventMock.mock.calls[1]![0] as { payload: { verdict: string; evaluations: unknown[] } };
    expect(decisionEvent.payload.verdict).toBe('block');
    expect(decisionEvent.payload.evaluations).toHaveLength(1);
  });
});

describe('createQuote slippage-safe pricing', () => {
  it('prices an acquisition off the exact sold leg, regardless of what outAmount claims', async () => {
    buildSwapReturns({ outAmount: '999999999999', otherAmountThreshold: '1' });

    const result = await createQuote(quoteParams({ amount: '250000000' }));

    // 250000000 base units of 6-decimal USDC = $250 — untouched by the optimistic outAmount.
    expect(result.quote.usdValue).toBe('250.000000');
  });

  it('prices a sale off the exact sold leg too, never the stable leg’s slippage-shrinkable threshold', async () => {
    buildSwapReturns({ inputMint: BONK, outputMint: USDC, outAmount: '400000000', otherAmountThreshold: '300000000' });
    lookupTokenDecimalsMock.mockResolvedValue(new Map([[BONK, 5], [USDC, 6]]));
    getBirdeyeUsdPriceMock.mockResolvedValue('0.000002');

    const result = await createQuote(quoteParams({ inputMint: BONK, outputMint: USDC, amount: '5000000' }));

    // 5000000 base units of 5-decimal BONK = 50 BONK at $0.000002. The $300 guaranteed-minimum
    // proceeds are the *floor*-limit figure; a ceiling limit must never be denominated in a
    // number the request's own slippage can shrink.
    expect(result.quote.usdValue).toBe('0.00010000000');
    expect(getBirdeyeUsdPriceMock).toHaveBeenCalledWith(BONK, expect.any(Date));
  });

  it('blocks rather than falling back to the stable bought leg when the sold leg has no price', async () => {
    buildSwapReturns({ inputMint: BONK, outputMint: USDC, outAmount: '400000000', otherAmountThreshold: '300000000' });
    lookupTokenDecimalsMock.mockResolvedValue(new Map([[BONK, 5], [USDC, 6]]));

    const result = await createQuote(quoteParams({ inputMint: BONK, outputMint: USDC }));

    expect(result.quote.usdValue).toBeNull();
    expect(result.verdict).toBe('block');
  });

  /**
   * The bypass this rule exists to close: SOL→USDC is the dominant path in the terminal, and
   * pricing it off `otherAmountThreshold` let a scripted POST discount its own recorded
   * notional by whatever slippage it asked for.
   */
  it('records a SOL→USDC quote at wide slippage off the exact sold SOL, and still blocks', async () => {
    selectReturns([constitutionRow('active', dailyNotional('145'))]);
    buildSwapReturns({ inputMint: SOL, outputMint: USDC, outAmount: '150000000', otherAmountThreshold: '142500000', slippageBps: 500 });
    lookupTokenDecimalsMock.mockResolvedValue(new Map([[SOL, 9], [USDC, 6]]));
    getSolUsdPriceMock.mockResolvedValue('150');

    const result = await createQuote(quoteParams({ inputMint: SOL, outputMint: USDC, slippageBps: 500, amount: '1000000000' }));

    // 1 SOL at $150. Priced off the threshold this reads as $142.50, slips under the $145
    // limit, and the trade the user forbade themselves goes through.
    expect(result.quote.usdValue).toBe('150.000000000');
    expect(result.verdict).toBe('block');
    expect(insertedValuesSpy).toHaveBeenCalledWith(expect.objectContaining({ usdValue: '150.000000000', status: 'blocked' }));
  });

  it('writes the same figure to the intent row that the limits were evaluated against', async () => {
    const result = await createQuote(quoteParams());

    expect(insertedValuesSpy).toHaveBeenCalledWith(expect.objectContaining({ usdValue: result.quote.usdValue }));
  });
});

describe('createQuote caching', () => {
  it('reuses a fresh build for the same wallet, pair, amount and slippage', async () => {
    const params = quoteParams();

    await createQuote(params);
    await createQuote({ ...params });

    expect(buildSwapMock).toHaveBeenCalledTimes(1);
  });

  it('never serves one wallet’s assembled quote to another wallet', async () => {
    const params = quoteParams();

    await createQuote(params);
    await createQuote({ ...params, walletId: 'wallet-2', walletAddress: 'SysvarRent111111111111111111111111111111111' });

    expect(buildSwapMock).toHaveBeenCalledTimes(2);
  });
});
