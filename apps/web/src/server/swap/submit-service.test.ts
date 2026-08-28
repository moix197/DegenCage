import { createHash } from 'node:crypto';

import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { constitutions } from '../db/schema';
import { submitSignedSwap, SubmitRejectedError } from './submit-service';

/**
 * The submit gate, exercised against **real compiled transaction bytes** rather than a string
 * standing in for them. That is deliberate: the single most dangerous mistake available in this
 * file is hashing the signed transaction instead of the message extracted from it, and a
 * fixture of `'signed-bytes'` would let that bug pass every test here.
 *
 * The database is faked at the drizzle-chain level, and the guarded `UPDATE`'s *outcome* — a
 * row or zero rows — is what each case programs. That is exactly the contract
 * `.ai/patterns/guarded-state-transition.md` describes: the caller may only branch on whether a
 * row came back, so a fake that can return either is a faithful stand-in. The WHERE clause's
 * own contents are asserted separately, by reading back the parameters it was built with.
 */

const { getDbMock, updateMock, selectMock, recordEventMock, broadcastMock, loadWindowedTradesMock, isFeatureEnabledMock } = vi.hoisted(() => {
  const updateMock = vi.fn();
  const selectMock = vi.fn();

  return {
    updateMock,
    selectMock,
    recordEventMock: vi.fn(),
    broadcastMock: vi.fn(),
    loadWindowedTradesMock: vi.fn(),
    isFeatureEnabledMock: vi.fn(),
    getDbMock: () => ({
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: (condition: unknown) => ({ returning: async () => updateMock(values, collectParams(condition)) }),
        }),
      }),
      select: () => ({ from: (table: unknown) => ({ where: () => ({ limit: async () => selectMock(table) }) }) }),
    }),
  };
});

/** Pulls the bound parameter values out of a drizzle condition tree, so a WHERE clause can be asserted on. */
function collectParams(node: unknown, out: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') {
    return out;
  }

  const candidate = node as { value?: unknown; queryChunks?: unknown[] };

  if (typeof candidate.value === 'string' || typeof candidate.value === 'number') {
    out.push(candidate.value);
  }

  if (Array.isArray(node)) {
    node.forEach((child) => collectParams(child, out));
  }

  if (Array.isArray(candidate.queryChunks)) {
    candidate.queryChunks.forEach((child) => collectParams(child, out));
  }

  return out;
}

vi.mock('../db/client', () => ({ getDb: getDbMock }));
vi.mock('../../observability/events', () => ({ recordEvent: recordEventMock }));
vi.mock('../chain/broadcast-transaction', () => ({ broadcastSignedTransaction: broadcastMock, CHAIN_BROADCAST_FLAG: 'chain.broadcast' }));
vi.mock('../rules/rolling-allowance', () => ({ loadWindowedTrades: loadWindowedTradesMock }));
vi.mock('../flags/feature-flags', () => ({ isFeatureEnabled: isFeatureEnabledMock }));

const WALLET_ADDRESS = 'BPFLoaderUpgradeab1e11111111111111111111111';
const OTHER_ADDRESS = 'So11111111111111111111111111111111111111112';
const INTENT_ID = '11111111-2222-3333-4444-555555555555';

const CONSTITUTION = {
  id: 'constitution-1',
  userId: 'user-1',
  status: 'active',
  document: { schemaVersion: 1, limits: [{ id: 'limit-daily', type: 'daily_notional_usd', maxUsd: '500', windowHours: 24 }] },
  activatedAt: new Date(),
};

/** A real v0 message, compiled the same way `assemble-transaction.ts` compiles the one the user signs. */
function compileMessageFor(feePayer: string) {
  const instruction = {
    programAddress: address('ComputeBudget111111111111111111111111111111'),
    accounts: [{ address: address(OTHER_ADDRESS), role: AccountRole.READONLY }],
    data: new Uint8Array([2, 64, 66, 15, 0]),
  };

  return pipe(
    createTransactionMessage({ version: 0 }),
    (message) => appendTransactionMessageInstructions([instruction], message),
    (message) => setTransactionMessageFeePayer(address(feePayer), message),
    (message) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: '11111111111111111111111111111111' as never, lastValidBlockHeight: 300n }, message),
    (message) => compileTransaction(message),
  );
}

