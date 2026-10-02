# Guide for judges

This page is a five-minute path through Novation: what to read first, what to check on-chain, which code carries the risk, and which tests to run. Every number quoted here is sourced in [CLAIMS.md](CLAIMS.md).

- **Live demo:** [novation-clearing.vercel.app](https://novation-clearing.vercel.app). The app runs on a demo snapshot computed with the kernel reference; the on-chain proofs below are on testnet.
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
| RiskParams | [`0x113AbDCd234d00FfEA37D29A31BD1Fb2B035dcf1`](https://explorer.testnet.chain.robinhood.com/address/0x113AbDCd234d00FfEA37D29A31BD1Fb2B035dcf1) |
| MarketDataHub | [`0xEcD2baaE3C13b526ffdBB8a8388609442C84d993`](https://explorer.testnet.chain.robinhood.com/address/0xEcD2baaE3C13b526ffdBB8a8388609442C84d993) |
| SeriesRegistry | [`0x9C99381dE80518350fEaA09db17a064eD2180b7b`](https://explorer.testnet.chain.robinhood.com/address/0x9C99381dE80518350fEaA09db17a064eD2180b7b) |
| InsuranceFund | [`0x531394f5a5D0c3D9e54d258c8825Fa70Fd645429`](https://explorer.testnet.chain.robinhood.com/address/0x531394f5a5D0c3D9e54d258c8825Fa70Fd645429) |
| Clearinghouse (with MarginLogic, TradeLogic, SettlementLogic, AuctionHookLogic) | [`0x0b0F4e67DcA3B846859Af452576e8E09316D1949`](https://explorer.testnet.chain.robinhood.com/address/0x0b0F4e67DcA3B846859Af452576e8E09316D1949) |
| AuctionHouse | [`0x4a132D6f83d9db88092A3D1F8B5985B30fd99Ad9`](https://explorer.testnet.chain.robinhood.com/address/0x4a132D6f83d9db88092A3D1F8B5985B30fd99Ad9) |
| RfqVenue | [`0x1aFD874fdd3914fB6958F282769dAC546993ED82`](https://explorer.testnet.chain.robinhood.com/address/0x1aFD874fdd3914fB6958F282769dAC546993ED82) |
| CoveredCallVault NVDA | [`0xCCF205358eF9bfd97335f0D7bD5240487bB64865`](https://explorer.testnet.chain.robinhood.com/address/0xCCF205358eF9bfd97335f0D7bD5240487bB64865) |
| CoveredCallVault TSLA | [`0xF95EAbF20EE1D9034ABa1b240D0242B75e645BD5`](https://explorer.testnet.chain.robinhood.com/address/0xF95EAbF20EE1D9034ABa1b240D0242B75e645BD5) |
| PutWriteVault NVDA | [`0x0FEee896be42E954c2881668da9035efc5dB0947`](https://explorer.testnet.chain.robinhood.com/address/0x0FEee896be42E954c2881668da9035efc5dB0947) |
| TimelockController (60 s on testnet) | [`0xf60F96DF709B2dD958519329b4ab488C27e178b5`](https://explorer.testnet.chain.robinhood.com/address/0xf60F96DF709B2dD958519329b4ab488C27e178b5) |

Previous core deployment (2026-10-01, before the contract polish), still on-chain and settling its Oct 2 positions: Clearinghouse [`0xe799…ABB2`](https://explorer.testnet.chain.robinhood.com/address/0xe799DF9b96a4809c411D3F90f67C5261a245ABB2), listed under `superseded` in [`contracts/deployments/46630.json`](contracts/deployments/46630.json). Its proofs stay valid: [agent over budget](https://explorer.testnet.chain.robinhood.com/tx/0xa411c8e1173e78c41e6c2f12611d553f54583cb1203eaf651bc9bc725e2c1b9a), [withdrawal below IM](https://explorer.testnet.chain.robinhood.com/tx/0xc947dc28bb91b5499f88ac89911507758d7447db5666720a8eb7d86dd77c3094), [corporate-action halt](https://explorer.testnet.chain.robinhood.com/tx/0x7756c29f080df6458613f129e8aa9b9dc5adadc3c098bb31edd04ecacb447c46), [MCP agent refusal](https://explorer.testnet.chain.robinhood.com/tx/0x2aa5a4ceaf099d14136d921b29b5bc2bce8b52f618b25e4935b04494210f1064), [mm-bot RFQ fill](https://explorer.testnet.chain.robinhood.com/tx/0x883c803d27356c5d1a6d368090fc845b0d8a3848539cfbb85ab7c9d62e3988c5).

## What is not done yet

- The keeper and the indexer are in development; the web app is in progress in `app/`.
- Nothing is on Robinhood Chain mainnet yet, and testnet uses mock tokens and mirrored feeds ([MOCKS.md](MOCKS.md)).
- The code is internally reviewed and not externally audited.

## Where to go next

- [docs/risk-model.md](docs/risk-model.md): the scenario grid, sessions, the volatility estimator, settlement proofs and the waterfall
- [docs/gas.md](docs/gas.md): every gas number with its method and date
- [SECURITY.md](SECURITY.md): trust model, invariants, threats, review history, known limits
- [CLAIMS.md](CLAIMS.md): each public claim with its evidence tier
- [MOCKS.md](MOCKS.md): what is mocked on testnet and what is real
- [mcp/README.md](mcp/README.md): the MCP server for AI agents under an on-chain risk budget, with an over-budget agent trade refused on testnet ([`0x43941aae…`](https://explorer.testnet.chain.robinhood.com/tx/0x43941aae0c18d7d004d052fd4baa72ccbb74fddd9ffe0d9e6d4dcb57407b42fe))
