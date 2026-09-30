// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {InsuranceFund} from "../../src/core/InsuranceFund.sol";
import {IInsuranceFund} from "../../src/interfaces/IInsuranceFund.sol";
import {MockUSDG} from "../../src/mocks/MockUSDG.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

contract InsuranceFundTest is Test {
    InsuranceFund fund;
    MockUSDG usdg;

    address constant ADMIN = address(0xA);
    address constant CH = address(0xC);

    function setUp() public {
        usdg = new MockUSDG();
        fund = new InsuranceFund(IERC20Metadata(address(usdg)), ADMIN);
        vm.prank(ADMIN);
        fund.bindClearinghouse(CH);
        usdg.mint(address(fund), 1000e6);
    }

    function test_balanceWad() public view {
        assertEq(fund.balanceWad(), 1000e18);
    }

    function test_coverCapsAtBalance() public {
        vm.expectEmit(false, false, false, true);
        emit IInsuranceFund.Covered(5000e18, 1000e18);
        vm.prank(CH);
        uint256 covered = fund.cover(5000e18);
        assertEq(covered, 1000e18);
        assertEq(usdg.balanceOf(CH), 1000e6);
        assertEq(fund.balanceWad(), 0);
        assertEq(fund.outstandingWad(), 1000e18);
    }

    function test_coverRoundsDownForSixDecimals() public {
        vm.prank(CH);
        uint256 covered = fund.cover(1.0000005e18);
        assertEq(covered, 1.000000e18);
        assertEq(usdg.balanceOf(CH), 1e6);
        assertEq(fund.outstandingWad(), 1e18);
    }

    function test_onlyClearinghouse() public {
        vm.expectRevert(InsuranceFund.NotClearinghouse.selector);
        fund.cover(1e18);
        vm.expectRevert(InsuranceFund.NotClearinghouse.selector);
        fund.notifyRecovered(1e18);
        vm.expectRevert(InsuranceFund.NotClearinghouse.selector);
        fund.notifyWrittenOff(1e18);
    }

    function test_bindOnce() public {
        vm.prank(ADMIN);
        vm.expectRevert(InsuranceFund.AlreadyBound.selector);
        fund.bindClearinghouse(address(0xD));
    }

    function test_bindOnlySetupAdmin() public {
        InsuranceFund f2 = new InsuranceFund(IERC20Metadata(address(usdg)), ADMIN);
        vm.expectRevert(InsuranceFund.NotSetupAdmin.selector);
        f2.bindClearinghouse(CH);
        vm.prank(ADMIN);
        vm.expectRevert(InsuranceFund.ZeroAddress.selector);
        f2.bindClearinghouse(address(0));
    }

    function test_coverBeforeBindReverts() public {
        InsuranceFund f2 = new InsuranceFund(IERC20Metadata(address(usdg)), ADMIN);
        vm.expectRevert(InsuranceFund.NotClearinghouse.selector);
        f2.cover(1e18);
    }

    function test_outstandingBookkeeping() public {
        vm.startPrank(CH);
        fund.cover(300e18);
        fund.cover(200e18);
        assertEq(fund.outstandingWad(), 500e18);

        vm.expectEmit(false, false, false, true);
        emit IInsuranceFund.Recovered(120e18);
        fund.notifyRecovered(120e18);
        assertEq(fund.outstandingWad(), 380e18);

        vm.expectEmit(false, false, false, true);
        emit IInsuranceFund.WrittenOff(80e18);
        fund.notifyWrittenOff(80e18);
        assertEq(fund.outstandingWad(), 300e18);

        fund.notifyRecovered(10_000e18); // floors at zero
        assertEq(fund.outstandingWad(), 0);
        fund.notifyWrittenOff(1e18);
        assertEq(fund.outstandingWad(), 0);
        vm.stopPrank();
    }

    function test_topUpByTransfer() public {
        usdg.mint(address(this), 50e6);
        usdg.transfer(address(fund), 50e6);
        assertEq(fund.balanceWad(), 1050e18);
    }

    function test_eighteenDecimalToken() public {
        // a 6-decimal mock is the only mock; 18-dec path is covered by scale == 1 via a minimal token
        Token18 t = new Token18();
        InsuranceFund f = new InsuranceFund(IERC20Metadata(address(t)), ADMIN);
        vm.prank(ADMIN);
        f.bindClearinghouse(CH);
        t.mint(address(f), 10e18);
        vm.prank(CH);
        assertEq(f.cover(3e18 + 7), 3e18 + 7);
        assertEq(t.balanceOf(CH), 3e18 + 7);
    }
}

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract Token18 is ERC20 {
    constructor() ERC20("T18", "T18") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}
