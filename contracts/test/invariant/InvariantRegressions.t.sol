// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Fixture} from "../utils/Fixture.sol";
import {MockAuctionHouse} from "../utils/MockAuctionHouse.sol";
import {TradeParams} from "../../src/interfaces/IClearinghouse.sol";
import {GlobalParams} from "../../src/interfaces/IRiskParams.sol";

/// @notice Issues the stateful suite (test/invariant) ran into, reduced to plain tests. A test is
/// skipped while its fix is pending and runs as a regression test once it lands.
contract InvariantRegressionsTest is Fixture {
    MockAuctionHouse internal ah;

    function setUp() public override {
        super.setUp();
        ah = new MockAuctionHouse(ch);
        ch.bindAuctionHouse(address(ah));
        GlobalParams memory g = params.globals();
        g.feeRate = 0;
        params.setGlobals(g);
    }

    /// A socialized debt that isn't a whole number of USDG units could never be repaid in full:
    /// repayDeficit pays the InsuranceFund in whole units only (SettlementLogic._toSocial floors
    /// the payment), so the sub-unit rest of the debt stayed on the account for good. Its
    /// deficitTotal never returned to zero: the defaulter couldn't withdraw what it deposited
    /// later, couldn't open a position, and its deficit sale never ended.
    ///
    /// Fixed: socializeRemainder books the socialized debt rounded up to a whole unit, as the
    /// InsuranceFund's bridge already is.
    function test_socializedDebtRepayableInFull() public {
        address alice = _user("alice");
        address bob = _user("bob");
        uint256 a = _fund(alice, 300 * USDG, 0);
        uint256 b = _fund(bob, 1_000 * USDG, 0);
        uint64 e = _expiry();
        uint32 call180 = _list(address(nvda), e, 180e18, true);

        // alice writes 1.23 calls at 12; the InsuranceFund is empty
        venue.trade(
            TradeParams({
                takerActor: alice,
                makerActor: bob,
                takerId: a,
                makerId: b,
                seriesId: call180,
                qty: -1.23e18,
                premium: 12e18
            })
        );

        // NVDA closes at 450.12345678: alice owes 1.23 * 270.12345678 = 332.2518518394, has 312
        vm.warp(e + 60);
        _settleExpiry(address(nvda), e, 450.12345678e18);
        ch.settleAccount(a, e);
        (uint256 total,, uint256 pending) = ch.deficitOf(a, e);
        assertEq(pending, 20.2518518394e18);
        assertEq(total, pending);

        // nothing left to sell: the remainder is socialized and alice keeps owing it, rounded up
        // to a whole USDG unit
        ch.socializeRemainder(a, e);
        assertEq(ch.socializedDebtOf(a), 20.251852e18);

        // alice brings 100 USDG, far more than she owes, and repays
        _deposit(alice, a, address(usdg), 100 * USDG);
        ch.repayDeficit(a);

        // she should owe nothing and be able to take the rest of her cash back out
        assertEq(ch.socializedDebtOf(a), 0, "sub-unit socialized debt left");
        (total,,) = ch.deficitOf(a, 0);
        assertEq(total, 0, "still in deficit");
        vm.prank(alice);
        ch.withdraw(a, address(usdg), 10 * USDG, alice);
    }
}
