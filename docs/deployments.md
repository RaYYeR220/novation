# Testnet deployments

Robinhood Chain testnet (chainId 46630). Machine-readable copy: `contracts/deployments/46630.json`.

Testnet has no Chainlink feeds and no official NVDA/AAPL/SPY tokens, so everything marked **MOCK** is a stand-in with no value. Mock feeds are seeded from, and kept in sync with, the real RH mainnet Chainlink feeds by `tools/mirror-feeds.py`.

## Core

| Contract | Address | Notes |
|---|---|---|
| Risk kernel (Stylus) | [`0xAeE1D4F45AF43a9C4d52ADa65d423b1c0e67f0fd`](https://explorer.testnet.chain.robinhood.com/address/0xAeE1D4F45AF43a9C4d52ADa65d423b1c0e67f0fd) | Rust/WASM, 24,085 B compressed, built from the current source and activated 2026-10-01 |
| Previous risk kernel | [`0x6d07e246eb757A1F97E3cdB7d1881ee5De27ceaA`](https://explorer.testnet.chain.robinhood.com/address/0x6d07e246eb757A1F97E3cdB7d1881ee5De27ceaA) | Built before the decoder hardening; not used by the clearinghouse |
| KernelReference (Solidity) | [`0xB7d9232c8ff46b4950d85ed639908c86C08750C6`](https://explorer.testnet.chain.robinhood.com/address/0xB7d9232c8ff46b4950d85ed639908c86C08750C6) | Bit-exact Solidity twin, used for parity and gas comparison |
| RiskParams | [`0x5Ec7F77cee13E6c246F80AAaa466992210e17F6f`](https://explorer.testnet.chain.robinhood.com/address/0x5Ec7F77cee13E6c246F80AAaa466992210e17F6f) | setup finalized |
| MarketDataHub | [`0x2BFFfa823cFcCfd703793320883134aC009a5a51`](https://explorer.testnet.chain.robinhood.com/address/0x2BFFfa823cFcCfd703793320883134aC009a5a51) | |
| SeriesRegistry | [`0x4A8bD72CD6e2Cd743c2f103447B47cFf0B22cC77`](https://explorer.testnet.chain.robinhood.com/address/0x4A8bD72CD6e2Cd743c2f103447B47cFf0B22cC77) | 128 series listed |
| InsuranceFund | [`0x9826E96ec14Ff888626E4c6Cf44224925671D1fF`](https://explorer.testnet.chain.robinhood.com/address/0x9826E96ec14Ff888626E4c6Cf44224925671D1fF) | funded with 100,000 mock USDG |
| Clearinghouse (with MarginLogic, TradeLogic, SettlementLogic, AuctionHookLogic) | [`0xe799DF9b96a4809c411D3F90f67C5261a245ABB2`](https://explorer.testnet.chain.robinhood.com/address/0xe799DF9b96a4809c411D3F90f67C5261a245ABB2) | setup finalized |
| AuctionHouse | [`0x0a7590A4C07604D738ab3DDe18306e3026a7Cf0B`](https://explorer.testnet.chain.robinhood.com/address/0x0a7590A4C07604D738ab3DDe18306e3026a7Cf0B) | |
| RfqVenue | [`0x56562573b74A6cD6ca96cfb794A63625A48edf08`](https://explorer.testnet.chain.robinhood.com/address/0x56562573b74A6cD6ca96cfb794A63625A48edf08) | |
| CoveredCallVault NVDA | [`0x5e36BbAc665244f623cf8195b7a753Ad61D8bacA`](https://explorer.testnet.chain.robinhood.com/address/0x5e36BbAc665244f623cf8195b7a753Ad61D8bacA) | seeded |
| CoveredCallVault TSLA | [`0x684Fc5aE66267E8184704f6A3cE393f0c18B1095`](https://explorer.testnet.chain.robinhood.com/address/0x684Fc5aE66267E8184704f6A3cE393f0c18B1095) | seeded |
| PutWriteVault NVDA | [`0x691E99fb5498570F4A0AB8a74aAAE3361c0E0a3a`](https://explorer.testnet.chain.robinhood.com/address/0x691E99fb5498570F4A0AB8a74aAAE3361c0E0a3a) | seeded |
| TimelockController (60 s on testnet) | [`0x5eb54aa55f3e03b7F50b7aFD22F235FB0e85235F`](https://explorer.testnet.chain.robinhood.com/address/0x5eb54aa55f3e03b7F50b7aFD22F235FB0e85235F) | |
| MarginLogic | [`0xCe93b81f68b33b56aF06c00CB3AB659178Ce2D7b`](https://explorer.testnet.chain.robinhood.com/address/0xCe93b81f68b33b56aF06c00CB3AB659178Ce2D7b) | linked library |
| TradeLogic | [`0x74C6318bd22f623c177faF5a9b24504ed7E86C17`](https://explorer.testnet.chain.robinhood.com/address/0x74C6318bd22f623c177faF5a9b24504ed7E86C17) | linked library |
| SettlementLogic | [`0xf5c256273bafEc29d9F4b81C6bA84b8e2d45a901`](https://explorer.testnet.chain.robinhood.com/address/0xf5c256273bafEc29d9F4b81C6bA84b8e2d45a901) | linked library |
| AuctionHookLogic | [`0xF1f37F1320c06535149525Ed6dE2d7D9c9fc0033`](https://explorer.testnet.chain.robinhood.com/address/0xF1f37F1320c06535149525Ed6dE2d7D9c9fc0033) | linked library |

Deployed from block 127134221 by `contracts/script/Deploy.s.sol` and seeded by `contracts/script/Seed.s.sol`: vol initialised for all four underlyings, calls and puts for the next two weekly expiries at spot ±5/10/15/20%, the InsuranceFund funded and a first deposit in each vault. The guardian, the timelock's proposer and executor, and the treasury are the deployer on testnet. End-to-end transactions: [`tools/e2e/out/46630.json`](../tools/e2e/out/46630.json).

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
