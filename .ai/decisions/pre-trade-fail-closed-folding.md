# Unevaluable blocks — except where "unknown" is structural

**Decision:** `foldVerdict` (`server/swap/quote-service.ts`, reused verbatim by
`submit-service.ts`) allows a trade only when **every** `LimitEvaluation` is `allow`. Both
`violation` and `unevaluable` block. Against that, one deliberate carve-out: the pre-trade
evaluation leaves `isRoundTripClose` / `realizedLossUsd` unset, and `rolling_loss_usd` measures
the window's **already-realized** losses rather than reporting `unevaluable` over this trade's
own unknowable P&L.

**Why:**

**Unevaluable is what a soft dependency failure looks like.** An unresolvable mint decimal, an
unpriceable quote, a history row with no USD value — none of these throw; they arrive as
`usdValue: null` and surface as `unevaluable`. Folding those to "allow" would make every price
or token-data outage into blanket permission, at exactly the moment the user has the least
protection. So the fold is: not-`allow` is a block.

**But the same rule applied naively bricks the users who need it most.** There is no
lot-matching before a trade exists, so this trade's realized loss is unknown *by construction*,
not because anything failed. If that folded to `unevaluable`, any constitution carrying a
`rolling_loss_usd` limit would block **every** trade forever — the limit would silently stop
being a loss cap and become a total trading ban, and the user would have no way to tell the
difference from a bug. The distinction the fold rests on is therefore between *unknown because
something is missing or broken* (blocks) and *unknown because it cannot exist yet* (evaluate
against what is known). The limit still bites: it blocks whenever the window's already-realized
losses alone exceed `maxUsd`, and reconciliation trues the trade's own loss up afterwards.

**The one place `rolling_loss_usd` does go unevaluable is a kill switch, not a limitation.**
With `rules.loss_limit_enabled` off, lot-matching never ran, so every `realizedLossUsd` is
`null` and a `$0` sum is indistinguishable from a genuinely clean window — unknown-because-broken,
which blocks. That flag is seeded **on** precisely because off is a total trading block for
anyone with a loss limit.

**One fold, two call sites.** Quote and submit import the same function. Two implementations
would eventually disagree, and a trade blocked at quote that passes at submit (or the reverse)
is the failure mode the whole submit-time re-evaluation exists to prevent.

**Rejected:**

- **`unevaluable` → allow, or → warn-only** — makes a dependency outage indistinguishable from
  permission.
- **`rolling_loss_usd` → `unevaluable` pre-trade for the trade's own unknown loss** — the
  bricking case above; correct-looking and functionally a ban.
- **Assuming the trade's realized loss is `$0`** — understates the limit in the one direction
  that lets trades through, and reconciliation supplies the real figure anyway.
- **A separate submit-side fold** — two rules that must agree and nothing forcing them to.

**Constraints it creates:**

- Every new limit type must classify its own unknowns. "Unknown because a dependency failed"
  is `unevaluable`; "unknown because it is unknowable before execution" must evaluate against
  known history instead — never a silent `allow`, and never a blanket `unevaluable`.
- `foldVerdict` stays the single fold site; no caller may re-derive a verdict from
  `evaluations`.
- `rules.loss_limit_enabled` has trading-wide blast radius for any constitution with a
  `rolling_loss_usd` limit. Flipping it off is a trading stop, not a tuning knob.
- An unpriced quote is `usd_value: null` and blocks. Nothing may substitute `$0` for a missing
  price to keep a limit evaluable.
