# Testnet deployments

Robinhood Chain testnet (chainId 46630). Machine-readable copy: `contracts/deployments/46630.json`.

Testnet has no Chainlink feeds and no official NVDA/AAPL/SPY tokens, so everything marked **MOCK** is a stand-in with no value. Mock feeds are seeded from, and kept in sync with, the real RH mainnet Chainlink feeds by `tools/mirror-feeds.py`.

## Core

| Contract | Address | Notes |
|---|---|---|
| Risk kernel (Stylus) | [`0xAeE1D4F45AF43a9C4d52ADa65d423b1c0e67f0fd`](https://explorer.testnet.chain.robinhood.com/address/0xAeE1D4F45AF43a9C4d52ADa65d423b1c0e67f0fd) | Rust/WASM, 24,085 B compressed, built from the current source and activated 2026-10-01 |
| Previous risk kernel | [`0x6d07e246eb757A1F97E3cdB7d1881ee5De27ceaA`](https://explorer.testnet.chain.robinhood.com/address/0x6d07e246eb757A1F97E3cdB7d1881ee5De27ceaA) | Built before the decoder hardening; not used by the clearinghouse |
| KernelReference (Solidity) | [`0xB7d9232c8ff46b4950d85ed639908c86C08750C6`](https://explorer.testnet.chain.robinhood.com/address/0xB7d9232c8ff46b4950d85ed639908c86C08750C6) | Bit-exact Solidity twin, used for parity and gas comparison |
| RiskParams | [`0x113AbDCd234d00FfEA37D29A31BD1Fb2B035dcf1`](https://explorer.testnet.chain.robinhood.com/address/0x113AbDCd234d00FfEA37D29A31BD1Fb2B035dcf1) | setup finalized |
| MarketDataHub | [`0xEcD2baaE3C13b526ffdBB8a8388609442C84d993`](https://explorer.testnet.chain.robinhood.com/address/0xEcD2baaE3C13b526ffdBB8a8388609442C84d993) | |
| SeriesRegistry | [`0x9C99381dE80518350fEaA09db17a064eD2180b7b`](https://explorer.testnet.chain.robinhood.com/address/0x9C99381dE80518350fEaA09db17a064eD2180b7b) | 128 series listed |
| InsuranceFund | [`0x531394f5a5D0c3D9e54d258c8825Fa70Fd645429`](https://explorer.testnet.chain.robinhood.com/address/0x531394f5a5D0c3D9e54d258c8825Fa70Fd645429) | funded with 100,000 mock USDG |
| Clearinghouse (with MarginLogic, TradeLogic, SettlementLogic, AuctionHookLogic) | [`0x0b0F4e67DcA3B846859Af452576e8E09316D1949`](https://explorer.testnet.chain.robinhood.com/address/0x0b0F4e67DcA3B846859Af452576e8E09316D1949) | setup finalized |
| AuctionHouse | [`0x4a132D6f83d9db88092A3D1F8B5985B30fd99Ad9`](https://explorer.testnet.chain.robinhood.com/address/0x4a132D6f83d9db88092A3D1F8B5985B30fd99Ad9) | |
| RfqVenue | [`0x1aFD874fdd3914fB6958F282769dAC546993ED82`](https://explorer.testnet.chain.robinhood.com/address/0x1aFD874fdd3914fB6958F282769dAC546993ED82) | |
| CoveredCallVault NVDA | [`0xCCF205358eF9bfd97335f0D7bD5240487bB64865`](https://explorer.testnet.chain.robinhood.com/address/0xCCF205358eF9bfd97335f0D7bD5240487bB64865) | seeded |
| CoveredCallVault TSLA | [`0xF95EAbF20EE1D9034ABa1b240D0242B75e645BD5`](https://explorer.testnet.chain.robinhood.com/address/0xF95EAbF20EE1D9034ABa1b240D0242B75e645BD5) | seeded |
| PutWriteVault NVDA | [`0x0FEee896be42E954c2881668da9035efc5dB0947`](https://explorer.testnet.chain.robinhood.com/address/0x0FEee896be42E954c2881668da9035efc5dB0947) | seeded |
| TimelockController (60 s on testnet) | [`0xf60F96DF709B2dD958519329b4ab488C27e178b5`](https://explorer.testnet.chain.robinhood.com/address/0xf60F96DF709B2dD958519329b4ab488C27e178b5) | |
| MarginLogic | [`0x36EC877374e7F48b34BB190EB18f629F0067a536`](https://explorer.testnet.chain.robinhood.com/address/0x36EC877374e7F48b34BB190EB18f629F0067a536) | linked library |
| TradeLogic | [`0xC899560e64267952dc88122651dDF3e40029eA4B`](https://explorer.testnet.chain.robinhood.com/address/0xC899560e64267952dc88122651dDF3e40029eA4B) | linked library |
| SettlementLogic | [`0x095B3F6BB7B34E14835fa3BC375725B2C74669e7`](https://explorer.testnet.chain.robinhood.com/address/0x095B3F6BB7B34E14835fa3BC375725B2C74669e7) | linked library |
| AuctionHookLogic | [`0x5c3A1bAF3e0554bB703C00723ddb342ce2C82C06`](https://explorer.testnet.chain.robinhood.com/address/0x5c3A1bAF3e0554bB703C00723ddb342ce2C82C06) | linked library |
| VaultPricing | [`0xe110F03A4C2835A3BAAf69D5A2d1EeB602f31C58`](https://explorer.testnet.chain.robinhood.com/address/0xe110F03A4C2835A3BAAf69D5A2d1EeB602f31C58) | linked library (vault quotes) |

Deployed from block 127521684 by `contracts/script/Deploy.s.sol` and seeded by `contracts/script/Seed.s.sol`: vol initialised for all four underlyings, calls and puts for the next two weekly expiries at spot ±5/10/15/20%, the InsuranceFund funded and a first deposit in each vault. The guardian, the timelock's proposer and executor, and the treasury are the deployer on testnet. End-to-end transactions: [`tools/e2e/out/46630.json`](../tools/e2e/out/46630.json).

Previous core deployment (2026-10-01, before the contract polish), still on-chain and settling its Oct 2 positions: Clearinghouse [`0xe799…ABB2`](https://explorer.testnet.chain.robinhood.com/address/0xe799DF9b96a4809c411D3F90f67C5261a245ABB2), listed under `superseded` in [`contracts/deployments/46630.json`](../contracts/deployments/46630.json). Its proofs stay valid: [agent over budget](https://explorer.testnet.chain.robinhood.com/tx/0xa411c8e1173e78c41e6c2f12611d553f54583cb1203eaf651bc9bc725e2c1b9a), [withdrawal below IM](https://explorer.testnet.chain.robinhood.com/tx/0xc947dc28bb91b5499f88ac89911507758d7447db5666720a8eb7d86dd77c3094), [corporate-action halt](https://explorer.testnet.chain.robinhood.com/tx/0x7756c29f080df6458613f129e8aa9b9dc5adadc3c098bb31edd04ecacb447c46), [MCP agent refusal](https://explorer.testnet.chain.robinhood.com/tx/0x2aa5a4ceaf099d14136d921b29b5bc2bce8b52f618b25e4935b04494210f1064), [mm-bot RFQ fill](https://explorer.testnet.chain.robinhood.com/tx/0x883c803d27356c5d1a6d368090fc845b0d8a3848539cfbb85ab7c9d62e3988c5).

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
