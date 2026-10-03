# Guide for judges

This page is a five-minute path through Novation: what to read first, what to check on-chain, which code carries the risk, and which tests to run. Every number quoted here is sourced in [CLAIMS.md](CLAIMS.md).

- **Live demo:** [novation-clearing.vercel.app](https://novation-clearing.vercel.app). The site runs on a demo snapshot computed with the kernel reference; the app in this repository adds a live testnet mode. The on-chain proofs below are on testnet.
- **Video:** [youtu.be/24Diq8aGN3s](https://youtu.be/24Diq8aGN3s) (3 minutes)

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

`forge test` runs the Solidity suites: margin, trading and agent budgets, settlement and the waterfall, the market-data halts and settlement proofs, RFQ signatures, the vaults, liquidations and deficit sales, the shared parity vectors and a campaign of the 18-invariant stateful suite. On the release tree it runs 413 tests: 412 pass and 1 is skipped (the mainnet fork suite, which passes 5/5 with `RH_MAINNET_RPC` set). `cargo test --test parity` checks the Rust kernel against the same vectors, integer for integer.

## Addresses

Robinhood Chain testnet, chain id 46630. The core contracts are immutable, so each fix after review shipped as a fresh core deployment; the table is the current stack, which runs the final reviewed code. Full list, the earlier stacks and why they exist: [docs/deployments.md](docs/deployments.md).

| Contract | Address |
|---|---|
| Risk kernel (Stylus) | [`0xAeE1D4F45AF43a9C4d52ADa65d423b1c0e67f0fd`](https://explorer.testnet.chain.robinhood.com/address/0xAeE1D4F45AF43a9C4d52ADa65d423b1c0e67f0fd) |
| KernelReference (Solidity twin) | [`0xB7d9232c8ff46b4950d85ed639908c86C08750C6`](https://explorer.testnet.chain.robinhood.com/address/0xB7d9232c8ff46b4950d85ed639908c86C08750C6) |
| Hand-optimized Solidity gas baseline | [`0x9F5a98A1E678b124998328cfa0056c90720ceCEe`](https://explorer.testnet.chain.robinhood.com/address/0x9F5a98A1E678b124998328cfa0056c90720ceCEe) |
| RiskParams | [`0x569768651DbB577Dcda4547e9B177f702b6F1D00`](https://explorer.testnet.chain.robinhood.com/address/0x569768651DbB577Dcda4547e9B177f702b6F1D00) |
| MarketDataHub | [`0x42894B89a9fC7aFe3bD12555CAc20b6695a5ed9C`](https://explorer.testnet.chain.robinhood.com/address/0x42894B89a9fC7aFe3bD12555CAc20b6695a5ed9C) |
| SeriesRegistry | [`0x079f744c046F7C1fCc43b1Fe5124513637d19dA8`](https://explorer.testnet.chain.robinhood.com/address/0x079f744c046F7C1fCc43b1Fe5124513637d19dA8) |
| InsuranceFund | [`0x295FB7eB9dcE936190567032C72697FaCEAdb96C`](https://explorer.testnet.chain.robinhood.com/address/0x295FB7eB9dcE936190567032C72697FaCEAdb96C) |
| Clearinghouse (with MarginLogic, TradeLogic, SettlementLogic, AuctionHookLogic) | [`0x397dc6b74003172C27297520E98472C5fd168238`](https://explorer.testnet.chain.robinhood.com/address/0x397dc6b74003172C27297520E98472C5fd168238) |
| AuctionHouse | [`0x2775a3feECA95a29141A9d3903b1C8fABa2B4658`](https://explorer.testnet.chain.robinhood.com/address/0x2775a3feECA95a29141A9d3903b1C8fABa2B4658) |
| RfqVenue | [`0xcD5d78984A2ebe76D7B09C8304E79a078B93D328`](https://explorer.testnet.chain.robinhood.com/address/0xcD5d78984A2ebe76D7B09C8304E79a078B93D328) |
| CoveredCallVault NVDA | [`0xAC989aF37744FeB96Cad8d553e7321a8b5b1D5d9`](https://explorer.testnet.chain.robinhood.com/address/0xAC989aF37744FeB96Cad8d553e7321a8b5b1D5d9) |
| CoveredCallVault TSLA | [`0x55E624783C129721Bd8735D1E4Ef1E5c06BE708A`](https://explorer.testnet.chain.robinhood.com/address/0x55E624783C129721Bd8735D1E4Ef1E5c06BE708A) |
| PutWriteVault NVDA | [`0xa47A07846902bDB8cE5306C1F851278447f3e237`](https://explorer.testnet.chain.robinhood.com/address/0xa47A07846902bDB8cE5306C1F851278447f3e237) |
| TimelockController (60 s on testnet) | [`0xe3a0D2Dd94607f86d9641571B5fe328a274C4030`](https://explorer.testnet.chain.robinhood.com/address/0xe3a0D2Dd94607f86d9641571B5fe328a274C4030) |

## Transactions to check

| What | Transaction | Stack |
|---|---|---|
| A vault buy, margined by the Stylus kernel | [`0xe3b1dc0f…`](https://explorer.testnet.chain.robinhood.com/tx/0xe3b1dc0f7ab30332db2e96f82cd7b478ff3082485d0f993f9600c041f182a9ff) | current |
| An RFQ fill of a signed maker quote | [`0x37e5459e…`](https://explorer.testnet.chain.robinhood.com/tx/0x37e5459edea8d90290033d8747d5671e669f7614353af01ce62e24f9876a0192) | current |
| An agent over its risk budget: reverted `AgentRiskBudgetExceeded` | [`0x7b91ebf4…`](https://explorer.testnet.chain.robinhood.com/tx/0x7b91ebf435f1c2e3f57d65dc06d0e01e88ed48d2b9fcfe1a862ed5c677826afb) | current |
| A withdrawal below initial margin: reverted `InsufficientMargin` | [`0x96b225d4…`](https://explorer.testnet.chain.robinhood.com/tx/0x96b225d4cef0e2c30fb00da1b406e30799b16be5342edb2f6bb363459175edb5) | current |
| An opening during a corporate action: reverted `OpeningNotAllowed` | [`0xae5f3ea5…`](https://explorer.testnet.chain.robinhood.com/tx/0xae5f3ea5f320c91d36334a53d56e90cb2e203f8933b454bba396bbc8f6fc32cf) | current |
| The keeper settles the Oct 2 expiry 16 minutes after the close: `settleExpiry` NVDA, the payer first, the vault's roll, a claim | [`0xdc08998d…`](https://explorer.testnet.chain.robinhood.com/tx/0xdc08998d8ddea08197e4b0efa2057b4ef23e59a80a95cfb88bc28fc976c79afa), [`0xf303523f…`](https://explorer.testnet.chain.robinhood.com/tx/0xf303523f00cbb362c3d3edf5f2351612fe13e5e4ab9ce16c5576e8fc337aef35), [`0x37509f39…`](https://explorer.testnet.chain.robinhood.com/tx/0x37509f3958172e139017b726222a2ba79fa094d75c0881847b798af4c68b4411), [`0x1561dcd3…`](https://explorer.testnet.chain.robinhood.com/tx/0x1561dcd3964a1f2be8508335cde79d98af2b46aeed6521043393c832f315f3b0) | 2 |
| An AI agent through the MCP server: the over-budget ticket, mined as a revert | [`0x43941aae…`](https://explorer.testnet.chain.robinhood.com/tx/0x43941aae0c18d7d004d052fd4baa72ccbb74fddd9ffe0d9e6d4dcb57407b42fe) | 2 |
| A fill of a quote served by the market maker | [`0x594f2c80…`](https://explorer.testnet.chain.robinhood.com/tx/0x594f2c802ebcb359d230d3bca807f854550b6d1bee466827bd6e97f69dc2d3ae) | 2 |
| Weekend margin, Friday leg: the trade clears in the regular session | [`0x39e7db43…`](https://explorer.testnet.chain.robinhood.com/tx/0x39e7db43cd5bdc5bd11c5ca349fff37bc4d692247438c695963a672e472e051f) | 2 |
| Weekend margin, Saturday leg: the twin's identical fill is refused under weekend shocks (`InsufficientMargin`, IM 582.92 vs equity 407.00) | [`0x6562a49e…`](https://explorer.testnet.chain.robinhood.com/tx/0x6562a49e1176f72920201285be4672101ba417a2d0fc0a482c0b7294434637f3) | 2 |
| Mainnet: the kernel program's CREATE (activation refused, see below) | [`0x154dd531…`](https://robinhoodchain.blockscout.com/tx/0x154dd53142d61126f6f9ca7a2c0cbc0322470853bf259d5628c26ba934706d61) | mainnet |

## What is not done yet

- **Mainnet.** The kernel program is deployed on Robinhood Chain mainnet, but its activation was rejected by chain policy on 2026-10-02 during the Arbitrum Security Council's emergency pause of new Stylus activations. No core contract is on mainnet; `tools/deploy/deploy-mainnet.sh` deploys it in one command once activations resume. The mainnet fork suite runs the core against the real tokens and feeds (5/5).
- **An indexer.** The live app shows empty states for history the chain doesn't keep (NAV series, epochs, halt episodes).
- **The deployed site** runs the demo snapshot; the live testnet mode is in this repository.
- **An external audit.** The code is internally reviewed and not externally audited. Testnet uses mock tokens and mirrored feeds ([MOCKS.md](MOCKS.md)).

## Where to go next

- [docs/risk-model.md](docs/risk-model.md): the scenario grid, sessions, the volatility estimator, settlement proofs and the waterfall
- [docs/deployments.md](docs/deployments.md): every testnet stack, its proofs, and the mainnet status and runbook
- [docs/gas.md](docs/gas.md): every gas number with its method and date, including the worst-case liquidation bid
- [SECURITY.md](SECURITY.md): trust model, invariants, threats, review history, known limits
- [CLAIMS.md](CLAIMS.md): each public claim with its evidence tier
- [MOCKS.md](MOCKS.md): what is mocked on testnet and what is real
- [mcp/README.md](mcp/README.md): the MCP server for AI agents under an on-chain risk budget, with an over-budget agent trade refused on testnet ([`0x43941aae…`](https://explorer.testnet.chain.robinhood.com/tx/0x43941aae0c18d7d004d052fd4baa72ccbb74fddd9ffe0d9e6d4dcb57407b42fe))
- [keeper/README.md](keeper/README.md), [mm-bot/README.md](mm-bot/README.md): the keeper and the RFQ market maker