function sha256Hex(bytes: ArrayLike<number>): string {
  return createHash('sha256').update(Buffer.from(Uint8Array.from(bytes))).digest('hex');
}

interface SignedFixture {
  signedTransactionBase64: string;
  messageHash: string;
  wholeTransactionHash: string;
  signature: string;
}

/** Compiles, then signs with a deterministic 64-byte signature — the wallet's half of the flow. */
function signFixture(feePayer = WALLET_ADDRESS, signatureByte = 7): SignedFixture {
  const compiled = compileMessageFor(feePayer);
  const signatureBytes = new Uint8Array(64).fill(signatureByte);
  const signed = { ...compiled, signatures: { [feePayer]: signatureBytes } } as unknown as typeof compiled;
  const signedTransactionBase64 = getBase64EncodedWireTransaction(signed);

  return {
    signedTransactionBase64,
    messageHash: sha256Hex(compiled.messageBytes),
    wholeTransactionHash: sha256Hex(Uint8Array.from(Buffer.from(signedTransactionBase64, 'base64'))),
    signature: getBase58Decoder().decode(signatureBytes),
  };
}

const FIXTURE = signFixture();

function intentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INTENT_ID,
    walletId: 'wallet-1',
    constitutionId: CONSTITUTION.id,
    status: 'quoted',
    inputMint: OTHER_ADDRESS,
    outputMint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    inAmount: '100000000',
    outAmount: '900000000',
    usdValue: '100',
    acquiredTier: 'MICRO_CAP',
    evaluations: [],
    quoteResponse: {},
    txMessageHash: FIXTURE.messageHash,
    signature: null,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    ...overrides,
  };
}

function submitParams(overrides: Record<string, unknown> = {}) {
  return {
    intentId: INTENT_ID,
    signedTransactionBase64: FIXTURE.signedTransactionBase64,
    walletId: 'wallet-1',
    walletAddress: WALLET_ADDRESS,
    userId: 'user-1',
    correlationId: 'correlation-1',
    ...overrides,
  };
}

/** Programs the guarded `→ signed` UPDATE to match (a row) or not (zero rows). */
function signTransitionReturns(rows: unknown[]): void {
  updateMock.mockImplementation((values: { status: string }) => {
    if (values.status === 'signed') {
      return rows;
    }

    return [intentRow({ status: values.status })];
  });
}

function eventTypes(): string[] {
  return recordEventMock.mock.calls.map(([event]) => (event as { eventType: string }).eventType);
}

beforeEach(() => {
  vi.clearAllMocks();
  signTransitionReturns([intentRow({ status: 'signed', signature: FIXTURE.signature })]);
  selectMock.mockImplementation((table: unknown) => (table === constitutions ? [CONSTITUTION] : [intentRow()]));
  recordEventMock.mockResolvedValue(undefined);
  broadcastMock.mockResolvedValue({ dryRun: true, networkSignature: null, logs: [] });
  loadWindowedTradesMock.mockResolvedValue([]);
  isFeatureEnabledMock.mockResolvedValue(true);
});

