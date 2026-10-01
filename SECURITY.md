# Security

This document describes who can do what in Novation, which properties the contracts maintain, the threats the design addresses, the issues found and fixed during internal review, and the limits that remain. It covers the Solidity contracts in `contracts/src`, the Stylus risk kernel in `kernel/` and the deployment tooling in `tools/`.

**Audit status: internally reviewed; not externally audited.** Don't deposit funds you can't afford to lose. The current deployment is on Robinhood Chain testnet with mock tokens ([MOCKS.md](MOCKS.md)).

## Trust model

The core contracts are immutable: no proxies, no `selfdestruct`, no `delegatecall` except into the linked logic libraries. Every external state-changing function on a stateful contract is guarded by OpenZeppelin's `ReentrancyGuardTransient`, and every token transfer goes through `SafeERC20`.

| Role | Holder | Powers | Cannot |
|---|---|---|---|
| Account owner | The address that created the subaccount | Deposit, withdraw (if the account stays above IM and owes no deficit), trade through venues, grant and revoke agents | Trade without a venue, open risk while in deficit |
| Agent | An address the owner granted a policy to | Trade through venues for that account, on allowed underlyings, until the policy expires, within the worst-loss budget, the premium cap and the per-trade value-drain cap; sign RFQ quotes for the account | Withdraw, grant or revoke agents, call `trade` directly, cancel the owner's quote nonces |
| Venue | A contract on the clearinghouse's venue list | Call `Clearinghouse.trade` and name the actor for each side | Be added after setup is finalized |
| Anyone | Any address, including keepers | Deposit into any account; list series; initialize and update volatility; settle an expiry with a valid proof; settle accounts, claim and socialize a remainder; fund the InsuranceFund | Choose a price, skip a proof, or change a parameter |
| Setup admin | The deployer, until `finalizeSetup` | Clearinghouse: add venues, bind the auction house. RiskParams: add underlyings and set parameters within bounds. InsuranceFund: bind the clearinghouse once | Anything on the clearinghouse or RiskParams after their setup is finalized |
| Timelock | An OpenZeppelin `TimelockController` (24-hour minimum delay planned for mainnet) | Add underlyings, change any parameter within its hard-coded bounds, enable or disable an underlying, pause or unpause opening | Exceed a bound, change an underlying's feed, move funds, change code, or block withdrawals directly (see the note below) |
| Guardian | A separate key or multisig | Pause and unpause opening | Anything else |
| AuctionHouse | The contract bound at setup (in development) | Call the clearinghouse's auction hooks: move a fraction of an account to a bidder, charge the liquidation penalty, draw on the InsuranceFund for an insolvent account, apply deficit-sale proceeds | Call any other clearinghouse function with special rights |

Two powers deserve a note. The setup admin chooses the venue list, and a venue vouches for the actors it passes; before trusting a deployment, check that `setupFinalized()` is true and that the `VenueAdded` events name only the published venues. The timelock can't touch funds, but it can raise margin requirements within bounds, and it can move an underlying's plausibility band so that the live price falls outside it, which freezes accounts holding options on that underlying until the band is corrected. The timelock delay is the users' window to react to either.

### External dependencies

- **Chainlink equity feeds** are the only price source. Novation never reads a DEX price.
- **Stock-token issuer.** The tokens are upgradeable beacon proxies controlled by the issuer. The issuer can pause transfers (the underlying then reads HALTED), freeze the oracle around a corporate action, blocklist addresses and burn tokens from any holder with `adminBurn`, the clearinghouse included. Stock tokens are not available to US persons.
- **USDG** is an issuer-administered stablecoin, and 1 USDG is treated as 1 USD.
- **Arbitrum Stylus.** The kernel program must be kept alive or re-activated every 365 days.

## Invariants

