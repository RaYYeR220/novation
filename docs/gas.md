# Gas measurements

This page records every gas number Novation publishes: what was measured, on which chain, with which method and on which date. The headline compares the Stylus risk kernel with a hand-optimized Solidity implementation of the same computation, because that is the conservative comparison. The checked Solidity twin, `KernelReference.sol`, appears only as context.

## Summary

- One `margin()` call on the Stylus kernel costs about 5,000 gas per position on top of a fixed cost. Hand-optimized Solidity costs about 92,500 gas per position.
- On execution gas the Stylus kernel is 14.7x cheaper at 32 positions and 17.6x cheaper at 256 positions. Counting the fixed per-transaction costs both sides pay, the ratio is 11.6x at 32 positions and 14.4x at 256.
- Hand-optimized Solidity reaches Arbitrum's 32M per-transaction limit at about 345 positions for one evaluation. A trade that reduces risk in a 256-position account needs two evaluations of it, about 46.5M gas in Solidity and 2.6M on Stylus.

## Chain and setup

| Item | Value |
|---|---|
| Chain | Robinhood Chain testnet, chain id 46630 |
| ArbOS | 61, Stylus version 3, ink price 10,000 |
| Per-transaction gas limit | 32,000,000 (`ArbGasInfo.getMaxTxGasLimit`) |
| Stylus cache | none: the chain has no CacheManager, so every call pays the uncached program init (about 20,900 gas) |
| `eth_call` gas allowance on the public RPC | about 50,000,000 |
| Dates | Stylus kernel and `KernelReference`: 2026-09-30, transaction-level re-run 2026-10-01. Hand-optimized baseline: 2026-09-25 |

