import { createHash } from 'node:crypto';

import { evaluateTrade, migrateConstitution, type Constitution } from '@degencage/rules';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { getBase58Decoder, getCompiledTransactionMessageDecoder, getTransactionDecoder, type Address } from '@solana/kit';

import { recordEvent } from '../../observability/events';
import { broadcastSignedTransaction, type BroadcastResult } from '../chain/broadcast-transaction';
import { LOSS_LIMIT_ENABLED_FLAG } from '../chain/reconcile-wallet';
import { getDb } from '../db/client';
import { constitutions, events, tradeIntents, type TradeIntentRow, type TradeIntentStatus } from '../db/schema';
import { isFeatureEnabled } from '../flags/feature-flags';
import { loadEvaluableWindowedTrades } from './intent-lifecycle';
import { foldVerdict } from './quote-service';

/**
 * The submit gate: the server decides, a second time and against the *signed* bytes, whether
 * the trade it approved is still the trade in front of it.
 *
 * Three checks that are deliberately independent of each other, because each one covers a
 * failure the others cannot see:
 *
 *  1. **`intent.wallet_id == session.walletId`** — the row belongs to the caller (decision 13).
 *  2. **The hash of the message extracted from the signed bytes matches `tx_message_hash`** —
 *     the bytes are the ones we compiled, not something the browser composed. The message is
 *     *extracted*, never the whole signed transaction hashed: signature bytes vary per signing,
 *     so hashing the transaction could never match a hash taken before a signature existed.
 *  3. **The compiled message's fee payer is the session wallet's address** — read out of the
 *     message itself rather than inferred from (1) or (2). A hash match proves the bytes are
 *     ours; it does not, on its own, prove they are *this* session's, and the fee payer is the
 *     account the transaction actually spends from.
 *
 * Every state change is one guarded `UPDATE ... WHERE <precondition> RETURNING *`
 * (`.ai/patterns/guarded-state-transition.md`) — never a read, a decision, then a write by id.
 * A double-click, a retry and a network replay all reach here, and a check-then-act would let
 * two of them both believe they were the first.
 *
 * Fail closed throughout: a failed re-evaluation, a failed simulation, a missing constitution
 * or an unreadable transaction all end in "not broadcast". There is no degraded path that
 * sends bytes we could not fully verify.
 */

/**
 * The statuses an intent can be signed *from*. `quoted` is what `quote-service.ts` writes for
 * an allowed quote; `approved` exists in the schema for a later explicit-approval step and is
 * accepted here so introducing one is not a breaking change. Every other status — `blocked`,
 * `signed`, `submitted`, `confirmed`, `failed`, `expired` — is excluded by the guard, which is
 * what makes a second submit fall through to the replay check instead of transitioning again.
 */
const SIGNABLE_STATUSES = ['quoted', 'approved'] as const satisfies readonly TradeIntentStatus[];

/** Statuses that mean this intent's submit already succeeded once — the idempotent-replay set. */
const ALREADY_SUBMITTED_STATUSES: readonly TradeIntentStatus[] = ['signed', 'submitted', 'confirmed'];

/** Written on a completed submit and read back on a replay — one constant so the two cannot drift apart. */
const SUBMITTED_EVENT_TYPE = 'trade.intent_submitted';

/** Same fallback window as `quote-service.ts` — enough history for any limit the constitution carries. */
const DEFAULT_WINDOW_HOURS = 24;

export type SubmitRejectionReason =
  | 'intent_not_found'
  | 'wallet_mismatch'
  | 'intent_expired'
  | 'intent_not_signable'
  | 'malformed_transaction'
  | 'message_hash_mismatch'
  | 'fee_payer_mismatch'
  | 'missing_signature'
  | 'constitution_not_active'
  | 'constitution_changed'
  | 'rules_now_block'
  | 'broadcast_failed';

/** A refusal to submit. Every one of these means nothing was broadcast. */
export class SubmitRejectedError extends Error {
  constructor(
    readonly reason: SubmitRejectionReason,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = 'SubmitRejectedError';
  }
}

export interface SubmitRequestParams {
  intentId: string;
  /** The wallet's signed transaction, base64 wire format — signature(s) followed by the compiled message. */
  signedTransactionBase64: string;
  walletId: string;
  walletAddress: string;
  userId: string;
  correlationId: string;
}

export interface SubmitResult {
  intentId: string;
  status: TradeIntentStatus;
  /** The transaction signature, base58 — recorded before anything is broadcast. */
  signature: string;
  /**
   * `true` when the bytes were verified by simulation instead of sent — what *this intent's*
   * submit actually did, never what `chain.broadcast` happens to say now. `null` only on a
   * replay of a submit that has not recorded an outcome yet (see `loadOriginalSubmitDryRun`).
   */
  dryRun: boolean | null;
  /** `true` when this call found the work already done and changed nothing (no events recorded). */
  replayed: boolean;
}

