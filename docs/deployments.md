# Testnet deployments

Robinhood Chain testnet (chainId 46630). Machine-readable copy: `contracts/deployments/46630.json`.

Testnet has no Chainlink feeds and no official NVDA/AAPL/SPY tokens, so everything marked **MOCK** is a stand-in with no value. Mock feeds are seeded from, and kept in sync with, the real RH mainnet Chainlink feeds by `tools/mirror-feeds.py`.

## Core

| Contract | Address | Notes |
|---|---|---|
| Risk kernel (Stylus) | [`0x6d07e246eb757A1F97E3cdB7d1881ee5De27ceaA`](https://explorer.testnet.chain.robinhood.com/address/0x6d07e246eb757A1F97E3cdB7d1881ee5De27ceaA) | Rust/WASM, 23,997 B compressed |
| KernelReference (Solidity) | [`0xB7d9232c8ff46b4950d85ed639908c86C08750C6`](https://explorer.testnet.chain.robinhood.com/address/0xB7d9232c8ff46b4950d85ed639908c86C08750C6) | Bit-exact Solidity twin, used for parity and gas comparison |

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