| Contract | Address | Notes |
|---|---|---|
| Stylus risk kernel | [`0x6d07e246eb757A1F97E3cdB7d1881ee5De27ceaA`](https://explorer.testnet.chain.robinhood.com/address/0x6d07e246eb757A1F97E3cdB7d1881ee5De27ceaA) | [create](https://explorer.testnet.chain.robinhood.com/tx/0xe3853d9b273b45d74f26010fe5a4e54be3ff5931be8f69882da5a68947768cfa) 5,907,781 gas, [activate](https://explorer.testnet.chain.robinhood.com/tx/0x51639d8fb40153b8f20f482882457696d627a4f74a1309ee1d911bb8f63dec60) 3,684,406 gas plus a 0.000107 ETH data fee |
| `KernelReference` (checked Solidity twin) | [`0xB7d9232c8ff46b4950d85ed639908c86C08750C6`](https://explorer.testnet.chain.robinhood.com/address/0xB7d9232c8ff46b4950d85ed639908c86C08750C6) | [create](https://explorer.testnet.chain.robinhood.com/tx/0xd2d6eff91925b66072a4f80d84b98dc44ff31e5e01374a8cecdcc0309485569f) |
| Hand-optimized Solidity baseline (`BSMarginSol`) | [`0x9F5a98A1E678b124998328cfa0056c90720ceCEe`](https://explorer.testnet.chain.robinhood.com/address/0x9F5a98A1E678b124998328cfa0056c90720ceCEe) | benchmark contract, not part of the protocol |

<!-- FILL: publish BSMarginSol.sol and its benchmark script under tools/gas-bench/ and link them here -->

The baseline's source is not in this repository yet; it will be published with its benchmark script under `tools/gas-bench/`. It computes the same 39-scenario Black-Scholes grid with the same integer algorithms (Abramowitz-Stegun CDF, Taylor `exp`, atanh-series `ln`), and the same correlated and per-underlying worst losses. It was written for gas: unchecked arithmetic after input validation, Horner steps with inlined constants, per-position values hoisted out of the scenario loop, no assembly. It leaves out the short-option minimum, which the production kernel computes.

## Execution gas of one margin call

Method: [`kernel/bench/gas_probe.py`](../kernel/bench/gas_probe.py). One `eth_call` per measurement, with state overrides that place the compressed Stylus program and a probe contract at fresh addresses. The probe activates the program inside the call, then measures one `staticcall` with `gasleft()`. The Solidity `KernelReference` is measured the same way on identical calldata, and the return data of both is compared. Nothing is broadcast. The book is the first N positions of the 256-position, 8-underlying test book in [`contracts/test/vectors/kernel.json`](../contracts/test/vectors/kernel.json).

| Positions | Stylus kernel | `KernelReference` | Ratio |
|---|---|---|---|
| 0 | 37,137 | 1,033,932 | 27.8x |
| 1 | 42,597 | 1,710,932 | 40.2x |
| 8 | 76,352 | 5,866,521 | 76.8x |
| 32 | 199,415 | 21,253,959 | 106.6x |
| 64 | 351,072 | over the 50M call allowance | |
| 128 | 685,075 | over the 50M call allowance | |
| 256 | 1,323,108 | about 170M (extrapolated) | |

The Stylus kernel's marginal cost is about 5,000 gas per position; `KernelReference` costs about 660,000. In a local Foundry run (`forge test --match-contract KernelGas -vv`, single-underlying book, saved in [`contracts/test/gas-solidity.txt`](../contracts/test/gas-solidity.txt)) `KernelReference` takes 21,861,695 gas at 32 positions and 173,945,704 at 256.

## The conservative baseline

The hand-optimized Solidity baseline, measured with the same `gasleft()` probe method ("inner") and with `eth_estimateGas` minus the L1 data component ("L2"). Its book is a synthetic single-underlying portfolio: spot 3,000, volatility 65%, mixed calls and puts, expiries from 7 to 365 days.

| Positions | Inner | L2 |
|---|---|---|
| 1 | 109,700 | 131,615 |
| 8 | 745,420 | 780,061 |
| 32 | 2,922,648 | 2,995,000 |
| 64 | 5,828,423 | 5,952,285 |
| 128 | 11,646,851 | 11,872,957 |
| 256 | 23,269,339 | 23,698,810 |
| 336 | 30,526,475 | 31,083,410 |
| 352 | 31,967,670 | `eth_estimateGas` fails: over the 32M limit |

Its marginal cost is 92,452 gas per position. An `eth_call` capped at 32,000,000 gas succeeds at 344 positions and runs out of gas at 348; including the L1 component, the limit falls at about 343 to 347 positions. Two real transactions at 64 positions used 5,966,170 gas (Solidity) and 444,140 gas (a Stylus build of the same baseline).

## Headline comparison

Execution gas, Stylus kernel against the hand-optimized baseline:

| Positions | Stylus kernel | Hand-optimized Solidity | Ratio |
|---|---|---|---|
| 32 | 199,415 | 2,922,648 | 14.7x |
| 64 | 351,072 | 5,828,423 | 16.6x |
| 128 | 685,075 | 11,646,851 | 17.0x |
| 256 | 1,323,108 | 23,269,339 | 17.6x |
| marginal per position | about 5,000 | 92,452 | about 18.5x |

Why this comparison is conservative:

- The Stylus book spreads its positions over 8 underlyings, which adds per-underlying work; the Solidity book has one underlying.
- The Stylus numbers include the uncached program init of about 20,900 gas per call. A chain with a CacheManager would cut it to about 2,400.
- The Stylus kernel computes the short-option minimum; the baseline doesn't.

Why one evaluation is not the whole story: [`TradeLogic`](../contracts/src/core/logic/TradeLogic.sol) evaluates margin once for a side that opens risk and twice, before and after, for a side that reduces risk or is acted on by an agent. A trade costs two to four evaluations. These numbers are kernel gas only; the Solidity around the kernel (reading each series from the registry, building the input) adds more and is not included.

## Transaction-level gas on the deployed kernels

Method: [`tools/stylus-deploy/parity.py`](../tools/stylus-deploy/parity.py) against the two deployed contracts. It first checks that both return byte-identical data on five cases (two `bsQuote`, three `margin` books), then runs `eth_estimateGas` for four books. These estimates include the 21,000 intrinsic gas, calldata and the L1 data component. The book: positions alternate a long 10-contract call and a short 10-contract put, strike 10 above spot, 7 days to expiry, volatility 50%, shock range 20%.

| Book | Stylus, 2026-09-30 | `KernelReference`, 2026-09-30 | Stylus, 2026-10-01 | `KernelReference`, 2026-10-01 |
|---|---|---|---|---|
| 32 positions, 1 underlying | 262,876 | 22,092,627 | 269,605 | 22,099,291 |
| 32 positions, 8 underlyings | 285,115 | 23,007,376 | 294,277 | 23,016,538 |
| 64 positions, 8 underlyings | 486,067 | over the 50M allowance | 495,279 | over the 50M allowance |
| 256 positions, 1 underlying | 1,664,367 | over the 50M allowance | 1,671,146 | over the 50M allowance |

The two runs differ by a few thousand gas because the L1 component follows Ethereum's fee market.

At the transaction level, fixed costs paid by both sides narrow the ratio for small books. The baseline's 32-position estimate was 3,037,754 gas including L1, 11.6x the Stylus kernel's 262,876 on the 32-position book above. At 256 positions it was 23,939,893, 14.4x the kernel's 1,664,367. The two books differ, but both hold one underlying and the same number of positions.

## Other kernel functions

| Function | Stylus | `KernelReference` |
|---|---|---|
| `bsQuote` (price and Greeks of one option) | 26,411 | 36,306 |
| `ewmaUpdate`, 19 rounds | 29,153 | 104,499 |

A single Black-Scholes evaluation is cheaper in plain Solidity, because the Stylus call overhead dominates: 46,495 against 26,891 L2 gas for one price in the baseline measurements. That is why the vaults quote single options with the Solidity `BlackScholes` library, which returns the same integers, and why the kernel is used where the work is batched: whole-account margin and volatility updates.

## Program size and expiry

| Build | On-chain code | Limit |
|---|---|---|
| Deployed testnet program | 23,997 bytes | 24,576 |
| Current source | 24,085 bytes | 24,576 |

The deployed program was built before the decoder hardening described in [SECURITY.md](../SECURITY.md#issues-found-and-fixed-in-internal-review); the changes affect only malformed calldata and an integer square-root range the kernel never reaches, and the program will be redeployed from the current source. Its WASM SHA-256 and code hash are recorded in [`contracts/deployments/46630.json`](../contracts/deployments/46630.json).

<!-- FILL: update the address, code hash, size and gas rows after the kernel redeploy from the current source -->

A Stylus program expires 365 days after activation. The deployed program must be kept alive or re-activated before then; both are permissionless ArbWasm calls that pay a data fee.

## Why the Rust is fast

A direct port of the WAD math to Rust with `i128` division and `checked_mul` is only about 1.2x cheaper than Solidity, because those operations compile to branchy software routines on `wasm32`. The kernel instead keeps hot values in 64-bit integers: WAD multiplication by base-1e9 digit splitting, 128-by-64 division, and `exp`, `ln` and the normal CDF as `i64` series. Each entry point runs this fast path first and redoes the whole call on an exact 256-bit path if any value leaves the fast range, so results and revert data stay identical to Solidity for every input. Measured in WASM instructions, `margin()` costs about 161,000 instructions per position.

## Reproduce

```bash
# transaction-level parity and gas against the deployed kernels
python tools/stylus-deploy/parity.py --rpc https://rpc.testnet.chain.robinhood.com

# execution gas with state overrides, nothing broadcast (needs forge and wasm-tools)
python kernel/bench/gas_probe.py https://rpc.testnet.chain.robinhood.com

# local EVM baseline for KernelReference
cd contracts && forge test --match-contract KernelGas -vv
```
