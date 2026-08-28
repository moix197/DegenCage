# Chain data source and swap derivation

**Decision:** Helius is the one chain provider. Wallet *history* comes from a single
JSON-RPC method, `getTransactionsForAddress`
(`apps/web/src/server/chain/helius-client.ts`), and a trade is
*derived by us* from `meta.pre/postTokenBalances` plus the wallet's native-lamport delta
(`derive-swaps.ts`) — not read off any provider's parsed-swap output.

The query shape is load-bearing and fixed: `commitment: 'finalized'` (never see a swap that
gets rolled back), `sortOrder: 'asc'` (a cursor can only advance monotonically if pages
arrive in slot order), `filters.tokenAccounts: 'balanceChanged'` (the derivation reads
balance deltas, so a transaction with none is noise), `maxSupportedTransactionVersion: 0`
(v0 lookup-table transactions are most of Solana DEX flow; omitting it makes Helius drop
them), and `paginationToken` followed to exhaustion.

The same integration also serves the **pre-trade** path (`chain/helius-simulate.ts`):
`simulateTransaction` measures the compute-unit limit Jupiter's `/build` never returns (and
re-verifies signed bytes on a dry-run submit), while `getMultipleAccounts` resolves the address
lookup tables a route references. Neither is computable locally, and both are read-side calls on
the same provider — so they reuse `chain.helius` rather than earning switches of their own:
there is no configuration in which reading history is trusted while reading account state is
not, and one flip must take Helius out of the product entirely. *Sending* a signed transaction
is deliberately not in that module — `chain/broadcast-transaction.ts` is the only write side,
behind its own `chain.broadcast` switch
([feature-flags-and-kill-switches](feature-flags-and-kill-switches.md)) — so no refactor can
widen a read helper into one that moves funds.

**Why:** A parsed-swap API is a per-program parser someone else maintains: it lags new
DEXes and aggregator routes, and its silence is indistinguishable from "no trade happened"
— which for a commitment product means a false-clean record. Net balance deltas are
venue-agnostic by construction: any program that moved the user's tokens shows up, and the
signed net is exactly the economic in/out we need to value. It also decides decision 5
("one tx = one trade, valued net") for free — a multi-hop route nets to its endpoints
rather than counting each hop.

Native SOL is normalized onto the wSOL mint throughout derivation. That is what makes
wrap/unwrap self-cancel with no special-cased detection, and it is why wSOL is a member of
the LST set.

Helius' availability of this method on the **free tier** was the design's single external
assumption, so it was verified live before any pipeline code was written (2026-08-26: HTTP
200, populated `result.data`, `meta.preTokenBalances`/`postTokenBalances` present in the
documented shape).

**Rejected:**

- **A parsed-swap / enhanced-transactions API** — see above; a maintained parser's blind
  spots become our silent undercounts.
- **Our own `getSignaturesForAddress` + `getTransaction` loop against a public RPC** — same
  derivation work, plus rate limits and pagination we would own, for no accuracy gain.
- **Jupiter-only trade history** — would see only trades routed through Jupiter, which is
  precisely the opposite of the "we saw that" accountability requirement.
- **An exhaustive LST list** — the curated set (`lst-allowlist.ts`) is deliberately
  non-exhaustive: a missed LST is over-counted as a real trade (visible, correctable), while
  chasing completeness is unbounded work. Erring toward over-counting is the safe direction.

**Constraints it creates:**

- Pagination is capped at 50 pages (`MAX_PAGES` × 100/page) — an unbounded loop against an
  external API is forbidden by CLAUDE.md. Hitting the cap **warns and returns a truncated
  history**; a wallet deep enough to hit it needs the cap raised or the range narrowed.
- Fails closed on both paths: `chain.helius` off, or any request error, **throws**. On the
  history path it must never resolve to `[]`, which reads as "wallet has no trades" instead of
  "we could not check". On the pre-trade path the throw becomes a *blocked quote* — never a
  guessed compute-unit limit and never a partially-resolved lookup table, which would compile a
  transaction that looks fine and fails only at send time, with no build-time signal.
- Every transaction produces exactly one row, real trade *or* excluded candidate
  (`no_net_change`, `pure_receive`, `pure_send`, `wrap_unwrap`, `lst_swap`,
  `missing_block_time`) — exclusions are shown to the user with their reason, never silently
  dropped. Hence nullable `sold_*`/`bought_*` columns: a pure receive has no sold leg.
- SOL↔LST and LST↔LST are excluded as staking, not directional bets (decision 8). The same
  set is the input to Phase 5's classification, so exclusion and classification can never
  diverge.
- Dust below `RENT_NOISE_LAMPORTS` (0.003 SOL) on the SOL leg is treated as ATA rent noise.
  That threshold is a floor on the smallest SOL-leg trade this pipeline can see.
