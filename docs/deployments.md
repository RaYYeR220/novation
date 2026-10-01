# Testnet deployments

Robinhood Chain testnet (chainId 46630). Machine-readable copy: `contracts/deployments/46630.json`.

Testnet has no Chainlink feeds and no official NVDA/AAPL/SPY tokens, so everything marked **MOCK** is a stand-in with no value. Mock feeds are seeded from, and kept in sync with, the real RH mainnet Chainlink feeds by `tools/mirror-feeds.py`.

## Core

| Contract | Address | Notes |
|---|---|---|
| Risk kernel (Stylus) | [`0xAeE1D4F45AF43a9C4d52ADa65d423b1c0e67f0fd`](https://explorer.testnet.chain.robinhood.com/address/0xAeE1D4F45AF43a9C4d52ADa65d423b1c0e67f0fd) | Rust/WASM, 24,085 B compressed, built from the current source and activated 2026-10-01 |
| Previous risk kernel | [`0x6d07e246eb757A1F97E3cdB7d1881ee5De27ceaA`](https://explorer.testnet.chain.robinhood.com/address/0x6d07e246eb757A1F97E3cdB7d1881ee5De27ceaA) | Built before the decoder hardening; not used by the clearinghouse |
| KernelReference (Solidity) | [`0xB7d9232c8ff46b4950d85ed639908c86C08750C6`](https://explorer.testnet.chain.robinhood.com/address/0xB7d9232c8ff46b4950d85ed639908c86C08750C6) | Bit-exact Solidity twin, used for parity and gas comparison |
| RiskParams | [`0xeCEA04998e34250FAf5267886f764A84Eb22450f`](https://explorer.testnet.chain.robinhood.com/address/0xeCEA04998e34250FAf5267886f764A84Eb22450f) | setup finalized |
| MarketDataHub | [`0xDf0045dB247DEcFab97324c62B6a4fC8d85D7fE8`](https://explorer.testnet.chain.robinhood.com/address/0xDf0045dB247DEcFab97324c62B6a4fC8d85D7fE8) | |
| SeriesRegistry | [`0x06a923dD90eA046Ef873d78A7e6CeAeF628fFA18`](https://explorer.testnet.chain.robinhood.com/address/0x06a923dD90eA046Ef873d78A7e6CeAeF628fFA18) | 128 series listed |
| InsuranceFund | [`0x407Ec2670121e0CFE05fAce426c5bFeedCB83FDb`](https://explorer.testnet.chain.robinhood.com/address/0x407Ec2670121e0CFE05fAce426c5bFeedCB83FDb) | funded with 100,000 mock USDG |
| Clearinghouse (with MarginLogic, TradeLogic, SettlementLogic, AuctionHookLogic) | [`0x007dEfb27a1CE2410fec787eFdacbDBa90E08901`](https://explorer.testnet.chain.robinhood.com/address/0x007dEfb27a1CE2410fec787eFdacbDBa90E08901) | setup finalized |
| AuctionHouse | [`0x9a09Aaa2383369a46b6EE5dc9910253D3E021c37`](https://explorer.testnet.chain.robinhood.com/address/0x9a09Aaa2383369a46b6EE5dc9910253D3E021c37) | |
| RfqVenue | [`0x8c0672d04766D06B432B29ab91B660b2Da87cE06`](https://explorer.testnet.chain.robinhood.com/address/0x8c0672d04766D06B432B29ab91B660b2Da87cE06) | |
| CoveredCallVault NVDA | [`0xf6719179446cb08696aa1b92472489B846741278`](https://explorer.testnet.chain.robinhood.com/address/0xf6719179446cb08696aa1b92472489B846741278) | seeded |
| CoveredCallVault TSLA | [`0x25D4639DEBcFf9777bf0dB7955438C6070C27F47`](https://explorer.testnet.chain.robinhood.com/address/0x25D4639DEBcFf9777bf0dB7955438C6070C27F47) | seeded |
| PutWriteVault NVDA | [`0xB582CEfC59751798825E5018067F7E37bbc167c8`](https://explorer.testnet.chain.robinhood.com/address/0xB582CEfC59751798825E5018067F7E37bbc167c8) | seeded |
| TimelockController (60 s on testnet) | [`0xC010e18c0d35B99Df36eB8Ea0A070F62CF68Bf32`](https://explorer.testnet.chain.robinhood.com/address/0xC010e18c0d35B99Df36eB8Ea0A070F62CF68Bf32) | |
| MarginLogic | [`0xCe93b81f68b33b56aF06c00CB3AB659178Ce2D7b`](https://explorer.testnet.chain.robinhood.com/address/0xCe93b81f68b33b56aF06c00CB3AB659178Ce2D7b) | linked library |
| TradeLogic | [`0x74C6318bd22f623c177faF5a9b24504ed7E86C17`](https://explorer.testnet.chain.robinhood.com/address/0x74C6318bd22f623c177faF5a9b24504ed7E86C17) | linked library |
| SettlementLogic | [`0xf5c256273bafEc29d9F4b81C6bA84b8e2d45a901`](https://explorer.testnet.chain.robinhood.com/address/0xf5c256273bafEc29d9F4b81C6bA84b8e2d45a901) | linked library |
| AuctionHookLogic | [`0x0d7A7ADb895a5503047C5D8a5Ae3aBF5952356F5`](https://explorer.testnet.chain.robinhood.com/address/0x0d7A7ADb895a5503047C5D8a5Ae3aBF5952356F5) | linked library |

Deployed from block 127112331 by `contracts/script/Deploy.s.sol` and seeded by `contracts/script/Seed.s.sol`: vol initialised for all four underlyings, calls and puts for the next two weekly expiries at spot ±5/10/15/20%, the InsuranceFund funded and a first deposit in each vault. The guardian, the timelock's proposer and executor, and the treasury are the deployer on testnet. End-to-end transactions: [`tools/e2e/out/46630.json`](../tools/e2e/out/46630.json).

## Mock tokens (MOCK, public mint)

| Token | Address | Notes |
|---|---|---|
| MOCK USDG | [`0xfBb0e60027151cb321b936C2c71278cd08d03921`](https://explorer.testnet.chain.robinhood.com/address/0xfBb0e60027151cb321b936C2c71278cd08d03921) | MockUSDG, 6 decimals, `mint(to, amount)` open to anyone |
| MOCK NVDA | [`0xc2DBC8d95f357C2746242a497BD3170B87F77999`](https://explorer.testnet.chain.robinhood.com/address/0xc2DBC8d95f357C2746242a497BD3170B87F77999) | Mock NVIDIA, 18 decimals, `mint(to, amount)` open to anyone |
| MOCK TSLA | [`0x8F5A67fAb73bcaBD569ac1263433A2Df633b8fF5`](https://explorer.testnet.chain.robinhood.com/address/0x8F5A67fAb73bcaBD569ac1263433A2Df633b8fF5) | Mock Tesla, 18 decimals, `mint(to, amount)` open to anyone |
| MOCK AAPL | [`0x4311Cc3931f638E9f4a7b7109563e78348C95266`](https://explorer.testnet.chain.robinhood.com/address/0x4311Cc3931f638E9f4a7b7109563e78348C95266) | Mock Apple, 18 decimals, `mint(to, amount)` open to anyone |
| MOCK SPY | [`0x06774db4af357f760Dc6448C3C11b2b7aF2eBFdE`](https://explorer.testnet.chain.robinhood.com/address/0x06774db4af357f760Dc6448C3C11b2b7aF2eBFdE) | Mock SPY ETF, 18 decimals, `mint(to, amount)` open to anyone |

## Mock price feeds (MOCK, 8 decimals)

| Feed | Address | Notes |
|---|---|---|
| MOCK NVDA / USD | [`0x8E465F19Ff52DACB53B9dE3A8C42912001A664e5`](https://explorer.testnet.chain.robinhood.com/address/0x8E465F19Ff52DACB53B9dE3A8C42912001A664e5) | Chainlink-style aggregator mirroring RH mainnet NVDA/USD |
| MOCK TSLA / USD | [`0x3c57717cb77CD28e27bc57e67FB4b0DE73937d80`](https://explorer.testnet.chain.robinhood.com/address/0x3c57717cb77CD28e27bc57e67FB4b0DE73937d80) | Chainlink-style aggregator mirroring RH mainnet TSLA/USD |
| MOCK AAPL / USD | [`0x06d33Aeb7A5A44ad8af1A67bB2FEA41D62185602`](https://explorer.testnet.chain.robinhood.com/address/0x06d33Aeb7A5A44ad8af1A67bB2FEA41D62185602) | Chainlink-style aggregator mirroring RH mainnet AAPL/USD |
| MOCK SPY / USD | [`0x78d6096c09253cc7B30D324D06f8BA25C8A4265C`](https://explorer.testnet.chain.robinhood.com/address/0x78d6096c09253cc7B30D324D06f8BA25C8A4265C) | Chainlink-style aggregator mirroring RH mainnet SPY/USD |

Kernel program activation lasts 365 days; it must be re-activated before expiry.
