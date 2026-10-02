// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IMarketDataHub} from "../src/interfaces/IMarketDataHub.sol";
import {ISeriesRegistry} from "../src/interfaces/ISeriesRegistry.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {MockStockToken} from "../src/mocks/MockStockToken.sol";
import {NyseCalendar} from "../src/libraries/NyseCalendar.sol";

/// @notice Testnet only. Seeds a fresh Deploy.s.sol stack from deployments/<chainId>.json:
/// initVol + syncVol for every underlying, series for the next 2 weekly expiries at spot
/// +-{5,10,15,20}% on the strike grid (calls and puts), a funded InsuranceFund and a first deposit
/// in each vault (mock tokens are minted).
/// Env: DEPLOYER_PRIVATE_KEY. Run: forge script script/Seed.s.sol --rpc-url $RH_TESTNET_RPC --broadcast --slow
contract Seed is Script {
    uint256 internal constant STRIKE_STEP = 5e18;
    uint256 internal constant INSURANCE_USDG = 100_000e6;
    uint256 internal constant CC_DEPOSIT = 100e18; // stock tokens per covered-call vault
    uint256 internal constant PW_DEPOSIT = 50_000e6; // USDG for the put-write vault

    string[4] internal syms = ["NVDA", "TSLA", "AAPL", "SPY"];

    function run() external {
        require(block.chainid != 1 && block.chainid != 42161 && block.chainid != 4663, "testnet only");
        string memory dep =
            vm.readFile(string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json"));
        IMarketDataHub hub = IMarketDataHub(vm.parseJsonAddress(dep, ".hub"));
        ISeriesRegistry registry = ISeriesRegistry(vm.parseJsonAddress(dep, ".registry"));
        MockUSDG usdg = MockUSDG(vm.parseJsonAddress(dep, ".tokens.USDG"));
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);

        uint64 e1 = uint64(NyseCalendar.nextWeeklyExpiry(block.timestamp));
        uint64 e2 = uint64(NyseCalendar.nextWeeklyExpiry(e1 + 1));
        console.log("expiries", e1, e2);

        vm.startBroadcast(pk);
        for (uint256 i = 0; i < 4; ++i) {
            address u = vm.parseJsonAddress(dep, string.concat(".tokens.", syms[i]));
            hub.initVol(u);
            hub.syncVol(u);
            (uint256 spot,,) = hub.spot(u);
            _list(registry, u, spot, e1);
            _list(registry, u, spot, e2);
        }

        usdg.mint(vm.parseJsonAddress(dep, ".insurance"), INSURANCE_USDG);

        _seedVault(dep, 0, MockStockToken(vm.parseJsonAddress(dep, ".tokens.NVDA")), CC_DEPOSIT, deployer);
        _seedVault(dep, 1, MockStockToken(vm.parseJsonAddress(dep, ".tokens.TSLA")), CC_DEPOSIT, deployer);
        _seedVault(dep, 2, MockStockToken(address(usdg)), PW_DEPOSIT, deployer);
        vm.stopBroadcast();
    }

    /// @dev Calls and puts at spot * (1 +- p), p in {5,10,15,20}%, rounded to the strike grid.
    function _list(ISeriesRegistry registry, address u, uint256 spot, uint64 expiry) internal {
        for (uint256 p = 5; p <= 20; p += 5) {
            uint256 up = _grid(spot * (100 + p) / 100);
            uint256 down = _grid(spot * (100 - p) / 100);
            registry.listSeries(u, expiry, uint128(up), true);
            registry.listSeries(u, expiry, uint128(up), false);
            registry.listSeries(u, expiry, uint128(down), true);
            registry.listSeries(u, expiry, uint128(down), false);
        }
    }

    function _grid(uint256 k) internal pure returns (uint256) {
        return (k + STRIKE_STEP / 2) / STRIKE_STEP * STRIKE_STEP;
    }

    /// @dev MockUSDG and MockStockToken share mint(address,uint256).
    function _seedVault(string memory dep, uint256 i, MockStockToken asset, uint256 amount, address deployer) internal {
        IERC4626 vault = IERC4626(vm.parseJsonAddress(dep, string.concat(".vaults[", vm.toString(i), "].address")));
        asset.mint(deployer, amount);
        asset.approve(address(vault), amount);
        vault.deposit(amount, deployer);
    }
}