interface PresentedTransaction {
  messageHash: string;
  /** The message's fee payer / first required signer, read out of the compiled message itself. */
  feePayer: string;
  /** The fee payer's signature, base58 — Solana's canonical transaction signature. */
  signature: string;
}

/**
 * Pulls apart the bytes the wallet handed back: the compiled message (with the signature(s)
 * the wallet prepended stripped off), its hash, its fee payer, and the fee payer's signature.
 *
 * This is the step the whole verification stands on. `getTransactionDecoder` splits the wire
 * format into `messageBytes` + a signature map, so `messageBytes` here is byte-identical to
 * what `assemble-transaction.ts` compiled and hashed — which is exactly why the hash is taken
 * over *this* and never over the signed transaction as a whole.
 */
function readPresentedTransaction(signedTransactionBase64: string): PresentedTransaction {
  let messageHash: string;
  let feePayer: Address;
  let signatureBytes: Uint8Array | null;

  try {
    const decoded = getTransactionDecoder().decode(Buffer.from(signedTransactionBase64, 'base64'));
    const message = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes);

    if (message.header.numSignerAccounts < 1 || message.staticAccounts.length < 1) {
      throw new Error('compiled message declares no required signer');
    }

    messageHash = createHash('sha256').update(Buffer.from(decoded.messageBytes)).digest('hex');
    feePayer = message.staticAccounts[0]!;
    signatureBytes = decoded.signatures[feePayer] ?? null;
  } catch (error) {
    throw new SubmitRejectedError('malformed_transaction', `signed transaction could not be decoded: ${String(error)}`);
  }

  if (!signatureBytes) {
    throw new SubmitRejectedError('missing_signature', 'the signed transaction carries no signature for its fee payer');
  }

  return { messageHash, feePayer, signature: getBase58Decoder().decode(signatureBytes) };
}

/**
 * The guarded `quoted|approved → signed` transition.
 *
 * Every precondition rides in the WHERE — ownership, status, expiry against the *database's*
 * clock, and the compiled-message hash — so a row coming back means all of them held at the
 * instant of the write. Zero rows means one of them did not, and the caller re-reads to find
 * out which (`.ai/patterns/guarded-state-transition.md`: zero rows is not automatically an
 * error). The signature is recorded here, before anything is broadcast, so a crash after a
 * real send still leaves the audit trail able to find the transaction.
 */
async function transitionToSigned(params: SubmitRequestParams, presented: PresentedTransaction): Promise<TradeIntentRow | undefined> {
  const rows = await getDb()
    .update(tradeIntents)
    .set({ status: 'signed', signature: presented.signature })
    .where(
      and(
        eq(tradeIntents.id, params.intentId),
        eq(tradeIntents.walletId, params.walletId),
        inArray(tradeIntents.status, [...SIGNABLE_STATUSES]),
        gt(tradeIntents.expiresAt, sql`now()`),
        eq(tradeIntents.txMessageHash, presented.messageHash),
      ),
    )
    .returning();

  return rows[0];
}

async function transitionFromSigned(intentId: string, next: 'submitted' | 'failed'): Promise<TradeIntentRow | undefined> {
  const rows = await getDb()
    .update(tradeIntents)
    .set({ status: next })
    .where(and(eq(tradeIntents.id, intentId), eq(tradeIntents.status, 'signed')))
    .returning();

  return rows[0];
}

async function loadIntent(intentId: string): Promise<TradeIntentRow | undefined> {
  const rows = await getDb().select().from(tradeIntents).where(eq(tradeIntents.id, intentId)).limit(1);

  return rows[0];
}

async function recordFailure(params: SubmitRequestParams, reason: SubmitRejectionReason, stage: string): Promise<void> {
  await recordEvent({
    eventType: 'trade.intent_failed',
    occurredAt: new Date(),
    correlationId: params.correlationId,
    userId: params.userId,
    payload: { intentId: params.intentId, reason, stage, walletId: params.walletId },
  });
}

/**
 * What the *original* submit did, read back from the event it recorded rather than from
 * `chain.broadcast` as it stands now.
 *
 * The flag is a fact about the present, not about the submit being replayed. Once Phase 6
 * turns it on, re-reading it here would answer the replay of a genuinely broadcast trade with
 * "verified, not broadcast" — telling a user no funds moved when they did. The audit trail is
 * the only record of which of the two actually happened, so it is the one that answers.
 *
 * `null` is a third answer, not a dry run: no completed submit has been recorded for this
 * intent yet, which is what a concurrent submit still mid-broadcast looks like from here.
 *
 * Keyed on `userId` first so the existing `events_user_id_event_type_occurred_at_idx` covers
 * the lookup, with the intent id matched in SQL — the same shape as `admin/login-rate-limit.ts`'s
 * payload predicate, not a scan filtered in JS.
 */
