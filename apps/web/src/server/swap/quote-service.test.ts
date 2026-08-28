import type { Constitution } from '@degencage/rules';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  transactionMock,
  insertedValuesSpy,
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
  transactionMock: vi.fn(),
  insertedValuesSpy: vi.fn(),
}));

vi.mock('../dashboard/dashboard-state', () => ({ loadReconciliationState: loadReconciliationStateMock }));
vi.mock('../chain/classify-token', () => ({ classifyToken: classifyTokenMock }));
vi.mock('../chain/jupiter-tokens', () => ({ lookupTokenDecimals: lookupTokenDecimalsMock }));
vi.mock('../chain/reconcile-wallet', () => ({ LOSS_LIMIT_ENABLED_FLAG: 'rules.loss_limit_enabled' }));
vi.mock('../rules/rolling-allowance', () => ({ loadWindowedTrades: loadWindowedTradesMock }));
vi.mock('../flags/feature-flags', () => ({ isFeatureEnabled: isFeatureEnabledMock }));
vi.mock('./jupiter-client', () => ({ buildSwap: buildSwapMock, BLOCKHASH_SLOTS_TO_EXPIRY: 150 }));
vi.mock('./assemble-transaction', () => ({ assembleSwapTransaction: assembleSwapTransactionMock }));
vi.mock('../../observability/events', () => ({ recordEvent: recordEventMock }));
vi.mock('../db/client', () => ({ getDb: () => ({ select: selectMock, transaction: transactionMock }) }));

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const WALLET_ADDRESS = 'BPFLoaderUpgradeab1e11111111111111111111111';

const DAILY_NOTIONAL: Constitution = {
  schemaVersion: 1,
  limits: [{ id: 'limit-daily', type: 'daily_notional_usd', maxUsd: '500', windowHours: 24 }],
};

/** Each test uses a distinct amount so the module-level short-TTL quote cache never leaks between them. */
let amountCounter = 0;

function nextAmount(): string {
  amountCounter += 1;
  return `${amountCounter}00000000`;
}

function constitutionRow(status: string, document: Constitution = DAILY_NOTIONAL) {
  return { id: 'constitution-1', userId: 'user-1', status, document, activatedAt: new Date() };
}

function selectReturns(rows: unknown[]): void {
  selectMock.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => rows }) }) });
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
  isFeatureEnabledMock.mockResolvedValue(true);
  buildSwapMock.mockResolvedValue(buildResponse());
  assembleSwapTransactionMock.mockResolvedValue({
    messageBase64: 'bWVzc2FnZQ==',
    txMessageHash: 'a'.repeat(64),
    computeUnitLimit: 120_000,
    blockhash: 'Blockhash1111111111111111111111111111111111',
    lastValidBlockHeight: 300_000_000,
  });
  recordEventMock.mockResolvedValue(undefined);
  transactionMock.mockImplementation(async (callback: (tx: unknown) => Promise<string>) =>
    callback({
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
    buildSwapMock.mockResolvedValue(buildResponse({ inAmount: '250000000', outAmount: '999999999999', otherAmountThreshold: '1' }));

    const result = await createQuote(quoteParams());

    // 250000000 base units of 6-decimal USDC = $250 — untouched by the optimistic outAmount.
    expect(result.quote.usdValue).toBe('250.000000');
  });

  it('prices the bought leg off otherAmountThreshold, never the optimistic outAmount', async () => {
    buildSwapMock.mockResolvedValue(
      buildResponse({ inputMint: BONK, outputMint: USDC, inAmount: '5000000', outAmount: '400000000', otherAmountThreshold: '300000000' }),
    );
    lookupTokenDecimalsMock.mockResolvedValue(new Map([[BONK, 5], [USDC, 6]]));

    const result = await createQuote(quoteParams({ inputMint: BONK, outputMint: USDC }));

    // The guaranteed minimum (300000000 base units of 6-decimal USDC = $300) is the worst-case
    // proceeds — never the $400 the aggregator optimistically quoted.
    expect(result.quote.usdValue).toBe('300.000000');
  });

  it('writes the same figure to the intent row that the limits were evaluated against', async () => {
    buildSwapMock.mockResolvedValue(buildResponse({ inAmount: '250000000' }));

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
