// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {FixedPointMath} from "../../src/libraries/FixedPointMath.sol";

contract FixedPointMathTest is Test {
    function test_expWad_zeroIsOne() public pure {
        assertEq(FixedPointMath.expWad(0), 1e18);
    }

    function test_lnWad_oneIsZero() public pure {
        assertEq(FixedPointMath.lnWad(1e18), 0);
    }

    function test_lnExpRoundTrip() public pure {
        // Below -10e18, expWad's WAD result has too few significant digits left to round-trip through lnWad within 1e6.
        for (int256 x = -10e18; x <= 20e18; x += 0.77e18) {
            assertApproxEqAbs(FixedPointMath.lnWad(FixedPointMath.expWad(x)), x, 1e6);
        }
    }

    function test_normCdf_symmetry() public pure {
        for (int256 x = -5e18; x <= 5e18; x += 0.37e18) {
            assertApproxEqAbs(FixedPointMath.normCdf(x) + FixedPointMath.normCdf(-x), 1e18, 2);
        }
    }

    function test_expWad_overflowReverts() public {
        vm.expectRevert(FixedPointMath.ExpOverflow.selector);
        this.callExp(131e18);
    }

    function callExp(int256 x) external pure returns (int256) {
        return FixedPointMath.expWad(x);
    }

    // ---- Exact-equality vector tests ----

    function test_vectors_expWad() public view {
        string memory json = vm.readFile("test/vectors/math.json");
        string[] memory xs = vm.parseJsonStringArray(json, ".expWad.x");
        string[] memory ys = vm.parseJsonStringArray(json, ".expWad.y");
        assertEq(xs.length, ys.length);
        assertGt(xs.length, 0);
        for (uint256 i = 0; i < xs.length; i++) {
            int256 x = vm.parseInt(xs[i]);
            int256 expected = vm.parseInt(ys[i]);
            assertEq(FixedPointMath.expWad(x), expected, "expWad mismatch");
        }
    }

    function test_vectors_lnWad() public view {
        string memory json = vm.readFile("test/vectors/math.json");
        string[] memory xs = vm.parseJsonStringArray(json, ".lnWad.x");
        string[] memory ys = vm.parseJsonStringArray(json, ".lnWad.y");
        assertEq(xs.length, ys.length);
        assertGt(xs.length, 0);
        for (uint256 i = 0; i < xs.length; i++) {
            int256 x = vm.parseInt(xs[i]);
            int256 expected = vm.parseInt(ys[i]);
            assertEq(FixedPointMath.lnWad(x), expected, "lnWad mismatch");
        }
    }

    function test_vectors_sqrtWad() public view {
        string memory json = vm.readFile("test/vectors/math.json");
        string[] memory xs = vm.parseJsonStringArray(json, ".sqrtWad.x");
        string[] memory ys = vm.parseJsonStringArray(json, ".sqrtWad.y");
        assertEq(xs.length, ys.length);
        assertGt(xs.length, 0);
        for (uint256 i = 0; i < xs.length; i++) {
            uint256 x = vm.parseUint(xs[i]);
            uint256 expected = vm.parseUint(ys[i]);
            assertEq(FixedPointMath.sqrtWad(x), expected, "sqrtWad mismatch");
        }
    }

    function test_vectors_normCdf() public view {
        string memory json = vm.readFile("test/vectors/math.json");
        string[] memory xs = vm.parseJsonStringArray(json, ".normCdf.x");
        string[] memory ys = vm.parseJsonStringArray(json, ".normCdf.y");
        assertEq(xs.length, ys.length);
        assertGt(xs.length, 0);
        for (uint256 i = 0; i < xs.length; i++) {
            int256 x = vm.parseInt(xs[i]);
            int256 expected = vm.parseInt(ys[i]);
            assertEq(FixedPointMath.normCdf(x), expected, "normCdf mismatch");
        }
    }

    function test_vectors_mulWadUp() public view {
        string memory json = vm.readFile("test/vectors/math.json");
        string[] memory as_ = vm.parseJsonStringArray(json, ".mulWadUp.a");
        string[] memory bs = vm.parseJsonStringArray(json, ".mulWadUp.b");
        string[] memory ys = vm.parseJsonStringArray(json, ".mulWadUp.y");
        assertEq(as_.length, bs.length);
        assertEq(as_.length, ys.length);
        assertGt(as_.length, 0);
        for (uint256 i = 0; i < as_.length; i++) {
            uint256 a = vm.parseUint(as_[i]);
            uint256 b = vm.parseUint(bs[i]);
            uint256 expected = vm.parseUint(ys[i]);
            assertEq(FixedPointMath.mulWadUp(a, b), expected, "mulWadUp mismatch");
        }
    }

    function test_vectors_divWadUp() public view {
        string memory json = vm.readFile("test/vectors/math.json");
        string[] memory as_ = vm.parseJsonStringArray(json, ".divWadUp.a");
        string[] memory bs = vm.parseJsonStringArray(json, ".divWadUp.b");
        string[] memory ys = vm.parseJsonStringArray(json, ".divWadUp.y");
        assertEq(as_.length, bs.length);
        assertEq(as_.length, ys.length);
        assertGt(as_.length, 0);
        for (uint256 i = 0; i < as_.length; i++) {
            uint256 a = vm.parseUint(as_[i]);
            uint256 b = vm.parseUint(bs[i]);
            uint256 expected = vm.parseUint(ys[i]);
            assertEq(FixedPointMath.divWadUp(a, b), expected, "divWadUp mismatch");
        }
    }
}
