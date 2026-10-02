// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {MockStockToken} from "../src/mocks/MockStockToken.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";

/// @notice Testnet only. Deploys MockUSDG, 4 mock stock tokens and 4 mock feeds, seeds each feed
/// with the current mainnet Chainlink round, and merges addresses into deployments/<chainId>.json
/// (keys `tokens` and `feeds`; other keys such as `kernel` are left untouched).
/// Env: SEED_<SYM>_ANSWER and SEED_<SYM>_UPDATED_AT for SYM in NVDA, TSLA, AAPL, SPY.
/// Run: forge script script/DeployMocks.s.sol --rpc-url $RH_TESTNET_RPC --broadcast
contract DeployMocks is Script {
    string[4] internal syms = ["NVDA", "TSLA", "AAPL", "SPY"];
    string[4] internal names = ["Mock NVIDIA", "Mock Tesla", "Mock Apple", "Mock SPDR S&P 500 ETF"];

    function run() external {
        require(block.chainid != 1 && block.chainid != 42161 && block.chainid != 4663, "testnet only");
        vm.startBroadcast();
        MockUSDG usdg = new MockUSDG();
        string memory tokens = "tokens";
        string memory feeds = "feeds";
        string memory tokensJson = vm.serializeAddress(tokens, "USDG", address(usdg));
        string memory feedsJson = "";
        for (uint256 i = 0; i < 4; i++) {
            MockStockToken t = new MockStockToken(names[i], syms[i]);
            MockAggregator f = new MockAggregator(8, string.concat(syms[i], " / USD"));
            int256 answer = int256(vm.envUint(string.concat("SEED_", syms[i], "_ANSWER")));
            uint256 updatedAt = vm.envUint(string.concat("SEED_", syms[i], "_UPDATED_AT"));
            f.pushRound(answer, updatedAt);
            tokensJson = vm.serializeAddress(tokens, syms[i], address(t));
            feedsJson = vm.serializeAddress(feeds, syms[i], address(f));
        }
        vm.stopBroadcast();

        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        if (!vm.exists(path)) {
            vm.writeJson(string.concat("{\"chainId\":", vm.toString(block.chainid), "}"), path);
        }
        vm.writeJson(tokensJson, path, ".tokens");
        vm.writeJson(feedsJson, path, ".feeds");
    }
}
