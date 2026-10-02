# Deployments

Machine-readable copies: [`contracts/deployments/46630.json`](../contracts/deployments/46630.json) (Robinhood Chain testnet) and [`contracts/deployments/4663.json`](../contracts/deployments/4663.json) (Robinhood Chain mainnet).

## Robinhood Chain testnet (chain id 46630)

Testnet has no Chainlink feeds and no official NVDA, AAPL or SPY tokens, so everything marked **MOCK** is a stand-in with no value. The mock feeds are seeded from, and kept in sync with, the real Robinhood Chain mainnet Chainlink feeds by `tools/mirror-feeds.py` ([MOCKS.md](../MOCKS.md)).

### Why there are several stacks

The core contracts are immutable: there are no proxies and no upgrade path. A fix found in review therefore ships as a fresh deployment of the core, and the earlier deployment stays on-chain with whatever it was running. Testnet holds four core stacks, deployed one after another as the review fixes landed. The mock tokens and feeds are shared by all of them. The **current** stack runs the final reviewed code; the two earlier stacks that were used keep their proof transactions, including the first expiry settlement.

| Stack | Clearinghouse | Deployed | Code |
|---|---|---|---|
| **Current** | [`0x397dc6b74003172C27297520E98472C5fd168238`](https://explorer.testnet.chain.robinhood.com/address/0x397dc6b74003172C27297520E98472C5fd168238) | 2026-10-02, block 127762103 | the final reviewed contracts |
| Stack 2 | [`0x0b0F4e67DcA3B846859Af452576e8E09316D1949`](https://explorer.testnet.chain.robinhood.com/address/0x0b0F4e67DcA3B846859Af452576e8E09316D1949) | 2026-10-02, block 127521684 | after the second review pass (in-kind vault exits, market-time auction clock, outage write-off) |
| Stack 1 | [`0xe799DF9b96a4809c411D3F90f67C5261a245ABB2`](https://explorer.testnet.chain.robinhood.com/address/0xe799DF9b96a4809c411D3F90f67C5261a245ABB2) | 2026-10-01, block 127134221 | the first published build |
| Unused | [`0x007dEfb27a1CE2410fec787eFdacbDBa90E08901`](https://explorer.testnet.chain.robinhood.com/address/0x007dEfb27a1CE2410fec787eFdacbDBa90E08901) | 2026-10-01, block 127112331 | replaced before use, after the per-bid position cap was removed |

Every address of the earlier stacks, their libraries and their proof transactions are listed under `superseded` in [`46630.json`](../contracts/deployments/46630.json).

### Current stack

| Contract | Address | Notes |
|---|---|---|
| Risk kernel (Stylus) | [`0xAeE1D4F45AF43a9C4d52ADa65d423b1c0e67f0fd`](https://explorer.testnet.chain.robinhood.com/address/0xAeE1D4F45AF43a9C4d52ADa65d423b1c0e67f0fd) | Rust/WASM, 24,085 B compressed, built from the current source and activated 2026-10-01 |
| Previous risk kernel | [`0x6d07e246eb757A1F97E3cdB7d1881ee5De27ceaA`](https://explorer.testnet.chain.robinhood.com/address/0x6d07e246eb757A1F97E3cdB7d1881ee5De27ceaA) | Built before the decoder hardening; not used by the current stack |
| KernelReference (Solidity) | [`0xB7d9232c8ff46b4950d85ed639908c86C08750C6`](https://explorer.testnet.chain.robinhood.com/address/0xB7d9232c8ff46b4950d85ed639908c86C08750C6) | Bit-exact Solidity twin, used for parity and gas comparison |
| RiskParams | [`0x569768651DbB577Dcda4547e9B177f702b6F1D00`](https://explorer.testnet.chain.robinhood.com/address/0x569768651DbB577Dcda4547e9B177f702b6F1D00) | setup finalized |
| MarketDataHub | [`0x42894B89a9fC7aFe3bD12555CAc20b6695a5ed9C`](https://explorer.testnet.chain.robinhood.com/address/0x42894B89a9fC7aFe3bD12555CAc20b6695a5ed9C) | |
| SeriesRegistry | [`0x079f744c046F7C1fCc43b1Fe5124513637d19dA8`](https://explorer.testnet.chain.robinhood.com/address/0x079f744c046F7C1fCc43b1Fe5124513637d19dA8) | 128 series listed |
| InsuranceFund | [`0x295FB7eB9dcE936190567032C72697FaCEAdb96C`](https://explorer.testnet.chain.robinhood.com/address/0x295FB7eB9dcE936190567032C72697FaCEAdb96C) | funded with 100,000 mock USDG |
| Clearinghouse (with MarginLogic, TradeLogic, SettlementLogic, AuctionHookLogic) | [`0x397dc6b74003172C27297520E98472C5fd168238`](https://explorer.testnet.chain.robinhood.com/address/0x397dc6b74003172C27297520E98472C5fd168238) | setup finalized, wired to the Stylus kernel |
| AuctionHouse | [`0x2775a3feECA95a29141A9d3903b1C8fABa2B4658`](https://explorer.testnet.chain.robinhood.com/address/0x2775a3feECA95a29141A9d3903b1C8fABa2B4658) | |
| RfqVenue | [`0xcD5d78984A2ebe76D7B09C8304E79a078B93D328`](https://explorer.testnet.chain.robinhood.com/address/0xcD5d78984A2ebe76D7B09C8304E79a078B93D328) | |
| CoveredCallVault NVDA | [`0xAC989aF37744FeB96Cad8d553e7321a8b5b1D5d9`](https://explorer.testnet.chain.robinhood.com/address/0xAC989aF37744FeB96Cad8d553e7321a8b5b1D5d9) | seeded |
| CoveredCallVault TSLA | [`0x55E624783C129721Bd8735D1E4Ef1E5c06BE708A`](https://explorer.testnet.chain.robinhood.com/address/0x55E624783C129721Bd8735D1E4Ef1E5c06BE708A) | seeded |
| PutWriteVault NVDA | [`0xa47A07846902bDB8cE5306C1F851278447f3e237`](https://explorer.testnet.chain.robinhood.com/address/0xa47A07846902bDB8cE5306C1F851278447f3e237) | seeded |
| TimelockController (60 s on testnet) | [`0xe3a0D2Dd94607f86d9641571B5fe328a274C4030`](https://explorer.testnet.chain.robinhood.com/address/0xe3a0D2Dd94607f86d9641571B5fe328a274C4030) | |
| MarginLogic | [`0x3e991293bfff1953e9C30ef7B5D2dd28083B234D`](https://explorer.testnet.chain.robinhood.com/address/0x3e991293bfff1953e9C30ef7B5D2dd28083B234D) | linked library |
| TradeLogic | [`0x53F0e60fa0Ccdd8B4A76a6961fE228498B4F9471`](https://explorer.testnet.chain.robinhood.com/address/0x53F0e60fa0Ccdd8B4A76a6961fE228498B4F9471) | linked library |
| SettlementLogic | [`0x943D999897d3833Ea76826AFf894814F82d38fA7`](https://explorer.testnet.chain.robinhood.com/address/0x943D999897d3833Ea76826AFf894814F82d38fA7) | linked library |
| AuctionHookLogic | [`0x27D6Be2eC8980721235916b7d6Ed73aaaD79C6be`](https://explorer.testnet.chain.robinhood.com/address/0x27D6Be2eC8980721235916b7d6Ed73aaaD79C6be) | linked library |
| VaultPricing | [`0x47417e1Ac7Ac31F015E06C3Af843A92C6f217D51`](https://explorer.testnet.chain.robinhood.com/address/0x47417e1Ac7Ac31F015E06C3Af843A92C6f217D51) | linked library (vault quotes) |

Deployed by `contracts/script/Deploy.s.sol` and seeded by `contracts/script/Seed.s.sol`: vol initialised for all four underlyings, calls and puts for the next two weekly expiries at spot ±5/10/15/20%, the InsuranceFund funded and a first deposit in each vault. The guardian, the timelock's proposer and executor, and the treasury are the deployer on testnet.

The end-to-end run on this stack, 2026-10-02 (every hash in [`tools/e2e/out/46630.json`](../tools/e2e/out/46630.json), produced by `python tools/e2e/scenario.py`):

| Step | Transaction | Result |
|---|---|---|
| Buy 1 NVDA call from the covered-call vault | [`0xe3b1dc0f…`](https://explorer.testnet.chain.robinhood.com/tx/0xe3b1dc0f7ab30332db2e96f82cd7b478ff3082485d0f993f9600c041f182a9ff) | filled, 987,927 gas |
| RFQ fill: the user sells 5 NVDA puts to a maker | [`0x37e5459e…`](https://explorer.testnet.chain.robinhood.com/tx/0x37e5459edea8d90290033d8747d5671e669f7614353af01ce62e24f9876a0192) | filled, 807,130 gas |
| An agent buys 1 call inside its risk budget | [`0xf4e14eef…`](https://explorer.testnet.chain.robinhood.com/tx/0xf4e14eeff6188e6259b78b3c426632912b858d6c6bd2d58c8cdedd3e0733353d) | filled |
| The agent buys 3 more calls, over its budget | [`0x7b91ebf4…`](https://explorer.testnet.chain.robinhood.com/tx/0x7b91ebf435f1c2e3f57d65dc06d0e01e88ed48d2b9fcfe1a862ed5c677826afb) | reverted `AgentRiskBudgetExceeded` |
| Withdraw past initial margin | [`0x96b225d4…`](https://explorer.testnet.chain.robinhood.com/tx/0x96b225d4cef0e2c30fb00da1b406e30799b16be5342edb2f6bb363459175edb5) | reverted `InsufficientMargin` |
| Deposit 1 NVDA into the covered-call vault | [`0xbd883651…`](https://explorer.testnet.chain.robinhood.com/tx/0xbd883651fa209ddb90f21b1149737c5465d8e467f36e32f3702efec1767a0565) | shares minted |
| AAPL announces a 2-for-1 multiplier change (mock) | [`0xe914196d…`](https://explorer.testnet.chain.robinhood.com/tx/0xe914196dced1e3627d8b3dd62658e8d9ce86733b8e04593076dbd1d6fee5ac1a) | the multiplier window opens |
| RFQ fill on AAPL inside that window | [`0xae5f3ea5…`](https://explorer.testnet.chain.robinhood.com/tx/0xae5f3ea5f320c91d36334a53d56e90cb2e203f8933b454bba396bbc8f6fc32cf) | reverted `OpeningNotAllowed` |

The revert reasons are confirmed by an `eth_call` of each transaction at the block before (`revertReplay` in the json). The same file records `gasProof`: under the 32M transaction cap, `eth_estimateGas` for `margin()` on a 256-position book returns 1,676,266 on the Stylus kernel and fails with "gas required exceeds allowance (32000000)" on `KernelReference`.

### Stack 2

Addresses under `superseded[0]` in the json. Besides its own end-to-end run (same steps as above), this stack carries:

- **The MCP agent demo** ([mcp/README.md](../mcp/README.md)): an in-budget fill through the MCP server, [`0xf1791085…`](https://explorer.testnet.chain.robinhood.com/tx/0xf17910855569d9d6fed1b5ef3676ac48599e955b3dc889ee7bdc5d7d1f109542), and the over-budget ticket sent anyway and mined as a revert with `AgentRiskBudgetExceeded`, [`0x43941aae…`](https://explorer.testnet.chain.robinhood.com/tx/0x43941aae0c18d7d004d052fd4baa72ccbb74fddd9ffe0d9e6d4dcb57407b42fe).
- **An RFQ fill of a quote served by the market maker** ([mm-bot/README.md](../mm-bot/README.md)): [`0x594f2c80…`](https://explorer.testnet.chain.robinhood.com/tx/0x594f2c802ebcb359d230d3bca807f854550b6d1bee466827bd6e97f69dc2d3ae).
- **The weekend margin proof.** Two twin accounts each hold 400 USDG and fill one maker quote: sell 5 NVDA 245 calls expiring 2026-10-09. The Friday leg cleared in the regular session, [`0x39e7db43…`](https://explorer.testnet.chain.robinhood.com/tx/0x39e7db43cd5bdc5bd11c5ca349fff37bc4d692247438c695963a672e472e051f) (2026-10-02 16:11:57 UTC): initial margin 324.06 USDG against equity 399.62 after the trade. The twin's identical fill under weekend shocks needs 588.56 USDG, 147% of its equity. The script is [`tools/e2e/weekend_proof.ts`](../tools/e2e/weekend_proof.ts).
  - **Saturday leg: pending.** The twin sends the same fill on Saturday 2026-10-03 in the WEEKEND session, expected to revert with `InsufficientMargin`. Its transaction will be added here.
- **The first expiry settlement.** The Oct 2 expiry (2026-10-02 16:00 ET) was settled by the keeper with no manual step, 16 minutes after the close: `settleExpiry` for NVDA [`0xdc08998d…`](https://explorer.testnet.chain.robinhood.com/tx/0xdc08998d8ddea08197e4b0efa2057b4ef23e59a80a95cfb88bc28fc976c79afa), the paying account 9 first [`0xf303523f…`](https://explorer.testnet.chain.robinhood.com/tx/0xf303523f00cbb362c3d3edf5f2351612fe13e5e4ab9ce16c5576e8fc337aef35), the covered-call vault's roll [`0x37509f39…`](https://explorer.testnet.chain.robinhood.com/tx/0x37509f3958172e139017b726222a2ba79fa094d75c0881847b798af4c68b4411), and account 8's claim [`0x1561dcd3…`](https://explorer.testnet.chain.robinhood.com/tx/0x1561dcd3964a1f2be8508335cde79d98af2b46aeed6521043393c832f315f3b0).

### Stack 1

Addresses under `superseded[1]`. Its proofs stay valid: [agent over budget](https://explorer.testnet.chain.robinhood.com/tx/0xa411c8e1173e78c41e6c2f12611d553f54583cb1203eaf651bc9bc725e2c1b9a), [withdrawal below IM](https://explorer.testnet.chain.robinhood.com/tx/0xc947dc28bb91b5499f88ac89911507758d7447db5666720a8eb7d86dd77c3094), [corporate-action halt](https://explorer.testnet.chain.robinhood.com/tx/0x7756c29f080df6458613f129e8aa9b9dc5adadc3c098bb31edd04ecacb447c46), the first MCP session's [mined refusal](https://explorer.testnet.chain.robinhood.com/tx/0x2aa5a4ceaf099d14136d921b29b5bc2bce8b52f618b25e4935b04494210f1064) and the first [market-maker fill](https://explorer.testnet.chain.robinhood.com/tx/0x883c803d27356c5d1a6d368090fc845b0d8a3848539cfbb85ab7c9d62e3988c5). Its keeper settled the Oct 2 expiry too: `settleExpiry` for NVDA [`0xd78516aa…`](https://explorer.testnet.chain.robinhood.com/tx/0xd78516aa7b120632b6af0f946d6126fcd9261d8c0d80c8cbff4821f6e86a4226) and account 11's claim [`0xeb761f6d…`](https://explorer.testnet.chain.robinhood.com/tx/0xeb761f6db520348bd03cfe4074d0251c92cd106768784c6d22cff2561952a1d6).

### Mock tokens (MOCK, public mint)

| Token | Address | Notes |
|---|---|---|
| MOCK USDG | [`0xfBb0e60027151cb321b936C2c71278cd08d03921`](https://explorer.testnet.chain.robinhood.com/address/0xfBb0e60027151cb321b936C2c71278cd08d03921) | MockUSDG, 6 decimals, `mint(to, amount)` open to anyone |
| MOCK NVDA | [`0xc2DBC8d95f357C2746242a497BD3170B87F77999`](https://explorer.testnet.chain.robinhood.com/address/0xc2DBC8d95f357C2746242a497BD3170B87F77999) | Mock NVIDIA, 18 decimals, `mint(to, amount)` open to anyone |
| MOCK TSLA | [`0x8F5A67fAb73bcaBD569ac1263433A2Df633b8fF5`](https://explorer.testnet.chain.robinhood.com/address/0x8F5A67fAb73bcaBD569ac1263433A2Df633b8fF5) | Mock Tesla, 18 decimals, `mint(to, amount)` open to anyone |
| MOCK AAPL | [`0x4311Cc3931f638E9f4a7b7109563e78348C95266`](https://explorer.testnet.chain.robinhood.com/address/0x4311Cc3931f638E9f4a7b7109563e78348C95266) | Mock Apple, 18 decimals, `mint(to, amount)` open to anyone |
| MOCK SPY | [`0x06774db4af357f760Dc6448C3C11b2b7aF2eBFdE`](https://explorer.testnet.chain.robinhood.com/address/0x06774db4af357f760Dc6448C3C11b2b7aF2eBFdE) | Mock SPY ETF, 18 decimals, `mint(to, amount)` open to anyone |

### Mock price feeds (MOCK, 8 decimals)

| Feed | Address | Notes |
|---|---|---|
| MOCK NVDA / USD | [`0x8E465F19Ff52DACB53B9dE3A8C42912001A664e5`](https://explorer.testnet.chain.robinhood.com/address/0x8E465F19Ff52DACB53B9dE3A8C42912001A664e5) | Chainlink-style aggregator mirroring RH mainnet NVDA/USD |
| MOCK TSLA / USD | [`0x3c57717cb77CD28e27bc57e67FB4b0DE73937d80`](https://explorer.testnet.chain.robinhood.com/address/0x3c57717cb77CD28e27bc57e67FB4b0DE73937d80) | Chainlink-style aggregator mirroring RH mainnet TSLA/USD |
| MOCK AAPL / USD | [`0x06d33Aeb7A5A44ad8af1A67bB2FEA41D62185602`](https://explorer.testnet.chain.robinhood.com/address/0x06d33Aeb7A5A44ad8af1A67bB2FEA41D62185602) | Chainlink-style aggregator mirroring RH mainnet AAPL/USD |
| MOCK SPY / USD | [`0x78d6096c09253cc7B30D324D06f8BA25C8A4265C`](https://explorer.testnet.chain.robinhood.com/address/0x78d6096c09253cc7B30D324D06f8BA25C8A4265C) | Chainlink-style aggregator mirroring RH mainnet SPY/USD |

Kernel program activation lasts 365 days; it must be re-activated before expiry.

## Robinhood Chain mainnet (chain id 4663)

**Status: the risk kernel is deployed but not activated, and no core contract is on mainnet.**

| | |
|---|---|
| Risk kernel program | [`0x6d07e246eb757A1F97E3cdB7d1881ee5De27ceaA`](https://robinhoodchain.blockscout.com/address/0x6d07e246eb757A1F97E3cdB7d1881ee5De27ceaA), the same WASM as the testnet kernel (code hash `0xa34c0177edcade5da15ac0fe4aeddb59161e76165303686f66a9eeaed27a5c8d`, 24,085 bytes) |
| CREATE | [`0x154dd531…`](https://robinhoodchain.blockscout.com/tx/0x154dd53142d61126f6f9ca7a2c0cbc0322470853bf259d5628c26ba934706d61), block 78,500,826, 2026-10-02 20:01 UTC, 5,261,543 gas |
| Activation | rejected at submission with "Transaction rejected by chain policy", 2026-10-02 around 20:00 UTC, during the Arbitrum Security Council's emergency pause of new Stylus activations announced that day. `ArbWasm.programVersion` reports `ProgramNotActivated` for the program. |
| Core | not deployed |

The program's address is the same as the previous testnet kernel's because both were the deployer's first transaction on their chain; the code differs (the mainnet program is the current one, by its code hash). The core needs an active kernel, so nothing else was deployed. `4663.json` records the kernel and the real mainnet tokens and Chainlink proxies the core deploy reads:

| Asset | Token | Chainlink proxy |
|---|---|---|
| USDG | [`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`](https://robinhoodchain.blockscout.com/address/0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168) (6 decimals) | |
| NVDA | [`0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC`](https://robinhoodchain.blockscout.com/address/0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC) | [`0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15`](https://robinhoodchain.blockscout.com/address/0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15) |
| TSLA | [`0x322F0929c4625eD5bAd873c95208D54E1c003b2d`](https://robinhoodchain.blockscout.com/address/0x322F0929c4625eD5bAd873c95208D54E1c003b2d) | [`0x4A1166a659A55625345e9515b32adECea5547C38`](https://robinhoodchain.blockscout.com/address/0x4A1166a659A55625345e9515b32adECea5547C38) |
| AAPL | [`0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9`](https://robinhoodchain.blockscout.com/address/0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9) | [`0x6B22A786bAa607d76728168703a39Ea9C99f2cD0`](https://robinhoodchain.blockscout.com/address/0x6B22A786bAa607d76728168703a39Ea9C99f2cD0) |
| SPY | [`0x117cc2133c37B721F49dE2A7a74833232B3B4C0C`](https://robinhoodchain.blockscout.com/address/0x117cc2133c37B721F49dE2A7a74833232B3B4C0C) | [`0x319724394D3A0e3669269846abE664Cd621f9f6A`](https://robinhoodchain.blockscout.com/address/0x319724394D3A0e3669269846abE664Cd621f9f6A) |

**Tested against mainnet without deploying.** The fork suite ([`contracts/test/fork/RobinhoodFork.t.sol`](../contracts/test/fork/RobinhoodFork.t.sol)) forks the latest mainnet block and deploys the core against these real tokens and feeds: spot sanity on all four feeds, the hub's session against the calendar, the ERC-8056 getters of the real tokens, the feeds' round semantics, and a covered-call vault cycle through settlement. It passes 5/5:

```bash
cd contracts && RH_MAINNET_RPC=https://rpc.mainnet.chain.robinhood.com forge test --match-path "test/fork/*"
```

**Going live once activations resume** takes one command, from a checkout with `DEPLOYER_PRIVATE_KEY` and `RH_MAINNET_RPC` in `.env`:

```bash
bash tools/deploy/deploy-mainnet.sh              # simulation: prices the activation and simulates Deploy.s.sol, sends nothing
bash tools/deploy/deploy-mainnet.sh --broadcast  # activates the kernel, deploys, records the libraries and seeds the core
```

It uses the mainnet configuration in `Deploy.s.sol`: a 24-hour timelock, the guardian (also the timelock's proposer, canceller and executor) and the treasury on keys other than the deployer (`tools/deploy/role_keys.py`), `volStaleness` of 96 hours, and the NVDA covered-call vault only. The proof transactions then run step by step with `python tools/e2e/mainnet_proofs.py <step>` (simulation by default, `--send` to send).