async function loadOriginalSubmitDryRun(params: SubmitRequestParams): Promise<boolean | null> {
  const rows = await getDb()
    .select({ payload: events.payload })
    .from(events)
    .where(and(eq(events.userId, params.userId), eq(events.eventType, SUBMITTED_EVENT_TYPE), sql`${events.payload}->>'intentId' = ${params.intentId}`))
    .limit(1);

  const recorded = rows[0]?.payload.dryRun;

  return typeof recorded === 'boolean' ? recorded : null;
}

/**
 * Why did the guarded `UPDATE` match nothing?
 *
 * The distinction matters more than it looks. An intent already `signed`/`submitted`/
 * `confirmed` whose recorded `tx_message_hash` matches the bytes in hand is the *same* submit
 * arriving twice — a retry, a double-click, a replayed request — and answering it with the
 * original result is correct behaviour, not leniency. Answering it with an error would tell a
 * user their trade failed when it did not, and would litter the audit trail with a failure
 * that never happened. Everything else is a genuine rejection.
 */
async function resolveZeroRowOutcome(params: SubmitRequestParams, presented: PresentedTransaction): Promise<SubmitResult> {
  const intent = await loadIntent(params.intentId);

  if (!intent) {
    throw new SubmitRejectedError('intent_not_found');
  }

  if (intent.walletId !== params.walletId) {
    throw new SubmitRejectedError('wallet_mismatch');
  }

  if (intent.txMessageHash !== presented.messageHash) {
    throw new SubmitRejectedError('message_hash_mismatch');
  }

  if (ALREADY_SUBMITTED_STATUSES.includes(intent.status)) {
    // No new events, no new transition: this call did nothing, and the audit trail should say
    // exactly that by staying silent.
    return {
      intentId: intent.id,
      status: intent.status,
      signature: intent.signature ?? presented.signature,
      dryRun: await loadOriginalSubmitDryRun(params),
      replayed: true,
    };
  }

  if (intent.expiresAt.getTime() <= Date.now()) {
    throw new SubmitRejectedError('intent_expired');
  }

  throw new SubmitRejectedError('intent_not_signable', `intent status is '${intent.status}'`);
}

function maxWindowHours(constitution: Constitution): number {
  return constitution.limits.reduce((max, limit) => Math.max(max, limit.windowHours), DEFAULT_WINDOW_HOURS);
}

/**
 * Re-runs the rule engine against *fresh* state before anything is broadcast.
 *
 * The quote's own numbers (`usd_value`, `acquired_tier`) are reused rather than re-priced —
 * they are what the user was shown and what the intent reserves — but the history they are
 * measured against is read again now. Between the quote and the signature the user may have
 * traded elsewhere, and an allowance that was there a minute ago may not be. The constitution
 * must also still be the same active document: a different one means the intent was evaluated
 * against rules that are no longer in force, which fails closed rather than being re-judged.
 *
 * The windowed history is decision 3's same persisted-trades-UNION-live-intents allowance
 * `quote-service.ts` evaluates against, via the shared `loadEvaluableWindowedTrades` —
 * with `intent.id` excluded. By the time this intent reaches `signed` it is, by construction,
 * the wallet's only live row (the partial unique index on `trade_intents` guarantees at most
 * one), so without the exclusion it would always find itself already reserving its own
 * notional and self-block a signed, legitimate trade (the hazard the Phase 3 code review
 * flagged).
 */
async function reevaluate(intent: TradeIntentRow, userId: string, correlationId: string): Promise<void> {
  const rows = await getDb().select().from(constitutions).where(eq(constitutions.userId, userId)).limit(1);
  const row = rows[0];

  if (!row || row.status !== 'active') {
    throw new SubmitRejectedError('constitution_not_active');
  }

  if (row.id !== intent.constitutionId) {
    throw new SubmitRejectedError('constitution_changed');
  }

  const constitution = migrateConstitution(row.document);
  const occurredAt = new Date();
  const windowedHistory = await loadEvaluableWindowedTrades(intent.walletId, maxWindowHours(constitution), occurredAt, correlationId, userId, getDb(), intent.id);
  const decision = evaluateTrade(constitution, windowedHistory, {
    occurredAt,
    usdValue: intent.usdValue,
    isAcquisition: true,
    acquiredTier: intent.acquiredTier,
    lossLimitEnabled: await isFeatureEnabled(LOSS_LIMIT_ENABLED_FLAG),
  });

  if (foldVerdict(decision.evaluations) === 'block') {
    throw new SubmitRejectedError('rules_now_block');
  }
}

