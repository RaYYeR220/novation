// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console2} from "forge-std/Test.sol";
import {KernelReference} from "../../src/kernel/KernelReference.sol";
import {KParams, KUnderlying, KPosition} from "../../src/types/Types.sol";

/// Gas baseline for KernelReference.margin / scenarioGrid across book sizes.
/// Run: forge test --match-contract KernelGas -vv > test/gas-solidity.txt
contract KernelGasTest is Test {
    KernelReference k;

    function setUp() public {
        k = new KernelReference();
    }

    function _params() internal pure returns (KParams memory) {
        return KParams({nowTs: 1_790_000_000, rate: 0.04e18, diversificationCredit: 0.3e18, shortOptionMinPct: 0.01e18});
    }

    function _underlyings(uint256 nu) internal pure returns (KUnderlying[] memory us) {
        us = new KUnderlying[](nu);
        for (uint256 i = 0; i < nu; i++) {
            us[i] = KUnderlying({
                spot: (100 + i * 10) * 1e18,
                vol: 0.5e18,
                shockRange: 0.2e18,
                volUp: 0.4e18,
                volDown: 0.3e18,
                tokenQty: 0
            });
        }
    }

    function _positions(uint256 np, uint256 nu) internal pure returns (KPosition[] memory ps) {
        ps = new KPosition[](np);
        for (uint256 i = 0; i < np; i++) {
            uint256 u = i % nu;
            bool isCall = i % 2 == 0;
            uint256 spot = (100 + u * 10) * 1e18;
            ps[i] = KPosition({
                u: u,
                isCall: isCall,
                expiry: 1_790_000_000 + 7 days,
                strike: spot + 10e18,
                qty: i % 2 == 0 ? int256(10e18) : int256(-10e18)
            });
        }
    }

    function test_gasTable() public {
        KParams memory p = _params();

        console2.log("== KernelReference gas baseline (Solidity) ==");

        uint256[8] memory ns = [uint256(1), 4, 8, 16, 32, 64, 128, 256];
        for (uint256 i = 0; i < ns.length; i++) {
            KUnderlying[] memory us = _underlyings(1);
            KPosition[] memory ps = _positions(ns[i], 1);
            uint256 g0 = gasleft();
            k.margin(p, us, ps);
            uint256 used = g0 - gasleft();
            console2.log(string.concat("margin  1 underlying, ", vm.toString(ns[i]), " positions: "), used);
        }

        {
            KUnderlying[] memory us = _underlyings(8);
            KPosition[] memory ps = _positions(32, 8); // 8 underlyings x 4 positions each
            uint256 g0 = gasleft();
            k.margin(p, us, ps);
            uint256 used = g0 - gasleft();
            console2.log("margin  8 underlyings, 4 positions each (32 total): ", used);
        }

        {
            KUnderlying[] memory us = _underlyings(1);
            KPosition[] memory ps = _positions(32, 1);
            uint256 g0 = gasleft();
            k.scenarioGrid(p, us, ps);
            uint256 used = g0 - gasleft();
            console2.log("scenarioGrid  1 underlying, 32 positions: ", used);
        }
    }
}
