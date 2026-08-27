import { addUsd } from '@degencage/rules';

/**
 * Pure FIFO cost-basis lot matching, per mint, in USD — no I/O, mirroring `derive-swaps.ts`'s
 * split (a pure decision function; `reconcile-wallet.ts` is the thin query/persistence layer
 * around it, per `.ai/decisions/migration-and-test-tooling.md`'s "DB-touching modules are
 * split into a pure decision function plus a thin query").
 *
 * Token amounts are `BigInt` base units throughout; USD amounts are exact decimal-digit
 * strings, scaled internally via `BigInt` — never a native float, never `Number` on anything
 * with a fractional token amount (CLAUDE.md → money math).
 *
 * Decision 1 ("Loss = realized loss on round-trips opened AND closed after activation.
 * Partial coverage; UI must say so.") is enforced precisely here: `matchDisposal` only ever
 * returns a non-null `realizedLossUsd` when *every* lot it consumed was opened after
 * activation, *this* disposal itself is after activation, the disposal was fully covered by
 * known lots (no deficit), and both legs were priced. Any one of those failing excludes the
 * close from the loss sum entirely — never split or prorated (simpler, and honestly
 * conservative, exactly as the plan calls for).
 */

/** USD amounts in this module are scaled to this many fractional digits — matches `NUMERIC(38,12)`. */
const USD_SCALE = 12;

/** A lot as loaded from `position_lots` (or freshly opened, pre-insert — `id` is the caller's to assign). */
export interface PositionLot {
  id: string;
  mint: string;
  openedAt: Date;
  openedAfterActivation: boolean;
  /**
   * The opening trade's `slot`/`transactionIndex` — the actual FIFO ordering key. The caller
   * (`reconcile-wallet.ts`'s `loadOpenLots`) is responsible for sorting `lotsForMint` by these
   * before calling `matchDisposal`; this module trusts that order rather than re-deriving it,
   * same as it trusts caller-supplied ordering for everything else.
   */
  slot: number;
  transactionIndex: number;
  /** Decimal-digit string of base units remaining — never a float, same convention as `trades.*_amount_base_units`. */
  remainingBaseUnits: bigint;
  /** `null` exactly when the opening trade was unpriced — see the schema comment on `position_lots.cost_basis_usd`. */
  costBasisUsd: string | null;
}

export interface NewLotInput {
  mint: string;
  baseUnits: bigint;
  /** The opening trade's `usdValue` — `null` propagates: an unpriced acquisition has no known cost basis. */
  costBasisUsd: string | null;
  openedAt: Date;
  openedAfterActivation: boolean;
  slot: number;
  transactionIndex: number;
}

/** Opens a lot from an acquisition (BUY) leg. Trivial, but named and exported so the open/close halves of matching read symmetrically at call sites. */
export function openLot(input: NewLotInput): Omit<PositionLot, 'id'> {
  return {
    mint: input.mint,
    openedAt: input.openedAt,
    openedAfterActivation: input.openedAfterActivation,
    slot: input.slot,
    transactionIndex: input.transactionIndex,
    remainingBaseUnits: input.baseUnits,
    costBasisUsd: input.costBasisUsd,
  };
}

export interface LotConsumption {
  lot: PositionLot;
  unitsConsumed: bigint;
  /** `null` iff `lot.costBasisUsd` was `null` — an unpriced lot's consumed slice has no known cost either. */
  costBasisConsumed: string | null;
}

export interface DisposalMatchResult {
  /** Lots drawn from, oldest first, in the order actually consumed. */
  consumptions: LotConsumption[];
  /** `lotsForMint`'s lots after this disposal — same length/order as the input, remaining units/cost-basis reduced. Persist these. */
  updatedLots: PositionLot[];
  /** Whether this disposal drew down at least one existing lot at all — independent of loss-limit eligibility. */
  isRoundTripClose: boolean;
  /** Units of the disposal with no lot to match — a deficit means part of the position predates this module's coverage. */
  unmatchedBaseUnits: bigint;
  /** Non-null only when eligible per decision 1 — see the module doc comment. */
  realizedLossUsd: string | null;
}

/** Splits a decimal digit string into sign/integer/fraction — mirrors `packages/rules/src/evaluate.ts`'s `splitDecimal`, extended with a sign so it can represent a loss. */
function parseUsdToScaled(value: string): bigint {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [intPart = '0', fracPart = ''] = unsigned.split('.');
  const paddedFrac = fracPart.padEnd(USD_SCALE, '0').slice(0, USD_SCALE);
  const magnitude = BigInt((intPart || '0') + paddedFrac);

  return negative ? -magnitude : magnitude;
}