| Invariant | Enforced by | Tested by |
|---|---|---|
| The clearinghouse's USDG balance covers all cash plus every expiry pool | Settlement and cash paths move value only between cash and pools; credits round down, debits up | `ClearinghouseSettlement.t.sol`: a solvency assertion after every state change, `test_waterfallSolventAtAnyIndex` fuzz |
| Its balance of each stock token covers all collateral in that token | Deposits credit the balance delta actually received; withdrawals debit before transferring | `test_depositCreditsBalanceDelta` (fee-on-transfer token) |
| Positions are zero-sum per series, and open short interest per expiry is tracked exactly | Every trade moves `+q` to one side and `-q` to the other through one ledger function | `test_shortQtyTrackedPerExpiry`, `test_movePositionBookkeeping` |
| Settling an account never moves its equity | Unpaid claims count at face until `claim` moves them into cash | `test_settlingAndClaimingKeepEquity`, `test_thirdPartySettleCannotMakeReceiverLiquidatable` |
| No opening trade or withdrawal leaves an account below IM | `TradeLogic._checkMargin`, the post-withdrawal check in `Clearinghouse.withdraw` | `ClearinghouseTrade.t.sol`, `ClearinghouseAccounts.t.sol` |
| A reducing trade below IM never raises the worst-case loss or gives away equity | The pure-reduction rule in `TradeLogic._checkMargin` | `test_healthySpreadCannotShedLongLeg`, `test_underwaterHedgeStripReverts`, `test_closingAtMarkAllowedWhenUnderwater` |
| Claims on an expiry never exceed what was paid into its pool | Longs round down, shorts round up; claims wait until no short is unsettled and nothing is pending | `test_roundingFavorsPool` fuzz, `test_mixedAccountsNoDeadlock` (all six settle orders) |
| The cash index only decreases, and only through `LossSocialized` | Written only in `socializeRemainder` | `test_socializeRemainderReducesIndex`, `test_socializeUnfundableMarksImpaired` |
| A settlement price is a proven feed round, set once per underlying and expiry | `MarketDataHub.settlementPrice`, `SeriesRegistry.settleExpiry` | the `test_settlement*` and `test_fallback*` suites |
| Every parameter stays inside its bound | `RiskParams._validateUnderlying`, `_validateGlobals` | `RiskParams.t.sol` boundary tests |
| The Stylus kernel and `KernelReference` return identical integers | One algorithm, the same constant tables and the same order of operations | shared vectors in Foundry and Rust, a 5,100-call differential fuzz, on-chain parity on testnet |

A stateful invariant suite that drives the whole system (trades, time across sessions, price moves, settlement, liquidation) is in development. Today the invariants are covered by unit, fuzz and mutation tests per module.

## Threats and mitigations

| Threat | Mitigation |
|---|---|
| Stale, broken or manipulated prices | Chainlink only; per-session staleness limits; a plausibility band; unreadable or odd feed data reads as HALTED; opening is blocked while halted |
| Corporate actions | The underlying halts from 24 hours before an ERC-8056 multiplier change until one hour after, and whenever the issuer freezes the oracle or pauses the token |
| Weekend and holiday gaps | Shock ranges widen by session; returns across gaps enter the volatility estimate with their real duration; auctions wait for a live price |
| Margin bypass through a closing trade | A side below IM may only reduce: its worst-case loss can't rise and its equity can't fall. A position flip counts as opening |
| Rogue or compromised agent | Underlying mask, expiry, worst-loss budget, premium cap and a value-drain cap per trade; no withdrawals; revocation is immediate |
| A venue spoofing actors | The venue list is fixed at setup. The RFQ venue passes `msg.sender` as the taker and verifies that the quote signer is the maker's owner or live agent |
| Quote replay or overfill | EIP-712 domain bound to chain id and contract; deadlines; per-quote fill accounting; nonce-bitmap cancellation; ERC-1271 signers supported |
| Griefing an account with unpriceable collateral | A stock token can be deposited only while it has a price. Collateral-only tokens without a price count as 0 instead of reverting the margin check |
| Starving a price call of gas to fake a liquidation | Only the hub's own `NoPrice` and `ImplausiblePrice` errors are absorbed; any other failure, including out of gas, reverts |
| Settlement deadlock | One pool per expiry; receivers never block payers; the insurance bridge rounds up to a whole unit; donated cash is swept before socialization |
| Bad debt | Account cash, then the InsuranceFund, then the sale of the defaulter's collateral, then socialization through the cash index |
| Rounding and dust | Rounding against the actor everywhere; a minimum trade size; no position may be left below it |
| Reentrancy | Transient reentrancy guards, checks-effects-interactions, `SafeERC20`; the supported tokens are plain ERC-20s without transfer hooks |
| Unbounded loops | At most 256 positions and 8 underlyings per subaccount; at most 64 rounds per volatility update; a bounded phase search |
| Parameter abuse | Hard-coded bounds on every setter, a timelock, an immutable feed per underlying, a guardian limited to pausing opening |
| Kernel math errors | Three-way bit parity with a Python reference and the Solidity twin, a differential fuzz, property tests and mutation checks |
| Malformed calldata to the kernel | The kernel's decoder applies Solidity's ABI checks (head size, offsets and lengths below 2^64, arrays inside calldata, canonical booleans) and reverts with empty data |
| Stylus-specific risks | Checked arithmetic (256-bit integer types wrap silently otherwise), no floating point, no `block.number`, the 365-day program expiry documented; the `ruint` advisory RUSTSEC-2025-0137 carried by stylus-sdk is noted and tracked |
| Chainlink aggregator upgrade | Settlement accepts a phase change as proof; volatility tracking rebases to the new phase once the old one is exhausted |

