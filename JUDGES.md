# Guide for judges

This page is a five-minute path through Novation: what to read first, what to check on-chain, which code carries the risk, and which tests to run. Every number quoted here is sourced in [CLAIMS.md](CLAIMS.md).

- **Live demo:** _link added before submission_ <!-- FILL: live demo URL -->
- **Video:** _link added before submission_ <!-- FILL: demo video URL -->

## The claim in one paragraph

Novation is an options clearinghouse for Robinhood Chain stock tokens that margins each account as one portfolio. Every margin check re-prices the account's whole book, options and stock collateral, across 39 price and volatility scenarios, with scenario widths that follow the NYSE calendar (wider over weekends, holidays and halts). The re-pricing runs in a Stylus program written in Rust. Against a hand-optimized Solidity implementation of the same computation it uses 14.7x less gas at 32 positions and 17.6x less at 256; for a large book, the Solidity version doesn't fit in an Arbitrum transaction at all.

## Five-minute path

### Minute 1: read the headline

Read the [gas section of the README](README.md#the-margin-check-that-doesnt-fit-in-an-evm-transaction), then the [summary of docs/gas.md](docs/gas.md#summary). The headline uses the conservative baseline; the 100x figure against the checked Solidity twin is context only.

### Minute 2: check the kernel on-chain

Both kernels are deployed on Robinhood Chain testnet. With [Foundry](https://getfoundry.sh) installed, price a one-week at-the-money call (spot 100, 50% volatility, 4% rate) on each:

```bash
RPC=https://rpc.testnet.chain.robinhood.com
SIG="bsQuote(uint256,uint256,uint256,uint256,int256,bool)(uint256,int256,uint256,uint256,int256)"
ARGS="100000000000000000000 100000000000000000000 604800 500000000000000000 40000000000000000 true"
cast call 0xAeE1D4F45AF43a9C4d52ADa65d423b1c0e67f0fd "$SIG" $ARGS --rpc-url $RPC
cast call 0xB7d9232c8ff46b4950d85ed639908c86C08750C6 "$SIG" $ARGS --rpc-url $RPC
```

Both print the same five integers: price `2799286508567388966` (2.80 USDG), then delta, gamma, vega and theta. The first address is the Stylus program, the second its Solidity twin.

To compare full margin calls and their gas, run the parity script from a clone of the repo:

```bash
pip install requests eth-abi eth-utils
python tools/stylus-deploy/parity.py --rpc https://rpc.testnet.chain.robinhood.com
```

It prints `EQUAL` for five cases, `PARITY OK`, then `eth_estimateGas` for four books. On 2026-10-01 a 32-position book took 269,605 gas on Stylus and 22,099,291 on the Solidity twin, and the 256-position book took 1,671,146 on Stylus while the Solidity twin exceeded the RPC's 50M allowance.

### Minutes 3 and 4: read the code that carries the risk

| File | What to look at |
|---|---|
| [`kernel/src/margin.rs`](kernel/src/margin.rs) | The 39-scenario grid and the IM aggregation in Rust |
| [`contracts/src/kernel/KernelReference.sol`](contracts/src/kernel/KernelReference.sol) | The same algorithm in 160 lines of Solidity, easier to read first |
| [`contracts/src/core/logic/TradeLogic.sol`](contracts/src/core/logic/TradeLogic.sol) | `_checkMargin` (the pure-reduction rule) and `_checkBudget` (agent risk budgets) |
| [`contracts/src/core/logic/MarginLogic.sol`](contracts/src/core/logic/MarginLogic.sol) | `_underlying`: the session-scaled shock range; `_spot`: how an unpriceable token is handled |
| [`contracts/src/core/MarketDataHub.sol`](contracts/src/core/MarketDataHub.sol) | `_evaluate` (every halt fails closed) and `settlementPrice` (the proofs) |
| [`contracts/src/core/logic/SettlementLogic.sol`](contracts/src/core/logic/SettlementLogic.sol) | The expiry pool and the default waterfall |
| [`contracts/src/core/RiskParams.sol`](contracts/src/core/RiskParams.sol) | The hard-coded bounds on every parameter |

[SECURITY.md](SECURITY.md#issues-found-and-fixed-in-internal-review) lists the issues found and fixed in review, each with the commit and the regression test, starting with a critical margin bypass in `TradeLogic`.

### Minute 5: run the tests

```bash
git submodule update --init --recursive
cd contracts && forge test
cd ../kernel && cargo test --test parity
```

`forge test` runs the Solidity suites: margin, trading and agent budgets, settlement and the waterfall, the market-data halts and settlement proofs, RFQ signatures, the vaults, and the shared parity vectors. `cargo test --test parity` checks the Rust kernel against the same vectors, integer for integer.

## Addresses

Robinhood Chain testnet, chain id 46630. Full list: [docs/deployments.md](docs/deployments.md).

| Contract | Address |
|---|---|
| Risk kernel (Stylus) | [`0xAeE1D4F45AF43a9C4d52ADa65d423b1c0e67f0fd`](https://explorer.testnet.chain.robinhood.com/address/0xAeE1D4F45AF43a9C4d52ADa65d423b1c0e67f0fd) |
| KernelReference (Solidity twin) | [`0xB7d9232c8ff46b4950d85ed639908c86C08750C6`](https://explorer.testnet.chain.robinhood.com/address/0xB7d9232c8ff46b4950d85ed639908c86C08750C6) |
| Hand-optimized Solidity gas baseline | [`0x9F5a98A1E678b124998328cfa0056c90720ceCEe`](https://explorer.testnet.chain.robinhood.com/address/0x9F5a98A1E678b124998328cfa0056c90720ceCEe) |
| RiskParams | [`0xeCEA04998e34250FAf5267886f764A84Eb22450f`](https://explorer.testnet.chain.robinhood.com/address/0xeCEA04998e34250FAf5267886f764A84Eb22450f) |
| MarketDataHub | [`0xDf0045dB247DEcFab97324c62B6a4fC8d85D7fE8`](https://explorer.testnet.chain.robinhood.com/address/0xDf0045dB247DEcFab97324c62B6a4fC8d85D7fE8) |
| SeriesRegistry | [`0x06a923dD90eA046Ef873d78A7e6CeAeF628fFA18`](https://explorer.testnet.chain.robinhood.com/address/0x06a923dD90eA046Ef873d78A7e6CeAeF628fFA18) |
| InsuranceFund | [`0x407Ec2670121e0CFE05fAce426c5bFeedCB83FDb`](https://explorer.testnet.chain.robinhood.com/address/0x407Ec2670121e0CFE05fAce426c5bFeedCB83FDb) |
| Clearinghouse (with MarginLogic, TradeLogic, SettlementLogic, AuctionHookLogic) | [`0x007dEfb27a1CE2410fec787eFdacbDBa90E08901`](https://explorer.testnet.chain.robinhood.com/address/0x007dEfb27a1CE2410fec787eFdacbDBa90E08901) |
| AuctionHouse | [`0x9a09Aaa2383369a46b6EE5dc9910253D3E021c37`](https://explorer.testnet.chain.robinhood.com/address/0x9a09Aaa2383369a46b6EE5dc9910253D3E021c37) |
| RfqVenue | [`0x8c0672d04766D06B432B29ab91B660b2Da87cE06`](https://explorer.testnet.chain.robinhood.com/address/0x8c0672d04766D06B432B29ab91B660b2Da87cE06) |
| CoveredCallVault NVDA | [`0xf6719179446cb08696aa1b92472489B846741278`](https://explorer.testnet.chain.robinhood.com/address/0xf6719179446cb08696aa1b92472489B846741278) |
| CoveredCallVault TSLA | [`0x25D4639DEBcFf9777bf0dB7955438C6070C27F47`](https://explorer.testnet.chain.robinhood.com/address/0x25D4639DEBcFf9777bf0dB7955438C6070C27F47) |
| PutWriteVault NVDA | [`0xB582CEfC59751798825E5018067F7E37bbc167c8`](https://explorer.testnet.chain.robinhood.com/address/0xB582CEfC59751798825E5018067F7E37bbc167c8) |
| TimelockController (60 s on testnet) | [`0xC010e18c0d35B99Df36eB8Ea0A070F62CF68Bf32`](https://explorer.testnet.chain.robinhood.com/address/0xC010e18c0d35B99Df36eB8Ea0A070F62CF68Bf32) |

## What is not done yet

- The keeper, the TypeScript SDK, the MCP server for agents and the indexer are in development; the web app is in progress in `app/`.
- Nothing is on Robinhood Chain mainnet yet, and testnet uses mock tokens and mirrored feeds ([MOCKS.md](MOCKS.md)).
- The code is internally reviewed and not externally audited.

## Where to go next

- [docs/risk-model.md](docs/risk-model.md): the scenario grid, sessions, the volatility estimator, settlement proofs and the waterfall
- [docs/gas.md](docs/gas.md): every gas number with its method and date
- [SECURITY.md](SECURITY.md): trust model, invariants, threats, review history, known limits
- [CLAIMS.md](CLAIMS.md): each public claim with its evidence tier
- [MOCKS.md](MOCKS.md): what is mocked on testnet and what is real
