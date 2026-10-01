# Mocks

This page lists exactly what is mocked in Novation's testnet deployment, how the mocks differ from the real contracts, and what is real. Mocks exist only on Robinhood Chain testnet (chain id 46630); the mainnet deployment uses the real tokens and feeds and no mock code.

Robinhood Chain testnet has no Chainlink price feeds, and the official testnet stock tokens cover only five tickers (TSLA, AMZN, PLTR, NFLX, AMD), minted only by the chain's faucet. There is no official testnet NVDA, SPY or AAPL. Novation therefore deploys its own stand-ins, labelled MOCK in [docs/deployments.md](docs/deployments.md).

## What is mocked

| Mock | Source | Address | Stands in for |
|---|---|---|---|
| MOCK USDG | [`MockUSDG.sol`](contracts/src/mocks/MockUSDG.sol) | [`0xfBb0e60027151cb321b936C2c71278cd08d03921`](https://explorer.testnet.chain.robinhood.com/address/0xfBb0e60027151cb321b936C2c71278cd08d03921) | Paxos USDG |
| MOCK NVDA | [`MockStockToken.sol`](contracts/src/mocks/MockStockToken.sol) | [`0xc2DBC8d95f357C2746242a497BD3170B87F77999`](https://explorer.testnet.chain.robinhood.com/address/0xc2DBC8d95f357C2746242a497BD3170B87F77999) | Robinhood NVDA stock token |
| MOCK TSLA | `MockStockToken.sol` | [`0x8F5A67fAb73bcaBD569ac1263433A2Df633b8fF5`](https://explorer.testnet.chain.robinhood.com/address/0x8F5A67fAb73bcaBD569ac1263433A2Df633b8fF5) | Robinhood TSLA stock token |
| MOCK AAPL | `MockStockToken.sol` | [`0x4311Cc3931f638E9f4a7b7109563e78348C95266`](https://explorer.testnet.chain.robinhood.com/address/0x4311Cc3931f638E9f4a7b7109563e78348C95266) | Robinhood AAPL stock token |
| MOCK SPY | `MockStockToken.sol` | [`0x06774db4af357f760Dc6448C3C11b2b7aF2eBFdE`](https://explorer.testnet.chain.robinhood.com/address/0x06774db4af357f760Dc6448C3C11b2b7aF2eBFdE) | Robinhood SPY stock token |
| MOCK NVDA / USD | [`MockAggregator.sol`](contracts/src/mocks/MockAggregator.sol) | [`0x8E465F19Ff52DACB53B9dE3A8C42912001A664e5`](https://explorer.testnet.chain.robinhood.com/address/0x8E465F19Ff52DACB53B9dE3A8C42912001A664e5) | Chainlink RHNVDA / USD |
| MOCK TSLA / USD | `MockAggregator.sol` | [`0x3c57717cb77CD28e27bc57e67FB4b0DE73937d80`](https://explorer.testnet.chain.robinhood.com/address/0x3c57717cb77CD28e27bc57e67FB4b0DE73937d80) | Chainlink RHTSLA / USD |
| MOCK AAPL / USD | `MockAggregator.sol` | [`0x06d33Aeb7A5A44ad8af1A67bB2FEA41D62185602`](https://explorer.testnet.chain.robinhood.com/address/0x06d33Aeb7A5A44ad8af1A67bB2FEA41D62185602) | Chainlink Robinhood AAPL / USD |
| MOCK SPY / USD | `MockAggregator.sol` | [`0x78d6096c09253cc7B30D324D06f8BA25C8A4265C`](https://explorer.testnet.chain.robinhood.com/address/0x78d6096c09253cc7B30D324D06f8BA25C8A4265C) | Chainlink RHSPY / USD |

### How the mocks differ from the real contracts

- **Anyone can mint** MOCK USDG and the mock stock tokens with `mint(to, amount)`. They have no value.
- **Anyone can set the mock token flags.** `setPaused`, `setOraclePaused` and `setUiMultiplier` are open, so the halt paths (issuer pause, oracle freeze, ERC-8056 multiplier window) can be demonstrated on testnet. The real tokens restrict these to issuer roles.
- **The mock tokens have no blocklist and no `adminBurn`**, unlike the real `Stock` implementation.
- **The mock multiplier is 1.0.** The real NVDA, AAPL and SPY tokens carry multipliers of about 1.0006 to 1.0017 from reinvested dividends. As on mainnet, the feed answer already includes the multiplier.
- **Anyone can push a round to a mock feed** (`pushRound`) or change its phase (`setPhase`). Testnet prices are therefore not trustworthy, which is acceptable for a test deployment and useful for demonstrating stale feeds, implausible prices and phase changes.
- **The mock feeds reproduce the real feeds' edge cases:** 8 decimals, round ids that pack the phase as `phase << 64 | round`, and zeros rather than a revert for a round that doesn't exist. `MarketDataHub` depends on all three.
- **MOCK USDG has 6 decimals** like the real USDG and no issuer controls.

## The mainnet mirror

The mock feeds follow the real Robinhood Chain mainnet Chainlink feeds. [`tools/mirror-feeds.py`](tools/mirror-feeds.py) reads `latestRoundData` from each mainnet proxy and, when the mainnet round is newer than the mock's latest, pushes the same answer with the same `updatedAt` timestamp:

```bash
python tools/mirror-feeds.py             # one pass
python tools/mirror-feeds.py --loop 300  # every 5 minutes
```

| Underlying | Mainnet proxy | Seed answer |
|---|---|---|
| NVDA | `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15` | 230.55 |
| TSLA | `0x4A1166a659A55625345e9515b32adECea5547C38` | 352.14 |
| AAPL | `0x6B22A786bAa607d76728168703a39Ea9C99f2cD0` | 336.30 |
| SPY | `0x319724394D3A0e3669269846abE664Cd621f9f6A` | 770.44 |

The mirror's limits:

- It copies the latest round only. Rounds published on mainnet while the mirror isn't running are skipped, so the testnet round history is sparser than mainnet's and the realized-volatility estimate differs.
- Prices and timestamps match mainnet; round ids don't. Each mock counts its own rounds.
- Weekends produce no rounds, as on mainnet.
- A mock feed only stays fresh while the mirror runs. Without it, the underlying reads HALTED once its latest round passes the staleness limit (26 hours in market hours).

The mirror runs every 300 seconds. On 2026-10-01 the testnet NVDA and TSLA feeds carried the mainnet rounds of 07:28 and 08:11 UTC that day.

### One synthetic round

When the mirror was first tested, mainnet had published no new TSLA round since the seed. To exercise the push path, one run treated the mainnet round as one second newer than it was, and pushed TSLA's mainnet answer (352.14) with `updatedAt` 1790793155, one second after the real mainnet round: [transaction `0x43ac9cbd…cadf0`](https://explorer.testnet.chain.robinhood.com/tx/0x43ac9cbdb154e8a5838c43fab266be7c219d0c09c1cb27cfb19fba15c4fcadf0). It is the only round on any mock feed that doesn't correspond to a mainnet round. It carries the same price, and the next real TSLA round supersedes it.

## What is real

- **The Stylus risk kernel and `KernelReference`.** They are the production programs, built from the source in this repository and deployed to testnet as they would be to mainnet.
- **Every Novation contract.** The testnet deployment runs the same code as mainnet; only the constructor arguments (token and feed addresses, timelock delay) differ.
- **The chain.** Robinhood Chain testnet runs the same ArbOS and Stylus versions as mainnet, and all gas numbers in [docs/gas.md](docs/gas.md) were measured there.
- **The prices and their timing**, which come from the real mainnet Chainlink feeds through the mirror.
- **The NYSE calendar**, which is the same library on every chain.

## Never deployed

These contracts exist only inside the Foundry tests and must never be deployed:

- `TestVenue` forwards any trade parameters, so it can act for any account.
- `CHStorageWriter` writes clearinghouse storage directly to seed test states.
- `MockAuctionHouse` records deficit-sale calls for the settlement tests.

## Mainnet

The mainnet deployment (planned) uses real USDG (`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` on Robinhood Chain, 6 decimals), the real NVDA, TSLA, SPY and AAPL stock tokens, and the Chainlink proxies listed above.
