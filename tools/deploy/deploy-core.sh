#!/usr/bin/env bash
# One command for the core stack on RH testnet, on top of the kernel, mocks and feeds already in
# contracts/deployments/<chainId>.json: Deploy.s.sol, the library/block post-step, Seed.s.sol,
# and with --e2e the end-to-end proof (tools/e2e/scenario.py).
#   bash tools/deploy/deploy-core.sh [--e2e]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
set -a; . "$ROOT/.env"; set +a
RPC="${RH_TESTNET_RPC:-https://rpc.testnet.chain.robinhood.com}"
cd "$ROOT/contracts"
forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --slow
python "$ROOT/tools/deploy/record_libraries.py"
forge script script/Seed.s.sol --rpc-url "$RPC" --broadcast --slow
if [ "${1:-}" = "--e2e" ]; then
  python "$ROOT/tools/e2e/scenario.py" --rpc "$RPC"
fi
