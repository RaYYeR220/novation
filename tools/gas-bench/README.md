# gas-bench

The hand-optimized Solidity baseline for the margin kernel, and the script used to measure it.

`BSMarginSol.sol` computes the same 39-scenario Black-Scholes grid as the production kernel, with the same integer algorithms (Abramowitz-Stegun CDF, Taylor `exp`, atanh-series `ln`), and the same correlated and per-underlying worst losses. It was written for gas:

- arithmetic is `unchecked` after input validation
- Horner evaluation with inlined constants
- per-position values hoisted out of the scenario loop
- no inline assembly

It leaves out the short-option minimum that the production kernel computes.

Deployed on Robinhood Chain testnet at `0x9F5a98A1E678b124998328cfa0056c90720ceCEe`.

## Build

```
forge build
```

Settings are in `foundry.toml`: solc 0.8.30, `via_ir`, `optimizer_runs = 1000000`, cancun. `Probe.sol` is never deployed; `bench.py` injects its runtime bytecode through an `eth_call` state override to read the gas of one inner call.

## Run

```
pip install requests eth-abi eth-utils
python bench.py <rpc> <label> <address> --arb > results.json
```

For each portfolio size N it records `eth_estimateGas`, and with `--arb` the L1/L2 split from `NodeInterface.gasEstimateComponents`, plus the inner execution gas from the probe. Optional flags: `--ns 1,8,64` to pick sizes, `--cap <gas>` to change the call gas cap. Progress goes to stderr, JSON to stdout.
