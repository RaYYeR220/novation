#!/usr/bin/env bash
# Robinhood Chain mainnet go-live in one command, for when new Stylus activations are accepted again.
# The risk kernel is already deployed (contracts/deployments/4663.json, status "deployed, not
# activated"). This activates it, deploys the core (Deploy.s.sol: the mainnet config, the guardian
# and treasury from tools/deploy/role_keys.py), records the libraries and the deploy block, seeds it
# (SeedMainnet.s.sol) and prints the result. The proof transactions follow step by step with
# tools/e2e/mainnet_proofs.py.
#
#   bash tools/deploy/deploy-mainnet.sh              # simulation: prices the activation, simulates Deploy.s.sol
#   bash tools/deploy/deploy-mainnet.sh --broadcast  # sends everything
#
# Env (.env): DEPLOYER_PRIVATE_KEY, RH_MAINNET_RPC. VAULT_MIN_NEW_SERIES_QTY defaults to 0.01
# contracts (the demo vault's series slot; the vault config is immutable).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
set -a; . "$ROOT/.env"; set +a
RPC="${RH_MAINNET_RPC:-https://rpc.mainnet.chain.robinhood.com}"
if [ "$(cast chain-id --rpc-url "$RPC")" != "4663" ]; then
  echo "not Robinhood Chain mainnet (chain 4663)" >&2
  exit 1
fi
eval "$(python "$ROOT/tools/deploy/role_keys.py" --export)"
export VAULT_MIN_NEW_SERIES_QTY="${VAULT_MIN_NEW_SERIES_QTY:-10000000000000000}"
KERNEL="$(python -c "import json,sys; print(json.load(open(sys.argv[1]))['kernel']['address'])" "$ROOT/contracts/deployments/4663.json")"
ACTIVATE=(python "$ROOT/tools/stylus-deploy/deploy.py" --activate "$KERNEL" --rpc "$RPC" --fallback-fee-wei 130000000000000 --activate-gas 5000000)
echo "kernel $KERNEL, guardian $GUARDIAN, treasury $TREASURY"
cd "$ROOT/contracts"

if [ "${1:-}" != "--broadcast" ]; then
  # the simulation writes its would-be addresses into the json: keep the real one
  JSON="$ROOT/contracts/deployments/4663.json"
  SAVED="$(mktemp)"
  cp "$JSON" "$SAVED"
  trap 'cp "$SAVED" "$JSON"; rm -f "$SAVED"' EXIT
  "${ACTIVATE[@]}" --dry-run
  forge script script/Deploy.s.sol --rpc-url "$RPC"
  echo "simulation only: nothing was sent. Run again with --broadcast."
  exit 0
fi

"${ACTIVATE[@]}"
forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --slow
python "$ROOT/tools/deploy/record_libraries.py" --chain 4663
forge script script/SeedMainnet.s.sol --rpc-url "$RPC" --broadcast --slow
python "$ROOT/tools/e2e/mainnet_proofs.py" status --rpc "$RPC"
