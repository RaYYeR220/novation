# Risk model

This page explains how Novation computes margin, marks volatility, settles an expiry and absorbs a default. It quotes the defaults and the hard bounds from [`RiskParams.sol`](../contracts/src/core/RiskParams.sol); the defaults are the values the test suite deploys with (see `_defaultGlobals` and `_defaultUnderlying` in [`Fixture.sol`](../contracts/test/utils/Fixture.sol)). Once setup is finalized, governance can move a parameter only inside its bounds, and only through the timelock.

All amounts are 18-decimal fixed-point integers (WAD). A price is USD per raw stock token, an option contract is written on one raw token, and 1 USDG counts as 1 USD.

## Contents

- [Scenario grid](#scenario-grid)
- [Shock range](#shock-range)
- [Sessions and halts](#sessions-and-halts)
- [Margin requirement](#margin-requirement)
- [Short-option minimum](#short-option-minimum)
- [Diversification credit](#diversification-credit)
- [Trading rules that use the margin](#trading-rules-that-use-the-margin)
- [Volatility estimator](#volatility-estimator)
- [Settlement price](#settlement-price)
- [Settlement and the default waterfall](#settlement-and-the-default-waterfall)
- [Liquidation](#liquidation)
- [Parameter defaults and bounds](#parameter-defaults-and-bounds)

## Scenario grid

The kernel re-prices an account's whole book under 39 scenarios per underlying: 13 price points times 3 volatility points.

```text
price move   m_j = (j - 6) / 6 × R          j = 0 … 12, so m runs from -R to +R in steps of R/6
volatility   σ_v ∈ { σ × (1 - volDown), σ, σ × (1 + volUp) }      v = 0, 1, 2
scenario     s = 13 × v + j                  s = 19 is the base case (no move, unchanged σ)
```

With the defaults (`volDown` 30%, `volUp` 40%) the volatility points are 0.7σ, σ and 1.4σ.

For each underlying `u` and scenario `s`, the kernel computes the profit and loss of everything the account holds on `u`:

```text
pnl_u[s] = tokenQty_u × (S_u × (1 + m_j) - S_u)
         + Σ over options on u:  qty × (BS(S_u × (1 + m_j), K, T, σ_v) - mark)
mark     = BS(S_u, K, T, σ)          the option's value at the current spot and mark volatility
```

`BS` is Black-Scholes in integer fixed-point: the normal CDF uses Abramowitz-Stegun 26.2.17 (absolute error below 7.5e-8), and option prices agree with a float reference to within 2e-7 of `max(S, K)`. An option at or past expiry that isn't settled yet is valued at intrinsic value. Once its expiry is settled, it leaves the kernel and its payoff counts toward equity directly, longs rounded down and shorts rounded up.

The correlated regime uses the same scenario index for every underlying: in scenario `s`, NVDA and SPY both move by `m_j` of their own range. Novation doesn't estimate betas; each underlying's own shock range already scales with its own volatility.

## Shock range

The shock range `R` of an underlying is computed by the clearinghouse before each kernel call (`MarginLogic._underlying`):

```text
base = max(minShock, shockK × σ × √(horizonDays / 365))
R    = min(90%, base × sessionMult)
```

With the defaults (`shockK` 3, `horizonDays` 2, `minShock` 10%), `base` is `0.222 × σ` and the 10% floor binds for any σ below 45%.

| Mark volatility σ | Regular (1.0) | Extended (1.2) | Weekend or holiday (1.75) | Halted (2.5) |
|---|---|---|---|---|
| 35% | 10.0% | 12.0% | 17.5% | 25.0% |
| 80% | 17.8% | 21.3% | 31.1% | 44.4% |
| 150% | 33.3% | 40.0% | 58.3% | 83.3% |

The same book therefore needs visibly more margin on Friday at 20:00 ET than at 15:00 ET, and more again if its feed goes stale. The 90% cap keeps every scenario price positive.

## Sessions and halts

`MarketDataHub.session(u)` returns one of five sessions. The first four come from [`NyseCalendar`](../contracts/src/libraries/NyseCalendar.sol), a pure library that converts UTC to New York time (US daylight-saving rules) and knows the 2026 and 2027 NYSE holidays and early closes.

| Session | When | Default multiplier |
|---|---|---|
| REGULAR | 09:30 to 16:00 ET on a trading day (13:00 on an early-close day) | 1.0 |
| EXTENDED | The rest of the 24/5 feed window: before the open, after the close until 20:00 ET, and from 20:00 ET on the evening before a trading day | 1.2 |
| WEEKEND | Saturday and Sunday, plus the evening after the week's last trading day from 20:00 ET, until the window reopens at 20:00 ET before the next trading day | 1.75 |
| HOLIDAY | A weekday exchange holiday, plus the evening before it from 20:00 ET, until the window reopens | 1.75 |
| HALTED | Any halt condition below, whatever the clock says | 2.5 |

HALTED overrides the calendar when any of these holds. Each one fails closed: a call that reverts or returns malformed data counts as the bad case.

- The feed can't be read, its answer is zero or negative, or it reports more than 18 decimals.
- The latest round is timestamped in the future, or is older than the session's staleness limit (26 hours in regular and extended hours, 96 hours when the market is closed). The 26-hour limit lets a quiet feed such as SPY, which can go a full 24-hour heartbeat without a round, stay live.
- The token's `paused()` or `oraclePaused()` is true. `oraclePaused()` is the issuer's corporate-action freeze, during which the feed holds its last value.
- The price is outside the underlying's plausibility band `[minPrice, maxPrice]`. The Robinhood Chain feeds launched with answers 1e10 too high for about a day and a half, so a band is not hypothetical.
- An ERC-8056 multiplier change is close: from `haltWindow` (24 hours) before the token's `effectiveAt()` until one hour after it.
- A sequencer-uptime feed is configured and reports the sequencer down, unreadable, or restarted less than an hour ago. Robinhood Chain has no such feed today, so the address can stay unset.

A halted underlying accepts no opening trades, and its shock range uses the halted multiplier. Risk-reducing trades and margin-checked withdrawals stay open as long as the feed still returns a positive price inside the band.

Contracts are written on the raw stock token, and the Chainlink price already includes the token's ERC-8056 multiplier (dividends are reinvested through it). Splits and dividends are therefore neutral for an open option and need no contract adjustment; the UI shows share-equivalent strikes as `strike / uiMultiplier`.

## Margin requirement

The kernel turns the scenario PnL into three losses, all floored at zero:

```text
lossCorr  = -min over s of Σ_u pnl_u[s]                the correlated worst case
lossIndep =  Σ_u ( -min over s of pnl_u[s] )           each underlying at its own worst case
lossIM    =  max(lossCorr, (1 - diversificationCredit) × lossIndep) + shortOptionMinimum
```

The clearinghouse then derives the account's state ([`MarginLogic`](../contracts/src/core/logic/MarginLogic.sol)):

```text
equity = cash + mtm + settledValue - deficit
IM     = lossIM
MM     = ceil(IM × mmRatio)                             mmRatio defaults to 0.75
healthy       ⇔ equity ≥ IM
liquidatable  ⇔ equity < MM
```

`mtm` is the value of the stock collateral at spot plus the marks of the open options. `settledValue` is the payoff of expired options whose expiry is settled but not yet booked to the account, plus its unpaid claims on expiry pools at face value, so settling an account never moves its equity. `deficit` is what the account still owes after a settlement it couldn't pay.

## Short-option minimum

Every short option adds a floor to IM, whether or not it is covered:

```text
shortOptionMinimum = Σ over short positions  ceil(|qty| × spot × shortOptionMinPct)     default 1%
```

Far out-of-the-money shorts can show almost no loss inside the grid. The floor keeps a minimum reserve behind each one: ten short NVDA calls at a spot of 180 USDG add 18 USDG of IM. Covered calls carry the floor too; that is conservative by design.

## Diversification credit

`lossIndep` assumes that every underlying moves against the account at the same time, each in its own worst direction. `lossCorr` assumes they all move together. Neither is the truth for a mixed book, so IM takes the correlated loss but never less than `1 - diversificationCredit` of the independent one: 70% by default. The credit is capped at 50%, so the floor never drops below half of the independent loss.

An example: the worst NVDA-only loss is 1,000, the worst SPY-only loss is 800, and in the worst shared scenario the two legs partly offset for a loss of 300. Then `lossIndep` is 1,800, the credit allows 1,260, and IM before the short-option minimum is 1,260 rather than 300 or 1,800. A book long both names in the same direction usually has both worst cases in the same scenario; then `lossCorr` equals `lossIndep` and the credit changes nothing.

## Trading rules that use the margin

[`TradeLogic`](../contracts/src/core/logic/TradeLogic.sol) applies these rules to each side of a trade:

- A side opens when its position grows in absolute size or flips sign. A flip counts as opening.
- Opening is refused when the underlying is disabled, the guardian has paused opening, the session is HALTED, or the account owes a deficit.
- After the trade an opening side must be healthy (`equity ≥ IM`).
- A reducing side must be healthy too, unless the trade is a pure reduction: `lossIM` didn't rise and equity, before the protocol fee, didn't fall. An underwater account can cut risk at or below the mark, but it can't sell its hedge or pay value away through an off-market price.
- While opening is blocked for its account, a reducing side must not raise `lossIM` at all.
- A position is either flat or at least `minTradeQty` (0.01 contracts), so nobody can leave dust behind.
- Long open interest per series is capped at `maxOpenInterest`; a trade that doesn't grow open interest always fits.
- The fee is 0.03% of notional (`|qty| × spot`), capped at 12.5% of the premium, and split between the InsuranceFund (50%) and the treasury.

Agent-acted sides carry three more checks against the agent's policy:

- `lossIM ≤ maxWorstLoss` after the trade. A reducing trade that doesn't raise `lossIM` passes even when the account is already over budget, so an agent can always cut risk.
- The premium is at most `maxPremiumPerTrade`.
- The trade costs the account at most `maxPremiumPerTrade` of equity measured at the kernel mark, fee aside. This stops an agent from giving positions away at a zero premium or overpaying a colluding counterparty.

## Volatility estimator

Mark volatility is realized volatility, estimated on-chain from the Chainlink rounds of each underlying. `MarketDataHub.pokeVol(u, roundIds)` is permissionless: it reads up to 64 consecutive rounds, and the kernel's `ewmaUpdate` folds them into two exponentially weighted averages.

```text
r_i   = ln(P_i / P_(i-1))                 log-return between consecutive rounds
Δt_i  = (t_i - t_(i-1)) in years
r2   ← λ × r2 + (1 - λ) × r_i²
dt   ← λ × dt + (1 - λ) × Δt_i            λ = 0.97 per round, a half-life of about 23 rounds
σ²    = r2 / dt                           annualized variance
mark σ = min(volCap, max(volFloor, √σ²))
```

The estimator is a ratio of two averages rather than an average of ratios, because the feeds update on price deviation (0.5%) rather than on a clock. A round fires when the price has moved about 0.5%, so a fast move produces a short Δt and a large `r²/Δt`. Averaging `r²/Δt` per round therefore overweights fast moves and overstates volatility. For a driftless diffusion sampled at such stopping times, the expected squared return equals σ² times the expected elapsed time, so `Σr² / ΣΔt` is a consistent estimate of σ² under deviation-triggered sampling.

The gaps are kept. A return across a weekend or a holiday enters with its real Δt, so the Monday gap shows up in the estimate.

The estimator also fails closed:

- A new underlying starts from the prior `(volCap² × 1 day, 1 day)`, so it reads `volCap` (to within integer rounding) until real rounds accumulate.
- If nobody pokes it for `volStaleness` (48 hours), mark volatility falls back to `volCap`.
- Rounds must be consecutive in the feed's current phase. Ids that are already processed are skipped, so a front-running poke can't make a keeper's batch revert. After a Chainlink phase change, `rebaseVol` moves the anchor to the new phase once the old one is exhausted.

Per-underlying floors and caps are set at listing; the test suite uses 35% to 150% for NVDA and 12% to 80% for SPY.

## Settlement price

Robinhood Chain's equity feeds publish no round at the Friday close. The settlement price is the feed's last print at or before the close, and the caller has to prove it is the last one. `MarketDataHub.settlementPrice(u, expiry, hint)` accepts a hint round when:

- the expiry is a weekly NYSE close (`NyseCalendar.isWeeklyExpiry`) and that moment has passed;
- the hint round exists, has a positive answer and was printed at or before the close;
- it is no older than `maxSettlementLag` before the close (24 hours 15 minutes, because a quiet feed can print only once a day);
- its price is inside the plausibility band;
- and one of these proofs holds:

| Proof | Condition |
|---|---|
| (i) Next round | The next round in the same phase exists and was printed after the close. |
| (ii) Latest round | The hint is still the feed's latest round and the current time is strictly after the close. Any later round must print at or after now, so after the close. Requiring strictly after closes a race with a round printed in the same second as the close. |
| (iii) Phase change | The feed moved to a new aggregator phase after the close: the hint's phase has no further round, and round 1 of the next phase was printed after the close. |
| (iv) Fallback | Only via `settlementPriceFallback`, and only 72 hours after the close. The caller names the first round printed after the close. It is accepted when its predecessor, the last pre-close print, is older than `maxSettlementLag` or outside the band; the predecessor is found across a phase boundary if needed. The settlement price is then the first post-close print, which must be in the band. |

Proof (ii) is the one used in practice: the feeds rarely print between the Friday close and Sunday 20:00 ET, so the last pre-close round is almost always still the latest one right after the close, and settlement can happen within minutes. If a post-close round does appear first, proof (i) covers it.

There is no admin override. If the feed prints nothing after the close, settlement waits for its next round. If no proof can ever pass, for example a stale pre-close print followed by an implausible first post-close print, that underlying's expiry can't be settled, and the claims of that expiry stay frozen; this is the cost of having no override, and it is listed in [SECURITY.md](../SECURITY.md#known-limitations). Round ids are phase-aware (`phase << 64 | aggregatorRound`), and a round that doesn't exist reads as zeros, as on the real feeds. `SeriesRegistry` stores one settlement price per underlying and expiry, once.

## Settlement and the default waterfall

Each expiry `E` is a weekly close shared by every underlying, and it has its own settlement pool. The pool exists so that no receiver is ever paid with someone else's cash, and so that settlement can't deadlock. The logic is in [`SettlementLogic`](../contracts/src/core/logic/SettlementLogic.sol).

1. **Series settlement.** Anyone calls `SeriesRegistry.settleExpiry(u, E, hint)` with a proof from the previous section.
2. **Account settlement.** Anyone calls `settleAccount(id, E)`. It closes every position of the account that expires at `E`, nets the payoffs (longs rounded down, shorts rounded up) and reduces the expiry's count of unsettled short interest.
3. **Net receiver.** The net payoff becomes a claim on `pool[E]`. Until it is paid, the claim counts toward the account's equity at face value.
4. **Net payer.** The payment goes through the waterfall:
   1. the account's cash, as far as it goes, into `pool[E]`;
   2. the InsuranceFund bridges the rest, rounded up to a whole USDG unit, into `pool[E]`;
   3. what the fund can't cover is recorded as pending for `E`;
   4. the account records a deficit (bridged plus pending), can't withdraw or open positions until it is repaid, and its stock collateral goes to a deficit sale run by the AuctionHouse (in development);
   5. sale proceeds repay the pending amount first and the InsuranceFund second, and anything left stays with the owner.
5. **Claims.** `claim(id, E)` moves a claim into cash once no short of `E` is unsettled and nothing is pending. Claims never exceed what payers put in; rounding dust stays in the pool.
6. **Socialized loss.** If a defaulter's collateral is exhausted and pending remains, anyone can call `socializeRemainder(id, E)` on the emptied account. The remainder is spread over all cash through the cash index, `cashIndex × (totalCash - remainder) / totalCash`, so every account loses the same fraction, and `LossSocialized` is emitted. The fund's bridge to that account is written off. If all cash in the system can't cover the remainder, the index stops at its minimum, the pool is marked impaired and its claims are paid pro rata, never more than each claim; the shortfall is realized when the claim is paid (`ClaimHaircut`).

The clearinghouse keeps these properties at all times: its USDG balance covers all cash plus all pools, its balance of each stock token covers all collateral in that token, and the cash index only ever falls, and only through `LossSocialized`. The one outside force that can break the token-balance property is the stock-token issuer's `adminBurn`, which can burn from any holder.

## Liquidation

The liquidation engine is in development; its parameters already live in `RiskParams`. An account becomes liquidatable when `equity < MM`. Anyone can start a Dutch auction, in which bidders take over a fraction of the account's positions, collateral and cash at a discount that grows linearly from `startDiscount` (2%) to `maxDiscount` (12%) over `auctionDuration` (30 minutes). A bid takes at most `maxFractionPerBid` (50%) unless the account is insolvent or below `dustEquity` (5 USDG). The bidder must pass its own IM check after the takeover, and `liquidationPenalty` (1%) goes to the InsuranceFund.

Auctions pause while the underlying is in a WEEKEND session or HALTED. The weekend shock range is wider precisely so that accounts reach Monday without a fire sale into a market with no price.

## Parameter defaults and bounds

Per underlying:

| Parameter | Default | Bound |
|---|---|---|
| `shockK` | 3 | 1 to 6 |
| `horizonDays` | 2 | 1 to 10 |
| `minShock` | 10% | 2% to 50% |
| `volUp` / `volDown` | 40% / 30% | 10% to 200% / 10% to 90% |
| `multExtended` | 1.2 | 1 to 4 |
| `multWeekend`, `multHoliday` | 1.75 | 1 to 4 |
| `multHalted` | 2.5 | 1 to 4 |
| `lambda` | 0.97 per round | 0.8 to 0.999 |
| `volFloor` | per underlying (NVDA 35%, SPY 12% in tests) | 5% to 200% |
| `volCap` | per underlying (NVDA 150%, SPY 80% in tests) | `volFloor` to 500% |
| `volStaleness` | 48 hours | 1 hour to 7 days |
| `maxStaleRegular`, `maxStaleExtended` | 26 hours | 5 minutes to 48 hours |
| `maxStaleClosed` | 96 hours | 1 hour to 96 hours |
| `minPrice`, `maxPrice` | per underlying | 0.01 USDG to 1,000,000 USDG, `maxPrice > minPrice` |
| `strikeStep` | per underlying (5 USDG in tests) | 0.01 to 1,000 USDG |
| `maxOpenInterest` | 1,000,000 contracts per series | 1 to 10^9 contracts |

Global:

| Parameter | Default | Bound |
|---|---|---|
| `mmRatio` | 0.75 | 0.5 to 0.95 |
| `diversificationCredit` | 30% | 0% to 50% |
| `shortOptionMinPct` | 1% | 0.5% to 10% |
| `feeRate` | 0.03% of notional | 0% to 0.1% |
| `feeCapOfPremium` | 12.5% | 1% to 20% |
| `insuranceShare` | 50% of fees | 20% to 100% |
| `startDiscount` | 2% | 0% to 5% |
| `maxDiscount` | 12% | `startDiscount` to 25% |
| `auctionDuration` | 30 minutes | 5 minutes to 6 hours |
| `maxFractionPerBid` | 50% | 10% to 100% |
| `liquidationPenalty` | 1% | 0% to 5% |
| `dustEquity` | 5 USDG | 0 to 100 USDG |
| `maxSettlementLag` | 24 hours 15 minutes | 1 minute to 25 hours |
| `haltWindow` | 24 hours | 1 hour to 72 hours |
| `maxWeeksOut` | 6 weeks ahead | 1 to 12 |
| `maxStrikeDeviation` | 50% from spot at listing | 10% to 90% |
| `rate` | 0% | 0% to 20% |
| `minTradeQty` | 0.01 contracts | 0.001 to 1 |

Hard-coded in the contracts and not governable: 39 scenarios, at most 256 positions and 8 underlyings per subaccount, a 90% cap on the shock range, the 72-hour settlement fallback delay and the one-hour post-change multiplier halt.
