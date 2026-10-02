// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMarketDataHub} from "../src/interfaces/IMarketDataHub.sol";
import {ISeriesRegistry} from "../src/interfaces/ISeriesRegistry.sol";
import {NyseCalendar} from "../src/libraries/NyseCalendar.sol";

/// @notice Mainnet seed for a fresh Deploy.s.sol stack. Nothing is minted: the tokens are real.
/// It starts the vol EWMA of every underlying (initVol, permissionless), lists NVDA calls at spot
/// +5/+10% and puts at spot -5/-10% for the next SEED_EXPIRIES weekly expiries (calls rounded up
/// and puts rounded down on the strike grid, so each is at least that far out of the money), and
/// optionally sends INSURANCE_USDG from the deployer to the InsuranceFund. Vault deposits and
/// trades are left to tools/e2e/mainnet_proofs.py.
///
/// Env: DEPLOYER_PRIVATE_KEY; optional SEED_EXPIRIES (default 2), INSURANCE_USDG (raw 6-decimal
/// units, default 0).
/// Run: forge script script/SeedMainnet.s.sol --rpc-url $RH_MAINNET_RPC --broadcast --slow
contract SeedMainnet is Script {
    uint256 internal constant STRIKE_STEP = 5e18;

    string[4] internal syms = ["NVDA", "TSLA", "AAPL", "SPY"];

    function run() external {
        string memory dep =
            vm.readFile(string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json"));
        IMarketDataHub hub = IMarketDataHub(vm.parseJsonAddress(dep, ".hub"));
        ISeriesRegistry registry = ISeriesRegistry(vm.parseJsonAddress(dep, ".registry"));
        address nvda = vm.parseJsonAddress(dep, ".tokens.NVDA");
        uint256 nExpiries = vm.envOr("SEED_EXPIRIES", uint256(2));
        uint256 insurance = vm.envOr("INSURANCE_USDG", uint256(0));
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(pk);
        for (uint256 i = 0; i < 4; ++i) {
            hub.initVol(vm.parseJsonAddress(dep, string.concat(".tokens.", syms[i])));
        }

        (uint256 spot,,) = hub.spot(nvda);
        uint256 expiry = NyseCalendar.nextWeeklyExpiry(block.timestamp);
        for (uint256 e = 0; e < nExpiries; ++e) {
            console.log("expiry", expiry);
            for (uint256 p = 5; p <= 10; p += 5) {
                registry.listSeries(nvda, uint64(expiry), uint128(_gridUp(spot * (100 + p) / 100)), true);
                registry.listSeries(nvda, uint64(expiry), uint128(_gridDown(spot * (100 - p) / 100)), false);
            }
            expiry = NyseCalendar.nextWeeklyExpiry(expiry + 1);
        }

        if (insurance != 0) {
            require(
                IERC20(vm.parseJsonAddress(dep, ".tokens.USDG"))
                    .transfer(vm.parseJsonAddress(dep, ".insurance"), insurance)
            );
        }
        vm.stopBroadcast();
    }

    function _gridUp(uint256 k) internal pure returns (uint256) {
        return (k + STRIKE_STEP - 1) / STRIKE_STEP * STRIKE_STEP;
    }

    function _gridDown(uint256 k) internal pure returns (uint256) {
        return k / STRIKE_STEP * STRIKE_STEP;
    }
}