describe('submitSignedSwap message verification', () => {
  it('hashes the message extracted from the signed bytes, never the signed transaction as a whole', async () => {
    await submitSignedSwap(submitParams());

    const [, whereParams] = updateMock.mock.calls[0]!;
    expect(whereParams).toContain(FIXTURE.messageHash);
    // The distinction the whole verification stands on: signature bytes vary per signing, so a
    // hash over the whole transaction could never match one taken before a signature existed.
    expect(whereParams).not.toContain(FIXTURE.wholeTransactionHash);
    expect(FIXTURE.messageHash).not.toBe(FIXTURE.wholeTransactionHash);
  });

  it('carries the intent id, the session wallet and the hash into the guarded UPDATE — not a later if-statement', async () => {
    await submitSignedSwap(submitParams());

    const [values, whereParams] = updateMock.mock.calls[0]!;
    expect(values).toEqual({ status: 'signed', signature: FIXTURE.signature });
    expect(whereParams).toEqual(expect.arrayContaining([INTENT_ID, 'wallet-1', 'quoted', 'approved', FIXTURE.messageHash]));
  });

  it('rejects a fee payer that is not the session wallet, even when the hash matches', async () => {
    const foreign = signFixture(OTHER_ADDRESS);
    selectMock.mockImplementation((table: unknown) =>
      table === constitutions ? [CONSTITUTION] : [intentRow({ txMessageHash: foreign.messageHash })],
    );

    await expect(submitSignedSwap(submitParams({ signedTransactionBase64: foreign.signedTransactionBase64 }))).rejects.toMatchObject({
      reason: 'fee_payer_mismatch',
    });
    // Rejected before the intent is touched at all: this check is independent of the hash.
    expect(updateMock).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
    expect(eventTypes()).toEqual(['trade.intent_failed']);
  });

  it('rejects bytes that are not a transaction at all', async () => {
    await expect(submitSignedSwap(submitParams({ signedTransactionBase64: 'bm90LWEtdHJhbnNhY3Rpb24=' }))).rejects.toMatchObject({
      reason: 'malformed_transaction',
    });
    expect(updateMock).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('rejects a transaction the wallet handed back unsigned', async () => {
    const compiled = compileMessageFor(WALLET_ADDRESS);
    const unsigned = getBase64EncodedWireTransaction(compiled);

    await expect(submitSignedSwap(submitParams({ signedTransactionBase64: unsigned }))).rejects.toMatchObject({ reason: 'missing_signature' });
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('submitSignedSwap guarded transitions', () => {
  it('verifies, dry-runs and records both events on the happy path', async () => {
    const result = await submitSignedSwap(submitParams());

    expect(result).toEqual({ intentId: INTENT_ID, status: 'submitted', signature: FIXTURE.signature, dryRun: true, replayed: false });
    expect(broadcastMock).toHaveBeenCalledWith(FIXTURE.signedTransactionBase64);
    expect(eventTypes()).toEqual(['trade.intent_signed', 'trade.intent_submitted']);
  });

  it('rejects an intent whose status is no longer signable — zero rows, then a re-read that says why', async () => {
    signTransitionReturns([]);
    selectMock.mockImplementation((table: unknown) => (table === constitutions ? [CONSTITUTION] : [intentRow({ status: 'blocked' })]));

    await expect(submitSignedSwap(submitParams())).rejects.toMatchObject({ reason: 'intent_not_signable' });
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('rejects an expired intent', async () => {
    signTransitionReturns([]);
    selectMock.mockImplementation((table: unknown) =>
      table === constitutions ? [CONSTITUTION] : [intentRow({ expiresAt: new Date(Date.now() - 1_000) })],
    );

    await expect(submitSignedSwap(submitParams())).rejects.toMatchObject({ reason: 'intent_expired' });
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('rejects a hash mismatch and changes no state', async () => {
    signTransitionReturns([]);
    selectMock.mockImplementation((table: unknown) => (table === constitutions ? [CONSTITUTION] : [intentRow({ txMessageHash: 'f'.repeat(64) })]));

    await expect(submitSignedSwap(submitParams())).rejects.toMatchObject({ reason: 'message_hash_mismatch' });
    // One attempted transition, which matched nothing — and no second UPDATE moving the row anywhere.
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(broadcastMock).not.toHaveBeenCalled();
    expect(eventTypes()).toEqual(['trade.intent_failed']);
  });

  it('rejects an intent that belongs to another wallet', async () => {
    signTransitionReturns([]);
    selectMock.mockImplementation((table: unknown) => (table === constitutions ? [CONSTITUTION] : [intentRow({ walletId: 'wallet-2' })]));

    await expect(submitSignedSwap(submitParams())).rejects.toMatchObject({ reason: 'wallet_mismatch' });
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('rejects an intent that does not exist', async () => {
    signTransitionReturns([]);
    selectMock.mockImplementation((table: unknown) => (table === constitutions ? [CONSTITUTION] : []));

    await expect(submitSignedSwap(submitParams())).rejects.toMatchObject({ reason: 'intent_not_found' });
  });
});

describe('submitSignedSwap idempotency', () => {
  it('answers a double submit with the original result, records nothing, and re-transitions nothing', async () => {
    const first = await submitSignedSwap(submitParams());
    expect(first.replayed).toBe(false);
    expect(eventTypes()).toEqual(['trade.intent_signed', 'trade.intent_submitted']);

    // The second call reaches a row that is no longer signable — exactly what the guard's WHERE
    // produces on a retry, a double-click or a replayed request.
    recordEventMock.mockClear();
    updateMock.mockClear();
    broadcastMock.mockClear();
    signTransitionReturns([]);
    selectMock.mockImplementation((table: unknown) =>
      table === constitutions ? [CONSTITUTION] : [intentRow({ status: 'submitted', signature: FIXTURE.signature })],
    );

    const second = await submitSignedSwap(submitParams());

    expect(second).toEqual({ intentId: INTENT_ID, status: 'submitted', signature: FIXTURE.signature, dryRun: false, replayed: true });
    expect(eventTypes()).toEqual([]);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it.each(['signed', 'submitted', 'confirmed'])('treats a replay against an already-%s intent as a no-op', async (status) => {
    signTransitionReturns([]);
    selectMock.mockImplementation((table: unknown) => (table === constitutions ? [CONSTITUTION] : [intentRow({ status, signature: FIXTURE.signature })]));

    const result = await submitSignedSwap(submitParams());

    expect(result).toMatchObject({ status, replayed: true, signature: FIXTURE.signature });
    expect(eventTypes()).toEqual([]);
  });

  it('does not re-record a submit that another caller completed while this one was verifying', async () => {
    updateMock.mockImplementation((values: { status: string }) => {
      if (values.status === 'signed') return [intentRow({ status: 'signed' })];
      // The `signed → submitted` guard matches nothing: someone else already moved the row.
      return [];
    });

    const result = await submitSignedSwap(submitParams());

    expect(result.replayed).toBe(true);
    expect(eventTypes()).toEqual(['trade.intent_signed']);
  });
});

describe('submitSignedSwap re-evaluation', () => {
  it('blocks a trade whose allowance was spent between the quote and the signature', async () => {
    loadWindowedTradesMock.mockResolvedValue([{ occurredAt: new Date(), usdValue: '450', isAcquisition: true, acquiredTier: 'MICRO_CAP' }]);

    await expect(submitSignedSwap(submitParams())).rejects.toMatchObject({ reason: 'rules_now_block' });

    expect(broadcastMock).not.toHaveBeenCalled();
    expect(updateMock).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed' }), expect.anything());
    expect(eventTypes()).toEqual(['trade.intent_signed', 'trade.intent_failed']);
  });

  it('blocks when the constitution is no longer active', async () => {
    selectMock.mockImplementation((table: unknown) => (table === constitutions ? [{ ...CONSTITUTION, status: 'draft' }] : [intentRow()]));

    await expect(submitSignedSwap(submitParams())).rejects.toMatchObject({ reason: 'constitution_not_active' });
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('blocks when the active constitution is not the one the intent was evaluated against', async () => {
    selectMock.mockImplementation((table: unknown) => (table === constitutions ? [{ ...CONSTITUTION, id: 'constitution-2' }] : [intentRow()]));

    await expect(submitSignedSwap(submitParams())).rejects.toMatchObject({ reason: 'constitution_changed' });
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('blocks when the user has no constitution row at all', async () => {
    selectMock.mockImplementation((table: unknown) => (table === constitutions ? [] : [intentRow()]));

    await expect(submitSignedSwap(submitParams())).rejects.toMatchObject({ reason: 'constitution_not_active' });
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('re-evaluates before broadcasting, never after', async () => {
    const order: string[] = [];
    loadWindowedTradesMock.mockImplementation(async () => {
      order.push('reevaluate');
      return [];
    });
    broadcastMock.mockImplementation(async () => {
      order.push('broadcast');
      return { dryRun: true, networkSignature: null, logs: [] };
    });

    await submitSignedSwap(submitParams());

    expect(order).toEqual(['reevaluate', 'broadcast']);
  });
});

describe('submitSignedSwap broadcast failure', () => {
  it('fails the intent and reports it rather than claiming a submission', async () => {
    broadcastMock.mockRejectedValue(new Error('signed transaction failed simulation'));

    await expect(submitSignedSwap(submitParams())).rejects.toBeInstanceOf(SubmitRejectedError);
    expect(updateMock).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed' }), expect.anything());
    expect(eventTypes()).toEqual(['trade.intent_signed', 'trade.intent_failed']);
  });
});
