// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Fixture} from "../utils/Fixture.sol";
import {AuctionHouse} from "../../src/core/AuctionHouse.sol";
import {CHErrors} from "../../src/core/ClearinghouseStorage.sol";
import {TradeParams} from "../../src/interfaces/IClearinghouse.sol";
import {IAuctionHouse} from "../../src/interfaces/IAuctionHouse.sol";
import {FixedPointMath as F} from "../../src/libraries/FixedPointMath.sol";

/// @notice Deficit sales end to end: settlement leaves a covered-call writer short, the
/// InsuranceFund bridges part, the rest is pending, and bids on the stock repay both.
contract AuctionHouseSettlementTest is Fixture {
    AuctionHouse ah;
    address dave;
    address bob;
    address carol;
    uint64 e1;
    uint32 call180;

    function setUp() public override {
        super.setUp();
        ah = new AuctionHouse(ch, params, hub);
        ch.bindAuctionHouse(address(ah));
        dave = _user("dave");
        bob = _user("bob");
        carol = _user("carol");
        e1 = _expiry();
        call180 = _list(address(nvda), e1, 180e18, true);
    }

    function test_deficitSaleAfterSettlement() public {
        uint256 d = _fund(dave, 50 * USDG, 10e18);
        uint256 b = _fund(bob, 10_000 * USDG, 0);
        uint256 c = _fund(carol, 10_000 * USDG, 0);
        // dave writes 10 covered calls at 30 (fee 0.54, half of it to the fund)
        venue.trade(
            TradeParams({
                takerActor: dave,
                makerActor: bob,
                takerId: d,
                makerId: b,
                seriesId: call180,
                qty: -10e18,
                premium: 30e18
            })
        );
        usdg.mint(address(insurance), 300 * USDG);

        // NVDA closes at 280: dave owes 1000, pays 79.46 from cash, the fund bridges all it has
        vm.warp(e1 + 60);
        _settleExpiry(address(nvda), e1, 280e18);
        vm.expectEmit(true, true, true, true, address(ah));
        emit IAuctionHouse.DeficitSaleStarted(d, e1, uint64(e1 + 60));
        ch.settleAccount(d, e1);
        (uint256 total, uint256 bridged, uint256 pend) = ch.deficitOf(d, e1);
        assertEq(bridged, 300.27e18);
        assertEq(pend, 620.27e18);
        assertEq(total, 920.54e18);
        ch.settleAccount(b, e1);
        vm.expectRevert(CHErrors.PoolNotReady.selector);
        ch.claim(b, e1);

        // a fresh post-close print (EXTENDED): 274.4 per NVDA at 2% off
        _setPrice(address(nvda), 280e18);
        uint256 price = 274.4e18;
        uint256 tokens = F.divWadUp(pend, price);
        vm.prank(carol);
        uint256 paid = ah.bidDeficit(d, e1, address(nvda), tokens, c, type(uint256).max);
        (, bridged, pend) = ch.deficitOf(d, e1);
        assertEq(pend, 0);
        // the pool is whole: bob's claim pays out
        ch.claim(b, e1);
        assertEq(ch.claimableTotalOf(b), 0);
        assertLt(bridged, 300.27e18 + 1);

        // the rest of the bridge, then the sale is over and dave keeps what's left
        uint256 more = F.divWadUp(bridged - ch.cashOf(d), price);
        vm.prank(carol);
        paid += ah.bidDeficit(d, e1, address(nvda), more, c, type(uint256).max);
        (total, bridged, pend) = ch.deficitOf(d, e1);
        assertEq(total + bridged + pend, 0);
        assertEq(insurance.outstandingWad(), 0);
        (, bool active) = ah.deficitDiscount(d, e1);
        assertFalse(active);
        assertEq(ch.collateralOf(d, address(nvda)), 10e18 - tokens - more);
        assertEq(ch.cashOf(c), 10_000e18 - paid);
        vm.prank(dave);
        ch.withdraw(d, address(nvda), 1e18, dave);
    }
}