## Issues found and fixed in internal review

Every module went through a separate adversarial review before merge. The table lists the findings that changed behavior; the exploitable ones came with proof-of-concept tests, which now run as regression tests. The `TradeLogic` and collateral fixes were also checked by mutation testing: every mutant of the new rules is killed by the suite.

| Severity | Component | Issue | Fix |
|---|---|---|---|
| Critical | `TradeLogic` | **Hedge-stripping margin bypass.** A reducing side was exempt from the IM check whenever its equity didn't fall, without checking the worst-case loss. Selling the long leg of a call spread at mark keeps equity flat while the worst-case loss explodes: a healthy account could make itself liquidatable, and an underwater one could strip its hedge and leave bad debt while a colluding counterparty kept the upside. | The exemption now requires both `lossIM` not rising and equity (fee aside) not falling. While opening is blocked, a reducing side may not raise `lossIM` at all. Commit `61e45ff`; tests `test_healthySpreadCannotShedLongLeg`, `test_underwaterHedgeStripReverts`, `test_hedgeSaleBlockedWhileOpeningBlocked` |
| High | `TradeLogic` | **Agent value drain.** An agent could give the account's long options away at a premium of zero. Risk fell and a zero premium is under any premium cap, so every budget check passed. | Every agent-acted side may cost the account at most `maxPremiumPerTrade` of equity against the kernel mark (`AgentValueDrainExceeded`). Commit `61e45ff`; tests `test_agentCannotGiveLongsAway`, `test_agentValueDrainCap` |
| High | `MarketDataHub` | **Settlement bricked by a feed phase change.** If Chainlink moved the proxy to a new aggregator after the close, the hint's next round never appears in the old phase and the latest round sits in the new phase, so no proof could pass. With no admin override, that expiry could never settle. | Proof (iii) accepts a phase change after the close, and a 72-hour oracle-only fallback covers a stale or implausible pre-close print. Commit `2a80d42`; tests `test_settlementAcrossPhaseChange`, `test_fallbackAcrossPhaseBoundary` and the `test_fallback*` suite |
| Medium | `MarketDataHub` | **Same-second settlement race.** The latest-round proof was accepted at exactly the close timestamp, when a round printed in that same second could still be added and would be the true last print. | The latest-round proof requires the current time to be strictly after the close. Commit `2a80d42`; test `test_settlementSameSecondRace` |
| Medium | `Clearinghouse`, `MarginLogic` | **Unpriceable-collateral griefing.** Anyone could deposit one wei of an enabled stock token whose feed couldn't be priced into any account. The margin check then reverted, which blocked the victim's withdrawals; an underwater owner could do the same to their own account to avoid liquidation. | Deposits of a stock token require a price. A collateral-only underlying without a price is valued at 0 and left out of the kernel input. Only the hub's own price errors are absorbed, so starving the call of gas can't make collateral disappear. Commit `00a780d`; tests `test_depositRejectsUnpriceableCollateral`, `test_unpriceableCollateralCannotHideLiquidation`, `test_onlyPriceErrorsAreAbsorbed` |
| Low | Kernel ABI decoder | **Offset wraparound.** An array offset close to 2^64 made the decoder's 64-bit bound check `pos + 31 >= end` wrap, and the decoder indexed out of bounds. The program trapped, so the call still reverted, but by accident rather than by a check. | Saturating addition, matching Solidity's 256-bit check. Commit `1334930`; test `malformed_calldata_reverts_empty` now covers offsets `2^64 - k` for `k` from 1 to 31 on every array |

Smaller issues found in the same reviews or while implementing:

- **Position flips.** Treating long 10 to short 10 as a reduction would have let a flip bypass the pause, the halt, the deficit gate, the IM check and the agent budget. A flip counts as opening (`test_flipCountsAsOpening`).
- **Feed and token misbehavior.** A token whose `paused()` reverts or returns short data, a feed with more than 18 decimals or a future timestamp could make `session()` revert, which would also block risk-reducing trades. Each case now reads as HALTED (`2a80d42`).
- **Volatility-poke griefing.** Front-running a keeper's batch of rounds made the batch revert. Already processed rounds are now skipped (`2a80d42`, `test_pokeVolSkipsAlreadyProcessedRounds`).
- **Sub-unit settlement shortfalls.** The InsuranceFund pays whole USDG units, so a shortfall of a fraction of a unit would have stayed pending and frozen every claim of the expiry. The bridge request rounds up to a whole unit, and the defaulter owes the rounded amount (`test_bridgeRoundsUpToTokenUnit`).
- **Dust blocking socialization.** A one-unit USDG donation to a defaulted account would have blocked socialization forever. Socialization sweeps the account's cash into its deficit first (`test_socializeSweepsDonatedCashFirst`).
- **Impaired pool overpayment.** A pro-rata claim on an impaired pool could exceed the claim itself while a long-only account was still unsettled. Payouts are capped at the claim (`test_impairedClaimNeverExceedsClaim`).
- **Equity dip after settlement.** Once `settleAccount` turned a receiver's payoff into a claim, the claim didn't count toward equity until it was paid. Since anyone can call `settleAccount`, a third party could settle a receiver early and push an account with other positions toward liquidation. Unpaid claims now count at face (`27559b4`, `test_thirdPartySettleCannotMakeReceiverLiquidatable`).
- **Governance bricking.** A zero timelock or setup-admin address would have locked parameters forever. The constructors reject zero addresses (`0b37daa`).

## Known limitations

- **No external audit.** The review described above was internal.
- **Liquidation is in development.** Until the AuctionHouse ships, under-margined accounts are not liquidated and a defaulter's collateral can't be sold.
- **Cumulative agent drain.** The value-drain cap applies per trade, so many trades can add up to more than one cap. Owners should size `maxPremiumPerTrade` and the policy expiry with that in mind.
- **Oracle outages.** While a feed returns no usable price (unreadable, zero or outside the plausibility band), collateral-only holdings of that token count as 0, which can make an honest account liquidatable. An account with options on that underlying can't withdraw, trade or be liquidated until the feed recovers. A stale feed still prices; it halts opening and widens margin instead.
- **Settlement prices can be hours old.** Settlement uses the last print at or before the close; on 2026-09-18 that was 08:22 ET for SPY. If the pre-close print is stale and the first post-close print is implausible, no proof can pass: that underlying's expiry stays unsettled and the claims of the expiry stay frozen. This follows from having no admin override.
- **Dust can delay socialization.** One wei of a stock token deposited into a defaulted account makes `socializeRemainder` wait until the deficit sale sells it.
- **Impaired pools.** If a long-only account settles after impaired claims have started, early claimants are paid in full and later ones share what is left. Unpaid claims count toward equity at face even when their pool is impaired; the claim realizes the haircut.
- **What-if versus ledger.** `marginAfter` can accept a ninth underlying that the ledger then refuses while an expired, settled position is still open. The trade reverts, so the error is in the safe direction.
- **Weekend auctions are paused.** A gap larger than the weekend shock can create bad debt, which goes through the waterfall.
- **Mark volatility is realized, not implied.**
- **Stylus program expiry.** If the program expires, every margin check fails, which stops trading and margin-checked withdrawals until it is re-activated.
- **Issuer powers.** A blocklisted clearinghouse address or a paused token stops transfers of that token; an `adminBurn` from the clearinghouse would break the collateral-backing invariant.
- **Calendar horizon.** The NYSE holiday table covers 2026 and 2027; later years need a new deployment.
- **Testnet build.** The deployed testnet kernel predates the decoder fix above and will be redeployed. The testnet mocks are writable by anyone ([MOCKS.md](MOCKS.md)).
- **Gas per trade.** A trade runs two to four kernel evaluations; the Solidity that gathers each account's positions adds gas that grows with the book.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private vulnerability reporting on this repository (the **Security** tab, then **Report a vulnerability**). Include the affected contract or file, the impact, and a proof of concept if you have one. Please don't open a public issue for a security problem.