function formatScaledUsd(scaled: bigint): string {
  const negative = scaled < 0n;
  const magnitude = negative ? -scaled : scaled;
  const digits = magnitude.toString().padStart(USD_SCALE + 1, '0');
  const intPart = digits.slice(0, digits.length - USD_SCALE);
  const fracPart = digits.slice(digits.length - USD_SCALE);

  return `${negative ? '-' : ''}${intPart}.${fracPart}`;
}

/** Exact signed decimal-string subtraction via `BigInt` on a fixed scale — never a float. Unlike `@degencage/rules`' `addUsd`/`compareUsd`, this supports a negative result (a realized loss). */
export function subtractUsd(a: string, b: string): string {
  return formatScaledUsd(parseUsdToScaled(a) - parseUsdToScaled(b));
}

/**
 * `totalUsd * numerator / denominator`, exact `BigInt` division truncated toward zero —
 * the proportional slice of a lot's remaining cost basis consumed by a partial disposal.
 * Truncation (never rounding up) means the tiny remainder, if any, stays attributed to the
 * lot rather than manufactured on either side — the same conservative bias as the rest of
 * this module.
 */
function proportionalUsd(totalUsd: string, numerator: bigint, denominator: bigint): string {
  const scaled = parseUsdToScaled(totalUsd);

  return formatScaledUsd((scaled * numerator) / denominator);
}

/**
 * Matches a disposal (SELL leg) of `disposalBaseUnits` against `lotsForMint`, oldest lot
 * first — the caller is responsible for that ordering (`reconcile-wallet.ts` loads
 * `position_lots` `ORDER BY opened_at ASC`, same shape this function assumes).
 *
 * @param proceedsUsd - The disposal trade's own `usdValue`. `null` (unpriced) makes every
 *   consumption's realized loss unknown, same as an unpriced lot's cost basis — both exclude
 *   the close from the loss sum rather than guessing.
 * @param closedAfterActivation - Whether *this* disposal trade occurred after the wallet's
 *   active constitution's `activated_at`. Decision 1 requires both halves of a round trip —
 *   the lot(s) opened *and* the disposal that closes them — to be after activation; a lot
 *   opened after activation but closed by a pre-activation disposal is still excluded.
 */
export function matchDisposal(
  lotsForMint: PositionLot[],
  disposalBaseUnits: bigint,
  proceedsUsd: string | null,
  closedAfterActivation: boolean,
): DisposalMatchResult {
  let remainingToConsume = disposalBaseUnits;
  const consumptions: LotConsumption[] = [];
  const updatedLots: PositionLot[] = [];

  for (const lot of lotsForMint) {
    if (remainingToConsume <= 0n || lot.remainingBaseUnits <= 0n) {
      updatedLots.push(lot);
      continue;
    }

    const unitsConsumed = remainingToConsume < lot.remainingBaseUnits ? remainingToConsume : lot.remainingBaseUnits;
    const isFullConsumption = unitsConsumed === lot.remainingBaseUnits;

    const costBasisConsumed =
      lot.costBasisUsd === null
        ? null
        : isFullConsumption
          ? lot.costBasisUsd
          : proportionalUsd(lot.costBasisUsd, unitsConsumed, lot.remainingBaseUnits);

    consumptions.push({ lot, unitsConsumed, costBasisConsumed });

    updatedLots.push({
      ...lot,
      remainingBaseUnits: lot.remainingBaseUnits - unitsConsumed,
      costBasisUsd:
        lot.costBasisUsd === null ? null : isFullConsumption ? '0.000000000000' : subtractUsd(lot.costBasisUsd, costBasisConsumed!),
    });

    remainingToConsume -= unitsConsumed;
  }

  const unmatchedBaseUnits = remainingToConsume > 0n ? remainingToConsume : 0n;
  const isRoundTripClose = consumptions.length > 0;
  const fullyMatched = unmatchedBaseUnits === 0n;
  const allLotsOpenedAfterActivation = consumptions.every((consumption) => consumption.lot.openedAfterActivation);
  const anyCostUnknown = consumptions.some((consumption) => consumption.costBasisConsumed === null);

  const eligibleForLoss =
    isRoundTripClose && fullyMatched && allLotsOpenedAfterActivation && closedAfterActivation && proceedsUsd !== null && !anyCostUnknown;

  const realizedLossUsd = eligibleForLoss
    ? subtractUsd(proceedsUsd!, consumptions.reduce((sum, consumption) => addUsd(sum, consumption.costBasisConsumed!), '0'))
    : null;

  return { consumptions, updatedLots, isRoundTripClose, unmatchedBaseUnits, realizedLossUsd };
}