/** Marks a signed-but-unsendable intent failed and rethrows — no broadcast has happened on any path through here. */
async function failSignedIntent(params: SubmitRequestParams, reason: SubmitRejectionReason, stage: string, error: unknown): Promise<never> {
  await transitionFromSigned(params.intentId, 'failed');
  await recordFailure(params, reason, stage);

  throw error instanceof SubmitRejectedError ? error : new SubmitRejectedError(reason, String(error));
}

async function verifyAndBroadcast(params: SubmitRequestParams, intent: TradeIntentRow): Promise<BroadcastResult> {
  try {
    await reevaluate(intent, params.userId, params.correlationId);
  } catch (error) {
    return failSignedIntent(params, error instanceof SubmitRejectedError ? error.reason : 'rules_now_block', 'reevaluation', error);
  }

  try {
    return await broadcastSignedTransaction(params.signedTransactionBase64, params.correlationId);
  } catch (error) {
    return failSignedIntent(params, 'broadcast_failed', 'broadcast', error);
  }
}

/**
 * Verify a signed swap and — depending on `chain.broadcast` — send it or prove by simulation
 * that it would have sent.
 *
 * @throws SubmitRejectedError for every refusal. Nothing is ever broadcast on a throwing path.
 */
export async function submitSignedSwap(params: SubmitRequestParams): Promise<SubmitResult> {
  let presented: PresentedTransaction;

  try {
    presented = readPresentedTransaction(params.signedTransactionBase64);
  } catch (error) {
    // Unreadable bytes never reach the intent row at all — but a submit that failed must be
    // visible in telemetry rather than only in an HTTP status (CLAUDE.md → no silent failures).
    await recordFailure(params, error instanceof SubmitRejectedError ? error.reason : 'malformed_transaction', 'decode');

    throw error;
  }

  // Independent of both the hash comparison and `intent.wallet_id`: the fee payer is the
  // account this transaction spends from, and it must be the account whose session is asking.
  if (presented.feePayer !== params.walletAddress) {
    await recordFailure(params, 'fee_payer_mismatch', 'verification');

    throw new SubmitRejectedError('fee_payer_mismatch');
  }

  const signed = await transitionToSigned(params, presented);

  if (!signed) {
    try {
      return await resolveZeroRowOutcome(params, presented);
    } catch (error) {
      if (error instanceof SubmitRejectedError) {
        await recordFailure(params, error.reason, 'verification');
      }

      throw error;
    }
  }

  await recordEvent({
    eventType: 'trade.intent_signed',
    occurredAt: new Date(),
    correlationId: params.correlationId,
    userId: params.userId,
    payload: { intentId: signed.id, walletId: signed.walletId, signature: presented.signature, txMessageHash: presented.messageHash },
  });

  const broadcast = await verifyAndBroadcast(params, signed);
  const submitted = await transitionFromSigned(params.intentId, 'submitted');

  if (!submitted) {
    // Someone else moved this row past `signed` while we were verifying. Their events tell the
    // story; adding ours would double-count one submit.
    //
    // "Someone else" is no longer only a concurrent submit winning the `signed → submitted`
    // race: `reconcile-wallet.ts`'s stranded-intent sweep can now also move a still-`signed`
    // row straight to `failed` out from under an in-flight submit whose broadcast is taking
    // long enough to outlast the blockhash's own grace period. Reporting a hardcoded
    // `'submitted'` here would tell the caller that when the row is actually `failed` — read
    // the row back and answer with whatever it genuinely holds now, same principle as
    // `resolveZeroRowOutcome`'s re-read. `signed.id` is still safe to use as the intent id
    // (the guarded update above already proved this exact row exists).
    const current = await loadIntent(params.intentId);

    return { intentId: signed.id, status: current?.status ?? 'submitted', signature: presented.signature, dryRun: broadcast.dryRun, replayed: true };
  }

  await recordEvent({
    eventType: SUBMITTED_EVENT_TYPE,
    occurredAt: new Date(),
    correlationId: params.correlationId,
    userId: params.userId,
    payload: {
      intentId: submitted.id,
      walletId: submitted.walletId,
      signature: presented.signature,
      dryRun: broadcast.dryRun,
      networkSignature: broadcast.networkSignature,
    },
  });

  return { intentId: submitted.id, status: 'submitted', signature: presented.signature, dryRun: broadcast.dryRun, replayed: false };
}
