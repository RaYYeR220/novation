# Claims and evidence

This page lists every public claim Novation makes, with the evidence behind it and the tier of that evidence. If a number appears in the README, the docs or the demo, it should be here; if it isn't, treat it as unsupported and tell us.

| Tier | Meaning |
|---|---|
| REPRODUCIBLE | Follows from the code in this repository. A test or script reproduces it on your machine. |
| VERIFIED-LIVE | Observable on a public chain. The evidence is an address, a transaction or a read call anyone can repeat. |
| MODELED | A calculation or argument built on measured inputs, not a direct observation. |
| NOT-CLAIMED | Something we deliberately don't claim, listed at the end. |

## Margin engine and gas

| # | Claim | Tier | Evidence |
|---|---|---|---|
| 1 | The Stylus kernel and the Solidity twin `KernelReference` return identical integers for identical inputs, including revert data. | REPRODUCIBLE, VERIFIED-LIVE | `cargo test --test parity` and `forge test --match-contract KernelReference` (shared vectors from the Python reference in `tools/ref/`); [`kernel/bench/fuzz_vs_solidity.py`](kernel/bench/fuzz_vs_solidity.py), 5,100 random calls with no difference; [`tools/stylus-deploy/parity.py`](tools/stylus-deploy/parity.py) against the deployed contracts printed `PARITY OK` on 2026-10-01 |
| 2 | One `margin()` call on the Stylus kernel uses 14.7x less execution gas than hand-optimized Solidity at 32 positions and 17.6x less at 256. The headline rounds this to about 15x. | VERIFIED-LIVE | [docs/gas.md](docs/gas.md#headline-comparison). Measured on Robinhood Chain testnet with `gasleft()` probes: the kernel on 2026-09-30 ([`kernel/bench/gas_probe.py`](kernel/bench/gas_probe.py)), the baseline contract [`0x9F5a98A1E678b124998328cfa0056c90720ceCEe`](https://explorer.testnet.chain.robinhood.com/address/0x9F5a98A1E678b124998328cfa0056c90720ceCEe) on 2026-09-25. The baseline's source is not yet published in this repository. |
| 3 | Marginal cost per position: about 5,000 gas on the Stylus kernel, 92,452 in hand-optimized Solidity. | VERIFIED-LIVE | Same measurements as claim 2 |
| 4 | Transaction-level estimates on the deployed kernels: 262,876 gas (Stylus) against 22,092,627 (`KernelReference`) for a 32-position book on 2026-09-30, and 269,605 against 22,099,291 on 2026-10-01. A 256-position book takes 1,664,367 to 1,671,146 on Stylus; `KernelReference` exceeds the RPC's 50M call allowance. On the kernel redeployed from the current source (2026-10-01): 262,182 against 22,091,869 at 32 positions, and 1,663,710 at 256. | VERIFIED-LIVE | `python tools/stylus-deploy/parity.py --rpc https://rpc.testnet.chain.robinhood.com`. Values move by a few thousand gas with the L1 data fee. |
| 5 | Against the checked Solidity twin the kernel is about 100x cheaper at 32 positions (106.6x execution gas, 84x per transaction). Context only, not the headline. | VERIFIED-LIVE | Claims 2 and 4 |
| 6 | A single hand-optimized Solidity evaluation reaches Arbitrum's 32M per-transaction limit at about 345 positions. | VERIFIED-LIVE | On 2026-09-25 an `eth_call` capped at 32,000,000 gas succeeded at 344 positions and ran out of gas at 348 against the baseline contract |
| 7 | Closing one position in a 256-position account takes about 46.5M gas of kernel work with hand-optimized Solidity, more than one transaction can hold, and 2.6M with the Stylus kernel. | MODELED | Two measured single evaluations (2 × 23,269,339 and 2 × 1,323,108) times the evaluation count in [`TradeLogic`](contracts/src/core/logic/TradeLogic.sol) (before and after the trade for a reducing side). Kernel gas only; no such transaction was sent. |
| 8 | The kernel fits Stylus's 24,576-byte limit: 24,085 bytes deployed from the current source (the earlier 23,997-byte build predates the decoder hardening). | VERIFIED-LIVE, REPRODUCIBLE | The deployed code at [`0xAeE1…f0fd`](https://explorer.testnet.chain.robinhood.com/address/0xAeE1D4F45AF43a9C4d52ADa65d423b1c0e67f0fd); `python tools/stylus-deploy/deploy.py --check-size kernel/target/wasm32-unknown-unknown/release/novation_kernel.wasm` after a release build |
| 9 | `bsQuote` costs 26,411 gas on Stylus against 36,306 on `KernelReference`; `ewmaUpdate` over 19 rounds costs 29,153 against 104,499. | VERIFIED-LIVE | `gas_probe.py` on Robinhood Chain testnet, 2026-09-30 |
| 10 | One Black-Scholes price alone is cheaper in Solidity than through an uncached Stylus call (26,891 against 46,495 L2 gas), which is why vaults quote single options in Solidity. | VERIFIED-LIVE | Baseline measurements of 2026-09-25 ([docs/gas.md](docs/gas.md#other-kernel-functions)) |

## Risk model and protocol behavior

| # | Claim | Tier | Evidence |
|---|---|---|---|
| 11 | Every margin check re-prices the account's whole book, options and stock collateral, across 39 scenarios (13 price points × 3 volatility points). | REPRODUCIBLE | [`KernelReference.sol`](contracts/src/kernel/KernelReference.sol), [`kernel/src/margin.rs`](kernel/src/margin.rs), `test_vectors_books` |
| 12 | Margin widens with the trading session: 1.2x in extended hours, 1.75x over weekends and holidays, 2.5x when halted. | REPRODUCIBLE | `MarginLogic._underlying`; `test_shockRangeFloorAndCap`, `test_weekendMultiplierWidensLoss`. A live Friday-versus-Saturday comparison on testnet follows the core deployment. <!-- FILL: link the Friday/Saturday accountState pair once the core is deployed --> |
| 13 | Default parameters (shock multiple 3, two-day horizon, 10% minimum shock, weekend multiplier 1.75) are a sensible starting point for these underlyings. | MODELED | Chosen with the observed feed cadence and weekend gaps in mind; not backtested |
| 14 | The ratio estimator `Σr² / Σdt` is a consistent volatility estimate under deviation-triggered sampling. | MODELED | Argument in [docs/risk-model.md](docs/risk-model.md#volatility-estimator); no empirical study yet. The on-chain update matches the kernel exactly: `test_pokeVolMatchesKernel` (REPRODUCIBLE) |
| 15 | Integer Black-Scholes prices are within 2e-7 × max(S, K) of a floating-point reference; the normal CDF error is below 7.5e-8. | REPRODUCIBLE | `test_priceVsFloat`, `FixedPointMath.t.sol` vectors |
| 16 | Every halt condition fails closed: an unreadable, stale, implausible or paused input reads as HALTED. | REPRODUCIBLE | The `test_*Halts` tests in [`MarketDataHub.t.sol`](contracts/test/core/MarketDataHub.t.sol) |
| 17 | Settlement prices are proven from the feed's own round history, with four proofs and no admin override. | REPRODUCIBLE | `test_settlement*` and `test_fallback*` in `MarketDataHub.t.sol` |
| 18 | Every parameter is bounded in code, only a timelock can change it, and the guardian can only pause opening. | REPRODUCIBLE | [`RiskParams.sol`](contracts/src/core/RiskParams.sol), `RiskParams.t.sol` |
| 19 | Agent risk budgets are enforced on-chain: worst-case loss, premium per trade, value drain per trade, allowed underlyings, expiry. Agents can't withdraw. | REPRODUCIBLE | `test_agent*` in [`ClearinghouseTrade.t.sol`](contracts/test/core/ClearinghouseTrade.t.sol) |
| 20 | Below IM, a trade can only reduce risk: it can't raise the worst-case loss or give equity away. | REPRODUCIBLE | `test_healthySpreadCannotShedLongLeg`, `test_underwaterHedgeStripReverts`, `test_closingAtMarkAllowedWhenUnderwater` |
| 21 | Settlement keeps the clearinghouse solvent, claims never exceed what payers put in, and settling an account never moves its equity. | REPRODUCIBLE | `ClearinghouseSettlement.t.sol`, including the fuzz tests `test_roundingFavorsPool` and `test_waterfallSolventAtAnyIndex` |
| 22 | The issues listed in SECURITY.md were found in internal review and fixed, each with a regression test. | REPRODUCIBLE | [SECURITY.md](SECURITY.md#issues-found-and-fixed-in-internal-review): commits and test names |

## Robinhood Chain facts

| # | Claim | Tier | Evidence |
|---|---|---|---|
| 23 | Across 13 weeks of mainnet history (2026-06-22 to 2026-09-25) the NVDA, TSLA, SPY and AAPL feeds published no round on a Saturday or on a Sunday before 20:00 ET. A weekend leaves 52 to 60 hours without a price, a holiday weekend 76 to 81. | VERIFIED-LIVE | `getRoundData` on the mainnet proxies listed in [MOCKS.md](MOCKS.md#the-mainnet-mirror); every round since round 1 was read (3,250 calls) |
| 24 | There is no round at the Friday 16:00 ET close. On 2026-09-18 the last SPY print before the close was at 08:22 ET and the next at 20:00 ET on Sunday. | VERIFIED-LIVE | `cast call 0x319724394D3A0e3669269846abE664Cd621f9f6A "getRoundData(uint80)(uint80,int256,uint256,uint256,uint80)" 18446744073709551754 --rpc-url https://rpc.mainnet.chain.robinhood.com` returns `updatedAt` 1789734121 (12:22:01 UTC); round `…755` returns 1789948826 (Monday 00:00:26 UTC) |
| 25 | Contracts can hold the stock tokens: a transfer checks only a pause flag and a blocklist. The issuer can burn from any holder with `adminBurn`. | VERIFIED-LIVE | The `Stock` implementation behind the tokens' beacon, `0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2` on Robinhood Chain mainnet, verified source on Sourcify (exact match) |
| 26 | The mainnet equity feeds launched with answers 1e10 too high for about a day and a half, which is why every underlying has a plausibility band. | VERIFIED-LIVE | The rounds of 2026-06-22 and 2026-06-23 on the mainnet proxies |
| 27 | Robinhood Chain testnet has no Chainlink feeds and no official NVDA, SPY or AAPL token. | VERIFIED-LIVE | Chainlink's feed directory lists Robinhood Chain mainnet only (checked 2026-09-25); the testnet faucet distributes TSLA, AMZN, PLTR, NFLX and AMD |
| 28 | The Stylus program expires 365 days after activation. | VERIFIED-LIVE | `ArbWasm` on Robinhood Chain reports `expiryDays` 365 |

## Status

| # | Claim | Tier | Evidence |
|---|---|---|---|
| 29 | The risk kernel, `KernelReference` and the core stack (clearinghouse, market data hub, registry, risk parameters, insurance fund, auction house, RFQ venue, three vaults) are deployed on Robinhood Chain testnet, the clearinghouse wired to the Stylus kernel. | VERIFIED-LIVE | [docs/deployments.md](docs/deployments.md), [`contracts/deployments/46630.json`](contracts/deployments/46630.json) |
| 30 | The clearinghouse, market data hub, registry, risk parameters, insurance fund, RFQ venue and vaults are implemented and pass their tests. | REPRODUCIBLE, VERIFIED-LIVE | `forge test`; deployed on testnet, see [docs/deployments.md](docs/deployments.md) |
| 31 | A user deposits, buys a call from the covered-call vault, deposits into the vault and fills a signed RFQ quote on testnet, margined by the Stylus kernel. | VERIFIED-LIVE | [vault deposit](https://explorer.testnet.chain.robinhood.com/tx/0xe3c724ac5d86fcebf3a09e8fa287823a7e404bbfa201c85a637319118fc70495), [vault buy](https://explorer.testnet.chain.robinhood.com/tx/0xb980c90eae6bf5f45a19858ea7f1042c5ee893f5caac47bc3e4cd6a2efff486c), [RFQ fill](https://explorer.testnet.chain.robinhood.com/tx/0x1e985233111b657dd484db8f86c9babc95d530c28f1c08ce62a0a2c1a2c921e1); every hash in [`tools/e2e/out/46630.json`](tools/e2e/out/46630.json), produced by `python tools/e2e/scenario.py` |
| 32 | An agent's risk budget is enforced on-chain: an in-budget trade passes and an over-budget one reverts with `AgentRiskBudgetExceeded`. | VERIFIED-LIVE | [in budget](https://explorer.testnet.chain.robinhood.com/tx/0x4bc0386cb4183e19ae7ac2650ef06684f89414e8326ba0ad25ed6699f1ba9328), [over budget, reverted](https://explorer.testnet.chain.robinhood.com/tx/0xa411c8e1173e78c41e6c2f12611d553f54583cb1203eaf651bc9bc725e2c1b9a); the revert reason is confirmed by `eth_call` of the same transaction at the previous block |
| 33 | A withdrawal that would leave an account below initial margin reverts with `InsufficientMargin`. | VERIFIED-LIVE | [reverted withdrawal](https://explorer.testnet.chain.robinhood.com/tx/0xc947dc28bb91b5499f88ac89911507758d7447db5666720a8eb7d86dd77c3094); reason confirmed the same way |
| 34 | `margin()` for a 256-position book fits a transaction on Stylus and not in Solidity: under the 32M transaction cap, `eth_estimateGas` returns 1,663,660 on the Stylus kernel and fails with "gas required exceeds allowance (32000000)" on `KernelReference`. | VERIFIED-LIVE | `gasProof` in [`tools/e2e/out/46630.json`](tools/e2e/out/46630.json), 2026-10-01 |
| 35 | A pending stock-token multiplier change (a corporate action, read from ERC-8056 `effectiveAt`) halts opening on that underlying: an AAPL RFQ fill that simulated fine a block earlier reverts with `OpeningNotAllowed` once the mock token announces a 2-for-1 change inside `haltWindow`. | VERIFIED-LIVE | [announcement (mock)](https://explorer.testnet.chain.robinhood.com/tx/0x61ce8869370bd4d33eaa7654904c939eb57f880e8dc9e99eb8349211ff6e886d), [refused fill](https://explorer.testnet.chain.robinhood.com/tx/0x7756c29f080df6458613f129e8aa9b9dc5adadc3c098bb31edd04ecacb447c46); reason confirmed by `eth_call` at the previous block; the mock multiplier was reset right after |

## Not claimed

- **An external audit.** The code is internally reviewed only.
- **A mainnet deployment**, real funds, users, volume or TVL.
- **That a whole trade is 15x cheaper.** Only kernel gas is compared; the Solidity around the kernel adds gas that isn't in these numbers.
- **That portfolio margin is impossible in the EVM.** Hand-optimized Solidity margins a 64-position book in 5.95M gas. The limit concerns large books.
- **Cached Stylus performance.** Every Stylus number here is uncached, because Robinhood Chain has no CacheManager.
- **Implied volatility or market-calibrated prices.** Mark volatility is realized volatility, and vault premiums are model prices.
- **Backtested or optimal parameters.**
- **Settlement at the official NYSE closing price.** Settlement uses the last feed print at or before the close.
- **Live liquidations.** The AuctionHouse is deployed on testnet, but no liquidation or deficit sale has run there yet.
- **A finished SDK, MCP server, keeper, indexer or app.**
- **The first on-chain portfolio margin.** Derive runs portfolio margin on its own chain.
- **That no other options venue exists on Robinhood Chain.** We found none when we looked.
- **Protection against cumulative agent drain** beyond the per-trade caps.
- **Trustworthy testnet prices.** Anyone can push a round to the testnet mock feeds ([MOCKS.md](MOCKS.md)).
- **Availability to US persons or regulatory clearance** of any kind.
