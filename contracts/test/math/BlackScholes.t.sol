// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {FixedPointMath} from "../../src/libraries/FixedPointMath.sol";
import {BlackScholes} from "../../src/libraries/BlackScholes.sol";

contract BlackScholesTest is Test {
    function test_putCallParity() public pure {
        uint256 S = 187e18;
        uint256 K = 190e18;
        uint256 tau = 14 days;
        uint256 vol = 0.45e18;
        int256 r = 0.05e18;
        int256 c = int256(BlackScholes.price(S, K, tau, vol, r, true));
        int256 p = int256(BlackScholes.price(S, K, tau, vol, r, false));
        int256 Kd = FixedPointMath.mulWad(int256(K), BlackScholes.discount(r, BlackScholes.yearFrac(tau)));
        assertApproxEqAbs(c - p, int256(S) - Kd, 187e9); // 1e-9 * S
    }

    function test_priceVsFloat() public view {
        string memory json = vm.readFile("test/vectors/math.json");
        string[] memory S = vm.parseJsonStringArray(json, ".price.S");
        string[] memory K = vm.parseJsonStringArray(json, ".price.K");
        string[] memory tau = vm.parseJsonStringArray(json, ".price.tau");
        string[] memory vol = vm.parseJsonStringArray(json, ".price.vol");
        string[] memory rate = vm.parseJsonStringArray(json, ".price.rate");
        bool[] memory isCall = vm.parseJsonBoolArray(json, ".price.isCall");
        string[] memory y = vm.parseJsonStringArray(json, ".price.y");
        string[] memory floatPriceWad = vm.parseJsonStringArray(json, ".price.floatPriceWad");

        uint256 n = S.length;
        assertGt(n, 0);
        assertEq(K.length, n);
        assertEq(tau.length, n);
        assertEq(vol.length, n);
        assertEq(rate.length, n);
        assertEq(isCall.length, n);
        assertEq(y.length, n);
        assertEq(floatPriceWad.length, n);

        for (uint256 i = 0; i < n; i++) {
            uint256 s_ = vm.parseUint(S[i]);
            uint256 k_ = vm.parseUint(K[i]);
            uint256 tau_ = vm.parseUint(tau[i]);
            uint256 vol_ = vm.parseUint(vol[i]);
            int256 rate_ = vm.parseInt(rate[i]);
            int256 expected = vm.parseInt(y[i]);
            int256 fp = vm.parseInt(floatPriceWad[i]);

            uint256 got = BlackScholes.price(s_, k_, tau_, vol_, rate_, isCall[i]);
            assertEq(int256(got), expected, "price mismatch vs Python reference");

            int256 diff = int256(got) - fp;
            if (diff < 0) diff = -diff;
            // The A&S 26.2.17 CDF has |err| ~ 7.5e-8, hitting both N(d1) and N(d2) terms
            // (price = S*N(d1) - K*disc*N(d2)), scaled by S and K: tol = 2e-7 * max(S, K) + 1.
            uint256 maxSK = s_ > k_ ? s_ : k_;
            int256 tol = int256(maxSK * 2 / 1e7) + 1;
            assertLe(diff, tol, "price too far from float reference");
        }
    }

}
