// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Fixture} from "../utils/Fixture.sol";
import {AuctionHouse} from "../../src/core/AuctionHouse.sol";
import {CHS, CHStorage, CHErrors} from "../../src/core/ClearinghouseStorage.sol";
import {MarketDataHub} from "../../src/core/MarketDataHub.sol";
import {TradeParams, AccountState} from "../../src/interfaces/IClearinghouse.sol";
import {IAuctionHouse} from "../../src/interfaces/IAuctionHouse.sol";
import {IInsuranceFund} from "../../src/interfaces/IInsuranceFund.sol";
import {IRiskParams} from "../../src/interfaces/IRiskParams.sol";
import {IMarketDataHub} from "../../src/interfaces/IMarketDataHub.sol";
import {FixedPointMath as F} from "../../src/libraries/FixedPointMath.sol";
import {NyseCalendar} from "../../src/libraries/NyseCalendar.sol";
import {Position, Session} from "../../src/types/Types.sol";
import {console2} from "forge-std/console2.sol";

/// @notice Test-only. Etched over the clearinghouse for one call to give an account an unpaid
/// claim on an expiry (the claim books only: no pool behind it).
contract SettlementSeeder {
    function setClaim(uint256 id, uint64 expiry, uint256 wad) external {
        CHStorage storage $ = CHS.s();
        if ($.claimable[id][expiry] == 0) $.claimExpiries[id].push(expiry);
        $.claimable[id][expiry] += wad;
        $.claimableTotal[id] += wad;
        $.totalClaimable[expiry] += wad;
    }
}

contract AuctionHouseTest is Fixture {
    uint256 constant FRI_1940_EDT = 1_790_379_600; // 2026-09-25 19:40 EDT: after the close, EXTENDED
    uint256 constant SAT_NOON = 1_790_424_000; // 2026-09-26 12:00 UTC: WEEKEND
    uint256 constant MON_0430_EDT = 1_790_584_200; // 2026-09-28 04:30 EDT: pre-market, EXTENDED

    AuctionHouse ah;
    SettlementSeeder seeder;
    address alice;
    address bob;
    address carol;
    address dave;
    uint64 e1; // this week's expiry (deficit sales)
    uint64 e2; // next week's expiry (option positions)
    uint32 put170;
    uint32 put160;
    uint32 put150;

    function setUp() public override {
        super.setUp();
        ah = new AuctionHouse(ch, params, hub);
        ch.bindAuctionHouse(address(ah));
        seeder = new SettlementSeeder();
        alice = _user("alice");
        bob = _user("bob");
        carol = _user("carol");
        dave = _user("dave");
        e1 = _expiry();
        e2 = uint64(NyseCalendar.nextWeeklyExpiry(e1 + 1));
        put170 = _list(address(nvda), e2, 170e18, false);
        put160 = _list(address(nvda), e2, 160e18, false);
        put150 = _list(address(nvda), e2, 150e18, false);
    }

    // ================================================================ liquidation

    function test_liquidationAfterPriceDrop() public {
        (uint256 a, uint256 b) = _shortPuts(520 * USDG);
        assertFalse(ch.accountState(a).liquidatable);
        _setPrice(address(nvda), 150e18);
        assertTrue(ch.accountState(a).liquidatable);
        assertGt(ch.accountState(a).equity, 0);
        uint256 c = _fund(carol, 10_000 * USDG, 0);

        vm.expectEmit(true, true, true, true, address(ah));
        emit IAuctionHouse.LiquidationStarted(a, uint64(vm.getBlockTimestamp()));
        ah.startLiquidation(a);
        vm.warp(vm.getBlockTimestamp() + 900); // halfway through: 2% + 10% / 2
        (uint256 d, bool active) = ah.liquidationDiscount(a);
        assertEq(d, 0.07e18);
        assertTrue(active);

        AccountState memory st = ch.accountState(a);
        AccountState memory cb = ch.accountState(c);
        uint256 f = 0.5e18;
        uint256 pay = F.mulWadUp(F.mulWadUp(f, uint256(st.equity)), 1e18 - d);
        uint256 penalty = _mw(0.01e18, _mw(f, uint256(st.equity)));
        uint256 aliceCash = ch.cashOf(a);
        uint256 carolCash = ch.cashOf(c);
        uint256 shortQty = _shortQty(e2);
        uint256 oi = ch.openInterest(put170);

        vm.expectEmit(true, true, true, true, address(ah));
        emit IAuctionHouse.LiquidationBid(a, c, f, int256(pay), d);
        vm.expectEmit(true, true, true, true, address(ah));
        emit IAuctionHouse.LiquidationEnded(a);
        vm.prank(carol);
        assertEq(ah.bidLiquidation(a, f, c, int256(pay)), int256(pay));

        // half the short puts and half the cash moved; the bidder paid into the account
        _assertPos(a, put170, -5e18);
        _assertPos(c, put170, -5e18);
        _assertPos(b, put170, 10e18);
        assertEq(ch.cashOf(a), aliceCash - aliceCash / 2 + pay - penalty);
        assertEq(ch.cashOf(c), carolCash + aliceCash / 2 - pay);
        // a transfer between two shorts changes neither open interest nor the expiry's short qty
        assertEq(_shortQty(e2), shortQty);
        assertEq(ch.openInterest(put170), oi);

        // the bidder gained about the discount on the equity it took over
        int256 gain = ch.accountState(c).equity - cb.equity;
        assertApproxEqAbs(gain, int256(_mw(_mw(f, uint256(st.equity)), d)), 1e6);
        assertTrue(ch.accountState(c).healthy);

        // the account's maintenance gap closed: it's healthy again and the auction ended
        AccountState memory sa = ch.accountState(a);
        assertLt(int256(sa.mm) - sa.equity, int256(st.mm) - st.equity);
        assertTrue(sa.healthy);
        (, active) = ah.liquidationDiscount(a);
        assertFalse(active);
        assertEq(ah.liquidationStartedAt(a), 0);
        _assertBacked(_ids(a, b, c));
    }

    function test_cannotLiquidateHealthy() public {
        (uint256 a,) = _shortPuts(520 * USDG);
        uint256 c = _fund(carol, 10_000 * USDG, 0);
        vm.expectRevert(AuctionHouse.NotLiquidatable.selector);
        ah.startLiquidation(a);

        // cash and collateral only, an unknown account: nothing to liquidate
        uint256 nvdaOnly = _fund(dave, 0, 5e18);
        vm.expectRevert(AuctionHouse.NotLiquidatable.selector);
        ah.startLiquidation(nvdaOnly);
        vm.expectRevert(AuctionHouse.NotLiquidatable.selector);
        ah.startLiquidation(999);

        // no auction, no bid
        vm.prank(carol);
        vm.expectRevert(AuctionHouse.AuctionNotActive.selector);
        ah.bidLiquidation(a, 0.5e18, c, type(int256).max);

        // an account that recovers during its auction can't be bid on
        _setPrice(address(nvda), 150e18);
        ah.startLiquidation(a);
        _setPrice(address(nvda), 180e18);
        assertFalse(ch.accountState(a).liquidatable);
        vm.prank(carol);
        vm.expectRevert(AuctionHouse.NotLiquidatable.selector);
        ah.bidLiquidation(a, 0.5e18, c, type(int256).max);
    }

    /// An account in deficit with no positions left is below maintenance through its stock
    /// collateral; selling that is the deficit sale's job, not a liquidation's.
    function test_noLiquidationWithoutPositions() public {
        uint256 d = _deficitAccount(300e18, 1_500e18);
        assertTrue(ch.accountState(d).liquidatable);
        vm.expectRevert(AuctionHouse.NotLiquidatable.selector);
        ah.startLiquidation(d);
    }

    function test_discountRampsLinearly() public {
        uint256 a = _liquidatable();
        uint256 c = _fund(carol, 10_000 * USDG, 0);
        (uint256 d, bool active) = ah.liquidationDiscount(a);
        assertEq(d, 0);
        assertFalse(active);

        uint256 t0 = vm.getBlockTimestamp();
        ah.startLiquidation(a);
        _assertDiscount(a, 0.02e18, true);
        vm.warp(t0 + 1);
        _assertDiscount(a, 0.02e18 + uint256(0.1e18) / 1800, true);
        vm.warp(t0 + 450);
        _assertDiscount(a, 0.045e18, true);
        vm.warp(t0 + 900);
        _assertDiscount(a, 0.07e18, true);
        vm.expectRevert(AuctionHouse.AuctionActive.selector);
        ah.startLiquidation(a);
        vm.warp(t0 + 1800);
        _assertDiscount(a, 0.12e18, true);
        vm.expectRevert(AuctionHouse.AuctionActive.selector);
        ah.startLiquidation(a);

        // past the duration the auction is over: no bids until someone restarts it
        vm.warp(t0 + 1801);
        _assertDiscount(a, 0.12e18, false);
        vm.prank(carol);
        vm.expectRevert(AuctionHouse.AuctionNotActive.selector);
        ah.bidLiquidation(a, 0.5e18, c, type(int256).max);

        // a restart begins the ramp again
        vm.expectEmit(true, true, true, true, address(ah));
        emit IAuctionHouse.LiquidationStarted(a, uint64(t0 + 1801));
        ah.startLiquidation(a);
        _assertDiscount(a, 0.02e18, true);
        vm.warp(t0 + 1801 + 360);
        _assertDiscount(a, 0.04e18, true);
    }

    function test_bidderMustStayHealthy() public {
        uint256 a = _liquidatable();
        uint256 poor = _fund(carol, 50 * USDG, 0);
        ah.startLiquidation(a);
        vm.prank(carol);
        vm.expectRevert(AuctionHouse.BidderUnhealthy.selector);
        ah.bidLiquidation(a, 0.5e18, poor, type(int256).max);

        // with enough margin behind it the same takeover goes through
        uint256 rich = _fund(dave, 2_000 * USDG, 0);
        vm.prank(dave);
        ah.bidLiquidation(a, 0.25e18, rich, type(int256).max);
        assertTrue(ch.accountState(rich).healthy);
    }

    function test_insolventLiquidationPaidByInsurance() public {
        (uint256 a, uint256 b) = _shortPuts(520 * USDG);
        usdg.mint(address(insurance), 1_000 * USDG);
        _setPrice(address(nvda), 90e18);
        uint256 c = _fund(carol, 10_000 * USDG, 0);
        ah.startLiquidation(a);

        AccountState memory st = ch.accountState(a);
        assertLt(st.equity, 0);
        AccountState memory cb = ch.accountState(c);
        uint256 bonus = _mw(1e18, uint256(-st.equity) + _mw(0.02e18, st.mm));
        uint256 units = bonus / USDG_SCALE; // the fund pays whole USDG units
        uint256 paid = units * USDG_SCALE;
        uint256 fundBefore = usdg.balanceOf(address(insurance));
        uint256 chBefore = usdg.balanceOf(address(ch));
        uint256 aliceCash = ch.cashOf(a);
        uint256 carolCash = ch.cashOf(c);

        // insolvent, so a full takeover is allowed; the bidder can ask for a minimum bonus
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.PayAboveMax.selector, -int256(paid), -int256(paid) - 1));
        ah.bidLiquidation(a, 1e18, c, -int256(paid) - 1);
        vm.prank(carol);
        assertEq(ah.bidLiquidation(a, 1e18, c, -int256(paid)), -int256(paid));

        // the fund paid the bonus and wrote it off; the bidder got exactly what arrived
        assertEq(usdg.balanceOf(address(insurance)), fundBefore - units);
        assertEq(usdg.balanceOf(address(ch)), chBefore + units);
        assertEq(insurance.outstandingWad(), 0);
        assertEq(ch.cashOf(c), carolCash + aliceCash + paid);
        assertEq(ch.cashOf(a), 0);
        assertEq(ch.positionsOf(a).length, 0);
        _assertPos(c, put170, -10e18);

        // the bidder is paid the discount on maintenance margin for taking the book over
        int256 gain = ch.accountState(c).equity - cb.equity;
        assertApproxEqAbs(gain, int256(_mw(0.02e18, st.mm)), 1e12);
        assertTrue(ch.accountState(c).healthy);
        assertEq(ah.liquidationStartedAt(a), 0);
        _assertBacked(_ids(a, b, c));
    }

    function test_insolventBidWithEmptyFund() public {
        (uint256 a,) = _shortPuts(520 * USDG);
        _setPrice(address(nvda), 90e18);
        uint256 c = _fund(carol, 10_000 * USDG, 0);
        ah.startLiquidation(a);
        assertEq(usdg.balanceOf(address(insurance)), 270_000); // only the trade fee's share

        // the fund can cover only 0.27: that's all the bidder gets, and a minimum stops the bid
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.PayAboveMax.selector, int256(-0.27e18), int256(-1e18)));
        ah.bidLiquidation(a, 1e18, c, -1e18);
        vm.prank(carol);
        assertEq(ah.bidLiquidation(a, 1e18, c, 0), -0.27e18);
        assertEq(usdg.balanceOf(address(insurance)), 0);
    }

    function test_noBidsOnWeekend() public {
        (uint256 a,) = _shortPuts(520 * USDG);
        uint256 c = _fund(carol, 10_000 * USDG, 0);

        vm.warp(FRI_1940_EDT);
        _setPrice(address(nvda), 150e18);
        assertEq(uint8(hub.session(address(nvda))), uint8(Session.EXTENDED));
        assertTrue(ch.accountState(a).liquidatable);
        ah.startLiquidation(a);

        // 20:05 EDT Friday: the weekend has begun, the auction is paused
        vm.warp(FRI_1940_EDT + 1500);
        assertEq(uint8(hub.session(address(nvda))), uint8(Session.WEEKEND));
        vm.prank(carol);
        vm.expectRevert(AuctionHouse.MarketClosed.selector);
        ah.bidLiquidation(a, 0.5e18, c, type(int256).max);

        // the auction's clock stops with the market: 20 of its 30 minutes are used
        vm.warp(SAT_NOON);
        assertTrue(ch.accountState(a).liquidatable);
        _assertDiscount(a, 0.02e18 + uint256(0.1e18) * 1200 / 1800, true);
        vm.expectRevert(AuctionHouse.AuctionActive.selector);
        ah.startLiquidation(a);

        // Monday pre-market it has run out (the window reopened Sunday 20:00) and starts again
        vm.warp(MON_0430_EDT);
        _setPrice(address(nvda), 150e18);
        _assertDiscount(a, 0.12e18, false);
        ah.startLiquidation(a);
        vm.prank(carol);
        ah.bidLiquidation(a, 0.5e18, c, type(int256).max);
    }

    /// An auction whose account recovers without a bid on Friday evening would still run on Sunday
    /// (its clock counts market time) and hand a new fall its old discount. Anyone can end it while
    /// the account isn't liquidatable, and the next fall starts a fresh ramp.
    function test_recoveredAuctionCanBeEnded() public {
        uint256 sun2000 = 1_790_553_600; // 2026-09-27 20:00 EDT
        (uint256 a,) = _shortPuts(520 * USDG);
        _fund(carol, 10_000 * USDG, 0);
        vm.prank(dave);
        vm.expectRevert(AuctionHouse.AuctionNotActive.selector);
        ah.endLiquidation(a);

        vm.warp(FRI_1940_EDT);
        _setPrice(address(nvda), 150e18);
        ah.startLiquidation(a);
        vm.prank(dave);
        vm.expectRevert(AuctionHouse.StillLiquidatable.selector);
        ah.endLiquidation(a);

        vm.warp(FRI_1940_EDT + 900); // 19:55: the price recovers, nobody bid
        _setPrice(address(nvda), 175e18);
        assertFalse(ch.accountState(a).liquidatable);
        (, bool active) = ah.liquidationDiscount(a);
        assertTrue(active); // left alone, it would still run on Sunday
        vm.expectEmit(true, true, true, true, address(ah));
        emit IAuctionHouse.LiquidationEnded(a);
        vm.prank(dave);
        ah.endLiquidation(a);
        assertEq(ah.liquidationStartedAt(a), 0);
        _assertDiscount(a, 0, false);

        // Sunday evening it falls again: a fresh auction, from the start discount
        vm.warp(sun2000 + 60);
        _setPrice(address(nvda), 150e18);
        assertTrue(ch.accountState(a).liquidatable);
        ah.startLiquidation(a);
        _assertDiscount(a, 0.02e18, true);
    }

    /// The discount clock counts market time: an auction caught by the weekend resumes at the
    /// discount it had when the window reopens, and a deficit sale started on the weekend opens at
    /// the start discount.
    function test_discountClockPausesOutsideMarket() public {
        uint256 sun2000 = 1_790_553_600; // 2026-09-27 20:00 EDT: the window reopens
        (uint256 a,) = _shortPuts(520 * USDG);
        uint256 c = _fund(carol, 10_000 * USDG, 0);
        vm.warp(FRI_1940_EDT);
        _setPrice(address(nvda), 150e18);
        ah.startLiquidation(a);
        uint256 n = _newAccount(dave);
        vm.prank(address(ch));
        ah.startDeficitSale(n, e1); // 20 minutes before the close too
        vm.warp(SAT_NOON);
        vm.prank(address(ch));
        ah.startDeficitSale(n, e2); // on the weekend

        vm.warp(sun2000 + 300); // 25 minutes of market time for the Friday auctions
        uint256 at25 = 0.02e18 + uint256(0.1e18) * 1500 / 1800;
        _assertDiscount(a, at25, true);
        (uint256 d1,) = ah.deficitDiscount(n, e1);
        assertEq(d1, at25);
        (uint256 d2,) = ah.deficitDiscount(n, e2);
        assertEq(d2, 0.02e18 + uint256(0.1e18) * 300 / 1800);

        // the liquidation is still running and takes bids in the reopened (extended) session
        _setPrice(address(nvda), 150e18);
        assertEq(uint8(hub.session(address(nvda))), uint8(Session.EXTENDED));
        vm.prank(carol);
        int256 paid = ah.bidLiquidation(a, 0.1e18, c, type(int256).max);
        assertGt(paid, 0);
        vm.warp(sun2000 + 601); // 30 minutes and a second: over
        _assertDiscount(a, 0.12e18, false);
        vm.prank(carol);
        vm.expectRevert(AuctionHouse.AuctionNotActive.selector);
        ah.bidLiquidation(a, 0.1e18, c, type(int256).max);
    }

    function test_liquidationNeedsLivePricesForEveryUnderlying() public {
        (uint256 a,) = _shortPuts(520 * USDG);
        _deposit(alice, a, address(spy), 0.01e18); // a little SPY, collateral only
        uint256 c = _fund(carol, 10_000 * USDG, 0);
        _setPrice(address(nvda), 150e18);
        assertTrue(ch.accountState(a).liquidatable);
        address[] memory us = ch.underlyingsOf(a);
        assertEq(us.length, 2);
        assertEq(us[0], address(nvda));
        assertEq(us[1], address(spy));

        // the option underlying is halted
        nvda.setPaused(true);
        vm.expectRevert(AuctionHouse.MarketClosed.selector);
        ah.startLiquidation(a);
        nvda.setPaused(false);

        // the collateral-only token has no usable price: margin values it at 0, the auction waits
        _setPrice(address(spy), 7_000e18);
        vm.expectRevert(MarketDataHub.ImplausiblePrice.selector);
        hub.spot(address(spy));
        assertTrue(ch.accountState(a).liquidatable);
        vm.expectRevert(AuctionHouse.MarketClosed.selector);
        ah.startLiquidation(a);

        _setPrice(address(spy), 600e18);
        ah.startLiquidation(a);
        // a running auction takes no bids while that token has no price either: the account is
        // honest, only its collateral's feed is out
        _setPrice(address(spy), 0);
        assertTrue(ch.accountState(a).liquidatable);
        vm.prank(carol);
        vm.expectRevert(AuctionHouse.MarketClosed.selector);
        ah.bidLiquidation(a, 0.5e18, c, type(int256).max);
        _setPrice(address(spy), 600e18);
        // ... and bids stop again while it is halted (a fresh price is not enough)
        spy.setOraclePaused(true);
        vm.prank(carol);
        vm.expectRevert(AuctionHouse.MarketClosed.selector);
        ah.bidLiquidation(a, 0.5e18, c, type(int256).max);
        spy.setOraclePaused(false);
        vm.prank(carol);
        ah.bidLiquidation(a, 0.5e18, c, type(int256).max);
        // the bidder took half the SPY too
        assertEq(ch.collateralOf(c, address(spy)), 0.005e18);
    }

    function test_penaltyGoesToInsurance() public {
        uint256 a = _liquidatable();
        uint256 c = _fund(carol, 10_000 * USDG, 0);
        ah.startLiquidation(a);

        AccountState memory st = ch.accountState(a);
        uint256 f = 0.4e18;
        uint256 taken = _mw(f, uint256(st.equity));
        uint256 pay = F.mulWadUp(F.mulWadUp(f, uint256(st.equity)), 0.98e18);
        uint256 penalty = _mw(0.01e18, taken);
        assertGt(penalty % USDG_SCALE, 0); // a sub-unit part stays in the clearinghouse
        uint256 fundBefore = usdg.balanceOf(address(insurance));
        uint256 chBefore = usdg.balanceOf(address(ch));
        uint256 aliceCash = ch.cashOf(a);
        uint256 moved = aliceCash * f / 1e18;

        vm.prank(carol);
        ah.bidLiquidation(a, f, c, int256(pay));

        assertEq(usdg.balanceOf(address(insurance)), fundBefore + penalty / USDG_SCALE);
        assertEq(usdg.balanceOf(address(ch)), chBefore - penalty / USDG_SCALE);
        assertEq(ch.cashOf(a), aliceCash - moved + pay - penalty);
        _assertBacked(_ids(a, c, 0));
    }

    function test_bidChecks() public {
        uint256 a = _liquidatable();
        uint256 c = _fund(carol, 10_000 * USDG, 0);
        ah.startLiquidation(a);
        AccountState memory st = ch.accountState(a);
        assertGt(st.equity, 5e18); // above dustEquity: one bid takes at most half

        vm.prank(dave);
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.NotBidder.selector, c, dave));
        ah.bidLiquidation(a, 0.5e18, c, type(int256).max);
        vm.prank(alice);
        vm.expectRevert(AuctionHouse.SelfBid.selector);
        ah.bidLiquidation(a, 0.5e18, a, type(int256).max);
        vm.startPrank(carol);
        vm.expectRevert(AuctionHouse.BadFraction.selector);
        ah.bidLiquidation(a, 0, c, type(int256).max);
        vm.expectRevert(AuctionHouse.BadFraction.selector);
        ah.bidLiquidation(a, 1e18 + 1, c, type(int256).max);
        vm.expectRevert(AuctionHouse.FractionTooLarge.selector);
        ah.bidLiquidation(a, 0.5e18 + 1, c, type(int256).max);
        uint256 pay = F.mulWadUp(F.mulWadUp(0.5e18, uint256(st.equity)), 0.98e18);
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.PayAboveMax.selector, int256(pay), int256(pay) - 1));
        ah.bidLiquidation(a, 0.5e18, c, int256(pay) - 1);
        vm.stopPrank();

        // a bidder that owes a deficit can't take positions over
        _cheatDeficitTotal(c, 1);
        vm.prank(carol);
        vm.expectRevert(AuctionHouse.BidderInDeficit.selector);
        ah.bidLiquidation(a, 0.5e18, c, type(int256).max);
        _cheatDeficitTotal(c, 0);

        vm.prank(carol);
        assertEq(ah.bidLiquidation(a, 0.5e18, c, int256(pay)), int256(pay));
    }

    function test_partialBidsKeepAuctionUntilHealthy() public {
        uint256 a = _liquidatable();
        uint256 c = _fund(carol, 10_000 * USDG, 0);
        ah.startLiquidation(a);
        // a small bid leaves the account liquidatable: the auction goes on
        vm.prank(carol);
        ah.bidLiquidation(a, 0.1e18, c, type(int256).max);
        assertTrue(ch.accountState(a).liquidatable);
        (, bool active) = ah.liquidationDiscount(a);
        assertTrue(active);
        _assertPos(a, put170, -9e18);
        _assertPos(c, put170, -1e18);
        vm.prank(carol);
        ah.bidLiquidation(a, 0.5e18, c, type(int256).max);
        _assertPos(a, put170, -4.5e18);
        assertTrue(ch.accountState(a).healthy);
        (, active) = ah.liquidationDiscount(a);
        assertFalse(active);
    }

    function test_deficitAccountLiquidationPricedBeforeDeficit() public {
        (uint256 a, uint256 b) = _shortPuts(520 * USDG);
        usdg.mint(address(insurance), 1_000 * USDG);
        _setPrice(address(nvda), 150e18);
        uint256 c = _fund(carol, 10_000 * USDG, 0);
        // the account also owes a deficit larger than its equity: insolvent overall, but its book
        // (cash plus options) is still worth something, and the bidder pays for that
        _cheatDeficitTotal(a, 400e18);
        AccountState memory st = ch.accountState(a);
        assertLt(st.equity, 0);
        int256 bookValue = st.equity + 400e18;
        assertGt(bookValue, 0);
        ah.startLiquidation(a);

        uint256 pay = F.mulWadUp(uint256(bookValue), 0.98e18);
        uint256 penalty = _mw(0.01e18, uint256(bookValue));
        uint256 fundBefore = usdg.balanceOf(address(insurance));
        vm.prank(carol);
        assertEq(ah.bidLiquidation(a, 1e18, c, int256(pay)), int256(pay));
        // the payment stays in the account for its deficit; the fund paid nothing out
        assertEq(ch.cashOf(a), pay - penalty);
        assertEq(usdg.balanceOf(address(insurance)), fundBefore + penalty / USDG_SCALE);
        assertEq(ch.positionsOf(a).length, 0);
        _assertBacked(_ids(a, b, c));
    }

    /// Lots are rounded to the minimum size, so a tiny fraction can hand the bidder far more of a
    /// small position than its share. That difference is settled between the account and the
    /// bidder at mark: whatever the fraction, the bidder gains only the discount on its share,
    /// solvent or not, and the InsuranceFund pays only the bonus on the fraction.
    function test_lotRoundingSettledAtMark() public {
        (uint256 a, uint256 b) = _shortPuts(540 * USDG);
        _trade(a, alice, b, bob, put160, -0.015e18, 0.1e18);
        _trade(a, alice, b, bob, put150, -0.025e18, 0.1e18);
        usdg.mint(address(insurance), 1_000 * USDG);
        _setPrice(address(nvda), 150e18);
        uint256 c = _fund(carol, 10_000 * USDG, 0);
        AccountState memory st = ch.accountState(a);
        assertTrue(st.liquidatable);
        assertGt(st.equity, 0);
        ah.startLiquidation(a);

        // 0.1%: 0.01 of the put170 short, but all 0.015 put160 and 0.01 (not 0.000025) put150
        int256 carolBefore = ch.accountState(c).equity;
        uint256 f = 0.001e18;
        uint256 share = _mw(f, uint256(st.equity));
        uint256 gain = share - F.mulWadUp(F.mulWadUp(f, uint256(st.equity)), 0.98e18);
        uint256 penalty = _mw(0.01e18, share);
        vm.prank(carol);
        int256 paid = ah.bidLiquidation(a, f, c, type(int256).max);
        _assertPos(c, put170, -0.01e18);
        _assertPos(c, put160, -0.015e18);
        _assertPos(c, put150, -0.01e18);
        assertLt(paid, int256(share)); // it was paid at mark for the extra short puts
        assertApproxEqAbs(ch.accountState(c).equity - carolBefore, int256(gain), 10);
        // the account lost only the discount on the share and the penalty
        assertApproxEqAbs(st.equity - ch.accountState(a).equity, int256(gain + penalty), 10);

        // now insolvent: the 0.015 put150 left would split into 0.0015 + 0.0135, so it moves whole;
        // the account pays the bidder for that extra liability, the fund only the bonus on 10%
        _setPrice(address(nvda), 90e18);
        st = ch.accountState(a);
        assertLt(st.equity, 0);
        carolBefore = ch.accountState(c).equity;
        uint256 fundBefore = usdg.balanceOf(address(insurance));
        uint256 aliceCash = ch.cashOf(a);
        f = 0.1e18;
        uint256 bonus = _mw(f, uint256(-st.equity) + _mw(0.02e18, st.mm));
        vm.prank(carol);
        paid = ah.bidLiquidation(a, f, c, 0);
        _assertPos(a, put150, 0);
        _assertPos(c, put150, -0.025e18);
        assertEq(fundBefore - usdg.balanceOf(address(insurance)), bonus / USDG_SCALE);
        assertEq(paid, int256(aliceCash - aliceCash / 10 - ch.cashOf(a)) * -1 - int256(bonus / USDG_SCALE * USDG_SCALE));
        assertApproxEqAbs(ch.accountState(c).equity - carolBefore, int256(_mw(f, _mw(0.02e18, st.mm))), 1e12);
        _assertBacked(_ids(a, b, c));
    }

    /// An insolvent book of small short lots: a dust fraction would move every lot whole and almost
    /// none of the cash. The fund must not pay for those liabilities (the owner would then keep
    /// and withdraw the cash); the account owes the bidder the difference, can't pay it, and the
    /// bid fails. The honest full takeover leaves the account with nothing.
    function test_insolventLotResidueNotPaidByFund() public {
        uint256 a = _tinyShortBook();
        ah.startLiquidation(a);
        uint256 a2 = _fund(alice, 2_000 * USDG, 0); // the owner bids from another account
        uint256 fundBefore = usdg.balanceOf(address(insurance));

        vm.prank(alice);
        vm.expectPartialRevert(CHErrors.InsufficientCash.selector);
        ah.bidLiquidation(a, 100, a2, 0);
        assertEq(usdg.balanceOf(address(insurance)), fundBefore);

        AccountState memory st = ch.accountState(a);
        uint256 bonus = uint256(-st.equity) + _mw(0.02e18, st.mm);
        vm.prank(alice);
        assertEq(ah.bidLiquidation(a, 1e18, a2, 0), -int256(bonus / USDG_SCALE * USDG_SCALE));
        assertEq(fundBefore - usdg.balanceOf(address(insurance)), bonus / USDG_SCALE);
        assertEq(ch.cashOf(a), 0);
        assertEq(ch.positionsOf(a).length, 0);
    }

    /// Whatever the fraction, the fund pays at most the bonus on it, and a takeover that empties an
    /// insolvent account leaves it no withdrawable cash.
    function testFuzz_insolventFundOutlayBounded(uint256 f) public {
        f = bound(f, 1, 1e18);
        uint256 a = _tinyShortBook();
        _cheatMovePosition(a, put170, -0.5e18); // and one lot that splits
        ah.startLiquidation(a);
        uint256 c = _fund(carol, 5_000 * USDG, 0);
        AccountState memory st = ch.accountState(a);
        assertLt(st.equity, 0);
        uint256 cap = _mw(f, uint256(-st.equity) + _mw(0.02e18, st.mm));
        uint256 fundBefore = usdg.balanceOf(address(insurance));

        vm.prank(carol);
        try ah.bidLiquidation(a, f, c, type(int256).max) {
            assertLe((fundBefore - usdg.balanceOf(address(insurance))) * USDG_SCALE, cap + USDG_SCALE);
            if (ch.positionsOf(a).length == 0) assertLt(ch.cashOf(a), USDG_SCALE);
        } catch {
            assertEq(usdg.balanceOf(address(insurance)), fundBefore);
        }
    }

    /// An insolvent account with no cash at all can still be taken over in clean fractions: the
    /// marks' wei rounding is not a lot difference it would have to pay.
    function test_cashlessInsolventAccountCanBeTakenOver() public {
        uint256 a = _newAccount(alice);
        _cheatMovePosition(a, put170, -10e18);
        _cheatMovePosition(a, put160, -7e18);
        _setPrice(address(nvda), 150e18);
        assertLt(ch.accountState(a).equity, 0);
        uint256 c = _fund(carol, 10_000 * USDG, 0);
        ah.startLiquidation(a);
        uint256[6] memory fs = [uint256(0.3e18), 0.37e18, 0.123456789e18, 0.45e18, 0.111e18, 0.29e18];
        for (uint256 i = 0; i < fs.length; ++i) {
            uint256 snap = vm.snapshotState();
            vm.prank(carol);
            ah.bidLiquidation(a, fs[i], c, type(int256).max);
            assertEq(ch.cashOf(a), 0);
            vm.revertToState(snap);
        }
    }

    /// A tiny fraction would take the small long-put hedges whole and only a minimum lot of the
    /// short: the account would be left riskier, so the bid fails. A proportional bid is fine.
    function test_bidCannotRaiseRisk() public {
        (uint256 a, uint256 b) = _shortPuts(530 * USDG);
        _trade(a, alice, b, bob, put160, 0.019e18, 0.4e18);
        _trade(a, alice, b, bob, put150, 0.019e18, 0.3e18);
        _setPrice(address(nvda), 150e18);
        uint256 c = _fund(carol, 10_000 * USDG, 0);
        AccountState memory st = ch.accountState(a);
        assertTrue(st.liquidatable);
        ah.startLiquidation(a);

        vm.prank(carol);
        vm.expectPartialRevert(AuctionHouse.BidRaisesRisk.selector);
        ah.bidLiquidation(a, 1e15, c, type(int256).max);

        vm.prank(carol);
        ah.bidLiquidation(a, 0.5e18, c, type(int256).max);
        assertLt(ch.accountState(a).im, st.im);
    }

    /// No liquidation on a book the registry hasn't priced (an expired series awaiting its
    /// settlement price is valued on spot), nor on one with nothing live left (settleAccount's job).
    function test_noBidsOnDeadOrUnsettledBook() public {
        uint32 put170e1 = _list(address(nvda), e1, 170e18, false);
        uint256 a = _fund(alice, 300 * USDG, 0);
        _cheatMovePosition(a, put170e1, -1e18);
        _cheatMovePosition(a, put170, -10e18);
        uint256 dead = _fund(dave, 10 * USDG, 0);
        _cheatMovePosition(dead, put170e1, -1e18);
        uint256 c = _fund(carol, 10_000 * USDG, 0);

        vm.warp(e1 - 600);
        _setPrice(address(nvda), 100e18);
        assertTrue(ch.accountState(a).liquidatable);
        ah.startLiquidation(a);

        // past the close, before the registry has the settlement price
        vm.warp(e1 + 60);
        (uint256 live, uint256 awaiting) = ch.positionStatus(a);
        assertEq(live, 1);
        assertEq(awaiting, 1);
        vm.prank(carol);
        vm.expectRevert(AuctionHouse.NotLiquidatable.selector);
        ah.bidLiquidation(a, 0.5e18, c, type(int256).max);
        vm.expectRevert(AuctionHouse.NotLiquidatable.selector);
        ah.startLiquidation(dead);

        // settled: the live book can be bid on, the expired-only one goes through settleAccount
        uint80 rid = feedOf[address(nvda)].pushRound(int256(100e8), e1);
        registry.settleExpiry(address(nvda), e1, rid);
        (live, awaiting) = ch.positionStatus(a);
        assertEq(awaiting, 0);
        vm.prank(carol);
        ah.bidLiquidation(a, 0.5e18, c, type(int256).max);
        assertTrue(ch.accountState(dead).liquidatable);
        (live, awaiting) = ch.positionStatus(dead);
        assertEq(live + awaiting, 0);
        vm.expectRevert(AuctionHouse.NotLiquidatable.selector);
        ah.startLiquidation(dead);
    }

    /// Unpaid settlement claims count in equity and move with the fraction: the bidder pays for
    /// its share of them and holds that share afterwards.
    function test_claimsMoveWithTheFraction() public {
        uint256 a = _liquidatable();
        uint256 c = _fund(carol, 10_000 * USDG, 0);
        _cheatClaim(a, e1, 20e18 + 1);
        AccountState memory st = ch.accountState(a);
        assertTrue(st.liquidatable);
        ah.startLiquidation(a);

        int256 value = st.equity + int256(st.deficit); // the claim included
        uint256 pay = F.mulWadUp(F.mulWadUp(0.5e18, uint256(value)), 0.98e18);
        vm.prank(carol);
        assertEq(ah.bidLiquidation(a, 0.5e18, c, int256(pay)), int256(pay));
        assertEq(ch.claimable(c, e1), 10e18); // floor(claim * f)
        assertEq(ch.claimable(a, e1), 10e18 + 1);
        assertEq(ch.claimableTotalOf(a), 10e18 + 1);
        assertEq(ch.claimableTotalOf(c), 10e18);
        assertEq(ch.claimExpiriesOf(c).length, 1);
        assertEq(ch.claimExpiriesOf(a).length, 1);
    }

    /// A book worth less than nothing even with its claim: the fund covers the rest of the loss of
    /// the bidder's fraction plus the discount on maintenance, and the claim's share moves.
    function test_claimsCountInTheBook() public {
        (uint256 a,) = _shortPuts(520 * USDG);
        usdg.mint(address(insurance), 1_000 * USDG);
        _setPrice(address(nvda), 90e18);
        uint256 c = _fund(carol, 10_000 * USDG, 0);
        _cheatClaim(a, e1, 100e18);
        AccountState memory st = ch.accountState(a);
        assertTrue(st.liquidatable);
        ah.startLiquidation(a);

        int256 value = st.equity + int256(st.deficit); // the claim included
        assertLt(value, 0);
        uint256 bonus = _mw(0.5e18, uint256(-value) + _mw(0.02e18, st.mm));
        int256 paid = -int256(bonus / USDG_SCALE * USDG_SCALE);
        vm.prank(carol);
        assertEq(ah.bidLiquidation(a, 0.5e18, c, 0), paid);
        assertEq(ch.claimableTotalOf(a), 50e18);
        assertEq(ch.claimableTotalOf(c), 50e18);
    }

    /// Review PoC: an owner holds an unpaid claim, writes puts against it, takes its cash out and
    /// lets the account be liquidated by its own bidder. With the claim left behind, the fund paid
    /// the bidder a discount on a book the claim covered. Now the claim moves with the fraction:
    /// the book is solvent, the bidder pays for it and the fund pays nothing.
    function test_claimBackedBookCantDrainFund() public {
        address att = _user("att");
        uint256 a = _fund(att, 100 * USDG, 0);
        uint256 l = _fund(att, 10_000 * USDG, 0);
        uint256 b = _fund(att, 10_000 * USDG, 0);
        usdg.mint(address(insurance), 10_000 * USDG);
        uint32 c180 = _list(address(nvda), e1, 180e18, true);
        _trade(a, att, l, att, c180, 10e18, 20e18); // A long 10 e1 calls
        vm.warp(e1 + 60);
        _settleExpiry(address(nvda), e1, 260e18);
        _setPrice(address(nvda), 180e18);
        ch.settleAccount(a, e1);
        ch.settleAccount(l, e1);
        assertEq(ch.claimable(a, e1), 800e18); // never collected

        // A writes puts against the claim and withdraws its cash
        _trade(l, att, a, att, put170, 10e18, 1e18);
        uint256 cashUnits = ch.cashOf(a) / USDG_SCALE;
        vm.prank(att);
        ch.withdraw(a, address(usdg), cashUnits, att);
        assertTrue(ch.accountState(a).healthy);

        _setPrice(address(nvda), 130e18);
        assertTrue(ch.accountState(a).liquidatable);
        int256 before = _attackerTotal(att, a, l, b);
        uint256 fund0 = usdg.balanceOf(address(insurance));
        ah.startLiquidation(a);
        vm.warp(vm.getBlockTimestamp() + 1800); // the full discount
        _setPrice(address(nvda), 130e18);
        vm.prank(att);
        int256 paid = ah.bidLiquidation(a, 0.5e18, b, type(int256).max);

        assertGt(paid, 0); // the bidder pays for a solvent book
        assertGe(usdg.balanceOf(address(insurance)), fund0); // the fund pays nothing (a penalty in)
        assertEq(ch.claimable(b, e1), 400e18);
        assertLe(_attackerTotal(att, a, l, b), before);
        ch.claim(a, e1);
        ch.claim(b, e1);
        assertGe(usdg.balanceOf(address(insurance)), fund0);
        assertEq(ch.claimExpiriesOf(a).length, 0);
        assertEq(ch.claimExpiriesOf(b).length, 0);
    }

    /// The one-transaction variant at a Friday close: settle the expiry, turn the account's
    /// payoff into a claim (its pool isn't ready yet, so nobody can claim it), start the auction
    /// and bid at once. The claim moves with the bid all the same.
    function test_claimBackedBookAtTheCloseCantDrainFund() public {
        address att = _user("att");
        uint256 a = _fund(att, 2_000 * USDG, 0);
        uint256 l = _fund(att, 10_000 * USDG, 0);
        uint256 b = _fund(att, 10_000 * USDG, 0);
        usdg.mint(address(insurance), 10_000 * USDG);
        uint32 c180 = _list(address(nvda), e1, 180e18, true);
        _trade(a, att, l, att, c180, 10e18, 20e18);
        _trade(l, att, a, att, put170, 10e18, 1e18); // margined by A's cash before the close

        // at the close, in one go: settle, turn A's payoff into a claim, take the cash out
        vm.warp(e1 + 1);
        _settleExpiry(address(nvda), e1, 260e18);
        _setPrice(address(nvda), 260e18);
        ch.settleAccount(a, e1); // L's short is still open: the claim can't be paid out yet
        vm.expectRevert(CHErrors.PoolNotReady.selector);
        ch.claim(a, e1);
        uint256 cashUnits = ch.cashOf(a) / USDG_SCALE;
        vm.prank(att);
        ch.withdraw(a, address(usdg), cashUnits, att);
        uint256 px = 130e18; // a drop that makes A liquidatable
        _setPrice(address(nvda), px);
        while (!ch.accountState(a).liquidatable) {
            px -= 5e18;
            _setPrice(address(nvda), px);
        }
        uint256 fund0 = usdg.balanceOf(address(insurance));
        int256 before = _attackerTotal(att, a, l, b);
        ah.startLiquidation(a);
        vm.prank(att);
        ah.bidLiquidation(a, 0.5e18, b, type(int256).max);
        assertGe(usdg.balanceOf(address(insurance)), fund0);
        assertEq(ch.claimable(b, e1), ch.claimable(a, e1));
        assertLe(_attackerTotal(att, a, l, b), before);
    }

    /// @dev What `att` holds: the three accounts' equity and its wallet's USDG.
    function _attackerTotal(address att, uint256 a, uint256 l, uint256 b) internal view returns (int256) {
        return ch.accountState(a).equity + ch.accountState(l).equity + ch.accountState(b).equity
            + int256(usdg.balanceOf(att) * USDG_SCALE);
    }

    /// Gas of a 50% bid on an account at the 256-position cap, end to end (gate, book check, three
    /// margin calls, transferFraction, payment, penalty). The kernel here is KernelReference; the
    /// split against the on-chain Stylus kernel is in the AuctionHouse notes.
    function test_gas_liquidation256() public {
        uint256 a = _newAccount(alice);
        uint256 b = _fund(bob, 100_000 * USDG, 0);
        uint64 ex = e1;
        uint256 n;
        for (uint256 w; w < 6 && n < 256; ++w) {
            for (uint256 k = 90; k <= 270 && n < 256; k += 5) {
                for (uint256 cp; cp < 2 && n < 256; ++cp) {
                    uint32 sid = _list(address(nvda), ex, uint128(k * 1e18), cp == 0);
                    _cheatMovePosition(a, sid, -0.05e18);
                    _cheatMovePosition(b, sid, 0.05e18);
                    ++n;
                }
            }
            ex = uint64(NyseCalendar.nextWeeklyExpiry(ex + 1));
        }
        assertEq(ch.positionsOf(a).length, 256);
        AccountState memory st = ch.accountState(a);
        _deposit(alice, a, address(usdg), (uint256(-st.equity) + st.mm / 2) / USDG_SCALE + 1);
        st = ch.accountState(a);
        assertTrue(st.liquidatable);
        assertGt(st.equity, 0);
        uint256 c = _fund(carol, 100_000 * USDG, 0);
        ah.startLiquidation(a);

        vm.prank(carol);
        uint256 g0 = gasleft();
        ah.bidLiquidation(a, 0.5e18, c, type(int256).max);
        uint256 used = g0 - gasleft();
        console2.log("bidLiquidation(256 positions, f=0.5) gas", used);
        assertEq(ch.positionsOf(c).length, 256); // every position moves
        assertEq(ch.positionsOf(a).length, 256);
    }

    /// The owner can't arrange its book to block bids: 128 tiny long puts opened first, the real
    /// short last. A bid moves its fraction of every position, so it takes the short too, and
    /// once the account is insolvent a full takeover always goes through.
    function test_hedgesFirstCantBlockLiquidation() public {
        uint256 a = _newAccount(alice);
        uint256 b = _fund(bob, 100_000 * USDG, 0);
        uint64 ex = e1;
        uint256 n;
        for (uint256 w; w < 6 && n < 128; ++w) {
            for (uint256 k = 90; k <= 270 && n < 128; k += 5) {
                uint32 sid = _list(address(nvda), ex, uint128(k * 1e18), false);
                if (sid == put170) continue;
                _cheatMovePosition(a, sid, 0.01e18);
                _cheatMovePosition(b, sid, -0.01e18);
                ++n;
            }
            ex = uint64(NyseCalendar.nextWeeklyExpiry(ex + 1));
        }
        _cheatMovePosition(a, put170, -10e18);
        _cheatMovePosition(b, put170, 10e18);
        assertEq(ch.positionsOf(a).length, 129);
        _setPrice(address(nvda), 150e18);
        _fundToFractionOfMm(a);
        AccountState memory st = ch.accountState(a);
        assertTrue(st.liquidatable);
        uint256 c = _fund(carol, 100_000 * USDG, 0);
        ah.startLiquidation(a);
        uint256 snap = vm.snapshotState();

        vm.prank(carol);
        ah.bidLiquidation(a, 0.5e18, c, type(int256).max);
        _assertPos(a, put170, -5e18);
        _assertPos(c, put170, -5e18);
        assertLt(ch.accountState(a).im, st.im);

        vm.revertToState(snap);
        _setPrice(address(nvda), 60e18);
        assertLt(ch.accountState(a).equity, 0);
        vm.prank(carol);
        ah.bidLiquidation(a, 1e18, c, type(int256).max);
        assertEq(ch.positionsOf(a).length, 0);
        assertEq(ch.cashOf(a), 0);
    }

    /// 128 far out-of-the-money long SPY calls first, then a real NVDA short: one honest 50% bid
    /// costs the owner the discount and the penalty on half its equity, once, and heals it.
    function test_singleBidHealsMixedBook() public {
        uint256 a = _newAccount(alice);
        uint256 b = _fund(bob, 100_000 * USDG, 0);
        uint64 ex = e1;
        uint256 n;
        for (uint256 w; w < 6 && n < 128; ++w) {
            for (uint256 k = 795; k <= 900 && n < 128; k += 5) {
                uint32 sid = _list(address(spy), ex, uint128(k * 1e18), true);
                _cheatMovePosition(a, sid, 1e18);
                _cheatMovePosition(b, sid, -1e18);
                ++n;
            }
            ex = uint64(NyseCalendar.nextWeeklyExpiry(ex + 1));
        }
        _cheatMovePosition(a, put170, -50e18);
        _cheatMovePosition(b, put170, 50e18);
        _setPrice(address(nvda), 150e18);
        _fundToFractionOfMm(a);
        uint256 c = _fund(carol, 100_000 * USDG, 0);
        ah.startLiquidation(a);
        vm.warp(vm.getBlockTimestamp() + 900); // 7% off

        AccountState memory st = ch.accountState(a);
        assertTrue(st.liquidatable);
        uint256 half = _mw(0.5e18, uint256(st.equity));
        vm.prank(carol);
        ah.bidLiquidation(a, 0.5e18, c, type(int256).max);
        AccountState memory sa = ch.accountState(a);
        // the owner pays 7% + 1% on half its equity (the bid's price is rounded up: <= 2 wei)
        assertApproxEqAbs(st.equity - sa.equity, int256(_mw(half, 0.07e18) + _mw(0.01e18, half)), 1e6);
        _assertPos(a, put170, -25e18);
        assertTrue(sa.healthy);
        assertEq(ah.liquidationStartedAt(a), 0);
    }

    /// @dev Deposits cash so that the account's equity is about 80% of its maintenance margin.
    function _fundToFractionOfMm(uint256 a) internal {
        AccountState memory st = ch.accountState(a);
        int256 need = int256(st.mm) * 8 / 10 - st.equity;
        assertGt(need, 0);
        _deposit(alice, a, address(usdg), uint256(need) / USDG_SCALE + 1);
    }

    // ================================================================ hooks

    function test_hooksOnlyAuctionHouse() public {
        bytes memory err = abi.encodeWithSelector(CHErrors.NotAuctionHouse.selector, address(this));
        vm.expectRevert(err);
        ch.transferFraction(1, 2, 1);
        vm.expectRevert(err);
        ch.transferCash(1, 2, 0);
        vm.expectRevert(err);
        ch.transferCollateral(1, 2, address(nvda), 0);
        vm.expectRevert(err);
        ch.chargePenalty(1, 0);
        vm.expectRevert(err);
        ch.insurancePay(1, 0);

        vm.startPrank(address(ah));
        vm.expectRevert(CHErrors.SelfTrade.selector);
        ch.transferFraction(1, 1, 0.5e18);
        vm.expectRevert(CHErrors.InvalidFraction.selector);
        ch.transferFraction(1, 2, 0);
        vm.expectRevert(CHErrors.InvalidFraction.selector);
        ch.transferFraction(1, 2, 1e18 + 1);
        vm.stopPrank();
    }

    function test_transferFractionMovesShares() public {
        uint256 a = _fund(alice, 2_000 * USDG, 3e18);
        _deposit(alice, a, address(spy), 1e18 + 7);
        uint256 b = _fund(bob, 10_000 * USDG, 0);
        uint256 c = _newAccount(carol);
        _trade(a, alice, b, bob, put170, -10e18, 50e18);
        _trade(a, alice, b, bob, put160, 0.015e18, 0.3e18);
        _trade(a, alice, b, bob, put150, -0.05e18, 0.5e18);
        _cheatCashIndex(0.9e18); // cash moves as index-scaled norm
        uint256 aliceCash = ch.cashOf(a);
        uint256 shortQty = _shortQty(e2);

        vm.prank(address(ah));
        ch.transferFraction(a, c, 0.1e18);
        // 10%: one put170. A 0.0015 or 0.005 lot would be dust, so it is rounded up to 0.01; for
        // the 0.015 put160 that would leave 0.005 behind, so the whole position moves
        _assertPos(a, put170, -9e18);
        _assertPos(c, put170, -1e18);
        _assertPos(a, put160, 0);
        _assertPos(c, put160, 0.015e18);
        _assertPos(a, put150, -0.04e18);
        _assertPos(c, put150, -0.01e18);
        assertEq(ch.collateralOf(a, address(nvda)), 2.7e18);
        assertEq(ch.collateralOf(c, address(nvda)), 0.3e18);
        assertEq(ch.collateralOf(c, address(spy)), 0.1e18); // floor(1e18+7 / 10)
        assertEq(ch.collateralOf(a, address(spy)), 0.9e18 + 7);
        assertLe(ch.cashOf(a) + ch.cashOf(c), aliceCash);
        assertApproxEqAbs(ch.cashOf(c), aliceCash / 10, 1);
        assertEq(_shortQty(e2), shortQty);

        vm.prank(address(ah));
        ch.transferFraction(a, c, 0.5e18);
        _assertPos(a, put170, -4.5e18);
        _assertPos(c, put170, -5.5e18);
        _assertPos(a, put150, -0.02e18);
        _assertPos(c, put150, -0.03e18);
        assertEq(_shortQty(e2), shortQty);

        // a bidder that would end up with a sub-minimum position can't take the lot
        uint256 d = _fund(dave, 1_000 * USDG, 0);
        _trade(d, dave, b, bob, put150, 0.015e18, 0.2e18);
        vm.prank(address(ah));
        vm.expectRevert(abi.encodeWithSelector(CHErrors.DustPosition.selector, d, int256(0.005e18)));
        ch.transferFraction(a, d, 0.5e18);

        // everything, for the rest
        vm.prank(address(ah));
        ch.transferFraction(a, c, 1e18);
        assertEq(ch.positionsOf(a).length, 0);
        assertEq(ch.cashOf(a), 0);
        assertEq(ch.collateralTokensOf(a).length, 0);
        _assertPos(c, put150, -0.05e18);
        _assertBacked(_ids(a, b, c));
    }

    function test_cashAndCollateralHooks() public {
        uint256 a = _fund(alice, 100 * USDG, 2e18);
        uint256 c = _newAccount(carol);
        vm.startPrank(address(ah));
        ch.transferCash(a, c, 40e18);
        ch.transferCollateral(a, c, address(nvda), 0.5e18);
        vm.expectRevert(abi.encodeWithSelector(CHErrors.InsufficientCash.selector, a, 60e18, 60e18 + 1));
        ch.transferCash(a, c, 60e18 + 1);
        vm.expectRevert(
            abi.encodeWithSelector(CHErrors.InsufficientCollateral.selector, a, address(nvda), 1.5e18, 2e18)
        );
        ch.transferCollateral(a, c, address(nvda), 2e18);
        vm.stopPrank();
        assertEq(ch.cashOf(a), 60e18);
        assertEq(ch.cashOf(c), 40e18);
        assertEq(ch.collateralOf(a, address(nvda)), 1.5e18);
        assertEq(ch.collateralOf(c, address(nvda)), 0.5e18);

        // penalty: at most the cash; whole units reach the fund, the sub-unit rest stays behind
        uint256 fundBefore = usdg.balanceOf(address(insurance));
        vm.prank(address(ah));
        ch.chargePenalty(a, 1.5e18 + 1);
        assertEq(ch.cashOf(a), 58.5e18 - 1);
        assertEq(usdg.balanceOf(address(insurance)), fundBefore + 1.5e6);
        vm.prank(address(ah));
        ch.chargePenalty(a, 1_000e18);
        assertEq(ch.cashOf(a), 0);
        assertEq(usdg.balanceOf(address(insurance)), fundBefore + 60e6 - 1);
        _assertBacked(_ids(a, c, 0));
    }

    function test_insurancePayCreditsOnlyWhatArrived() public {
        uint256 c = _newAccount(carol);
        usdg.mint(address(insurance), 100 * USDG);
        uint256 chBefore = usdg.balanceOf(address(ch));

        vm.prank(address(ah));
        assertEq(ch.insurancePay(c, 250e18 + 5), 100e18);
        assertEq(ch.cashOf(c), 100e18);
        assertEq(usdg.balanceOf(address(ch)), chBefore + 100 * USDG);
        assertEq(usdg.balanceOf(address(insurance)), 0);
        assertEq(insurance.outstandingWad(), 0);

        // an empty fund pays nothing and nothing is credited
        vm.prank(address(ah));
        assertEq(ch.insurancePay(c, 1e18), 0);
        assertEq(ch.cashOf(c), 100e18);

        // the fund pays whole units only
        usdg.mint(address(insurance), 5 * USDG);
        vm.prank(address(ah));
        assertEq(ch.insurancePay(c, 1e18 + 1e12 - 1), 1e18);
        assertEq(ch.cashOf(c), 101e18);

        // a fund that reports more than it sends gets no cash credited for the difference
        vm.mockCall(address(insurance), abi.encodeWithSelector(IInsuranceFund.cover.selector), abi.encode(3e18));
        vm.prank(address(ah));
        assertEq(ch.insurancePay(c, 3e18), 0);
        assertEq(ch.cashOf(c), 101e18);
        vm.clearMockedCalls();
        _assertBacked(_ids(c, 0, 0));
    }

    // ================================================================ deficit sales

    function test_onlyChCanStartDeficitSale() public {
        uint256 d = _fund(dave, 0, 10e18);
        vm.expectRevert(AuctionHouse.NotClearinghouse.selector);
        ah.startDeficitSale(d, e1);
        vm.prank(dave);
        vm.expectRevert(AuctionHouse.NotClearinghouse.selector);
        ah.startDeficitSale(d, e1);
        (, bool active) = ah.deficitDiscount(d, e1);
        assertFalse(active);

        vm.expectEmit(true, true, true, true, address(ah));
        emit IAuctionHouse.DeficitSaleStarted(d, e1, uint64(vm.getBlockTimestamp()));
        vm.prank(address(ch));
        ah.startDeficitSale(d, e1);
        (uint256 disc, bool active2) = ah.deficitDiscount(d, e1);
        assertEq(disc, 0.02e18);
        assertTrue(active2);
        vm.warp(vm.getBlockTimestamp() + 3600); // the discount stops at the maximum, the sale goes on
        (disc, active2) = ah.deficitDiscount(d, e1);
        assertEq(disc, 0.12e18);
        assertTrue(active2);
    }

    /// startDeficitSale runs inside settleAccount: for the clearinghouse it must never fail.
    function test_startDeficitSaleNeverFailsForClearinghouse() public {
        uint256 n = _newAccount(carol); // no collateral, no cash
        uint256 t0 = vm.getBlockTimestamp();
        vm.startPrank(address(ch));
        ah.startDeficitSale(n, e1);
        ah.startDeficitSale(999, e1); // not even an account
        vm.stopPrank();
        assertEq(ah.saleStartedAt(n, e1), t0);

        // a repeat call keeps the original start and the ramp goes on
        vm.warp(t0 + 600);
        vm.recordLogs();
        vm.prank(address(ch));
        ah.startDeficitSale(n, e1);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(ah.saleStartedAt(n, e1), t0);
        (uint256 disc, bool active) = ah.deficitDiscount(n, e1);
        assertEq(disc, 0.02e18 + uint256(0.1e18) / 3);
        assertTrue(active);

        // another expiry of the same account is a sale of its own, and the weekend doesn't matter
        vm.warp(SAT_NOON);
        vm.prank(address(ch));
        ah.startDeficitSale(n, e2);
        assertEq(ah.saleStartedAt(n, e2), SAT_NOON);
        (disc, active) = ah.deficitDiscount(n, e2);
        assertEq(disc, 0.02e18);
        assertTrue(active);
        (disc,) = ah.deficitDiscount(n, e1);
        assertEq(disc, 0.12e18);
    }

    function test_deficitSaleRepaysPendingThenInsurance() public {
        uint256 d = _deficitAccount(300e18, 500e18);
        uint256 c = _fund(carol, 10_000 * USDG, 0);
        uint256 fundBefore = usdg.balanceOf(address(insurance));
        assertEq(insurance.outstandingWad(), 500e18);

        // 2 NVDA at 180 * 0.98 = 176.4 each
        uint256 pay = 352.8e18;
        vm.expectEmit(true, true, true, true, address(ah));
        emit IAuctionHouse.DeficitBid(d, c, address(nvda), 2e18, pay);
        vm.prank(carol);
        assertEq(ah.bidDeficit(d, e1, address(nvda), 2e18, c, pay), pay);

        // 300 filled the pool's pending part, the other 52.8 went back to the fund (the pool also
        // holds dave's 79.46 of cash and the fund's 500 bridge)
        (uint256 total, uint256 bridged, uint256 pend) = ch.deficitOf(d, e1);
        assertEq(total, 447.2e18);
        assertEq(bridged, 447.2e18);
        assertEq(pend, 0);
        (uint256 poolWad, uint256 pendingWad,) = ch.pool(e1);
        assertEq(poolWad, 879.46e18);
        assertEq(pendingWad, 0);
        assertEq(usdg.balanceOf(address(insurance)), fundBefore + 52.8e6);
        assertEq(insurance.outstandingWad(), 447.2e18);
        assertEq(ch.cashOf(d), 0);
        assertEq(ch.cashOf(c), 10_000e18 - pay);
        assertEq(ch.collateralOf(d, address(nvda)), 8e18);
        assertEq(ch.collateralOf(c, address(nvda)), 2e18);
        (, bool active) = ah.deficitDiscount(d, e1);
        assertTrue(active);
        _assertBacked(_ids(d, c, 0));
    }

    function test_deficitSaleEndsWhenRepaid() public {
        uint256 d = _deficitAccount(300e18, 500e18);
        uint256 c = _fund(carol, 10_000 * USDG, 0);
        vm.warp(vm.getBlockTimestamp() + 900); // 7% off: 167.4 per NVDA
        uint256 price = 167.4e18;

        // the sale can't sell more than the debt needs
        uint256 need = F.divWadUp(800e18, price);
        vm.prank(carol);
        vm.expectRevert(AuctionHouse.ExceedsDeficit.selector);
        ah.bidDeficit(d, e1, address(nvda), need + 1, c, type(uint256).max);

        uint256 pay = F.mulWadUp(need, price);
        assertGe(pay, 800e18);
        vm.expectEmit(true, true, true, true, address(ah));
        emit AuctionHouse.DeficitSaleEnded(d, e1);
        vm.prank(carol);
        ah.bidDeficit(d, e1, address(nvda), need, c, pay);

        (uint256 total, uint256 bridged, uint256 pend) = ch.deficitOf(d, e1);
        assertEq(total + bridged + pend, 0);
        assertEq(insurance.outstandingWad(), 0);
        (, bool active) = ah.deficitDiscount(d, e1);
        assertFalse(active);
        // what's left over stays with the owner, who can withdraw again
        assertEq(ch.cashOf(d), pay - 800e18);
        assertEq(ch.collateralOf(d, address(nvda)), 10e18 - need);
        vm.prank(dave);
        ch.withdraw(d, address(nvda), 1e18, dave);

        vm.prank(carol);
        vm.expectRevert(AuctionHouse.SaleNotActive.selector);
        ah.bidDeficit(d, e1, address(nvda), 1e18, c, type(uint256).max);
        _assertBacked(_ids(d, c, 0));
    }

    function test_deficitBidChecks() public {
        uint256 d = _deficitAccount(300e18, 500e18);
        uint256 c = _fund(carol, 10_000 * USDG, 0);
        uint256 x = _fund(alice, 1_000 * USDG, 1e18);

        vm.prank(carol);
        vm.expectRevert(AuctionHouse.SaleNotActive.selector);
        ah.bidDeficit(d, e2, address(nvda), 1e18, c, type(uint256).max);
        vm.prank(dave);
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.NotBidder.selector, c, dave));
        ah.bidDeficit(d, e1, address(nvda), 1e18, c, type(uint256).max);
        vm.prank(dave);
        vm.expectRevert(AuctionHouse.SelfBid.selector);
        ah.bidDeficit(d, e1, address(nvda), 1e18, d, type(uint256).max);
        vm.startPrank(carol);
        vm.expectRevert(AuctionHouse.ExceedsCollateral.selector);
        ah.bidDeficit(d, e1, address(nvda), 10e18 + 1, c, type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(AuctionHouse.PayAboveMax.selector, int256(176.4e18), int256(176.4e18 - 1))
        );
        ah.bidDeficit(d, e1, address(nvda), 1e18, c, 176.4e18 - 1);
        // a token the account doesn't hold, and the cash token itself, aren't for sale
        vm.expectRevert(AuctionHouse.ExceedsCollateral.selector);
        ah.bidDeficit(d, e1, address(spy), 1e18, c, type(uint256).max);
        vm.expectRevert(AuctionHouse.MarketClosed.selector);
        ah.bidDeficit(d, e1, address(usdg), 1e18, c, type(uint256).max);
        vm.stopPrank();

        // the sold token must be trading
        nvda.setPaused(true);
        vm.prank(carol);
        vm.expectRevert(AuctionHouse.MarketClosed.selector);
        ah.bidDeficit(d, e1, address(nvda), 1e18, c, type(uint256).max);
        nvda.setPaused(false);

        // a bidder in deficit, or one left under margin, can't buy
        _cheatDeficitTotal(x, 1);
        vm.prank(alice);
        vm.expectRevert(AuctionHouse.BidderInDeficit.selector);
        ah.bidDeficit(d, e1, address(nvda), 1e18, x, type(uint256).max);
        _cheatDeficitTotal(x, 0);
        uint256 b = _fund(bob, 10_000 * USDG, 0);
        _trade(x, alice, b, bob, put170, -10e18, 30e18);
        _setPrice(address(nvda), 60e18);
        assertFalse(ch.accountState(x).healthy);
        vm.prank(alice);
        vm.expectRevert(AuctionHouse.BidderUnhealthy.selector);
        ah.bidDeficit(d, e1, address(nvda), 1e18, x, type(uint256).max);

        // the weekend pauses the sale
        vm.warp(SAT_NOON);
        vm.prank(carol);
        vm.expectRevert(AuctionHouse.MarketClosed.selector);
        ah.bidDeficit(d, e1, address(nvda), 1e18, c, type(uint256).max);
    }

    /// A socialization clears the expiry's books, but the account keeps owing the rest as
    /// residual debt: the sale goes on and its proceeds repay that debt to the fund.
    function test_deficitSaleRepaysSocializedDebt() public {
        uint256 d = _deficitAccount(3_000e18, 0, 0.025e18); // 0.025 NVDA more than the 10: dust
        uint256 c = _fund(carol, 10_000 * USDG, 0);
        // the stock covers only part of the debt: carol buys all 10 NVDA at 176.4
        vm.prank(carol);
        ah.bidDeficit(d, e1, address(nvda), 10e18, c, type(uint256).max);
        (,, uint256 pend) = ch.deficitOf(d, e1);
        assertEq(pend, 1_236e18);

        // the emptied account's remainder is socialized; dave still owes it
        ch.socializeRemainder(d, e1);
        assertEq(ch.socializedDebtOf(d), 1_236e18);
        (, uint256 bridged, uint256 pending) = ch.deficitOf(d, e1);
        assertEq(bridged + pending, 0);
        (, bool active) = ah.deficitDiscount(d, e1);
        assertTrue(active);

        // dave can't bring in more stock while he owes it; cash from anyone repays it (in whole
        // USDG units), here all but one unit
        nvda.mint(dave, 1e18);
        vm.startPrank(dave);
        nvda.approve(address(ch), 1e18);
        vm.expectRevert(CHErrors.DepositNotAllowed.selector);
        ch.deposit(d, address(nvda), 1e18);
        vm.stopPrank();
        _deposit(alice, d, address(usdg), 1_235 * USDG);
        ch.repayDeficit(d);
        // (to the unit: below index 1e18 the cash credit rounds down by a wei)
        uint256 owed = ch.socializedDebtOf(d);
        assertApproxEqAbs(owed, 1e18, 1e12);
        assertEq(owed % 1e12, 0);
        (uint256 total,,) = ch.deficitOf(d, e1);
        assertEq(total, owed);
        assertLt(ch.cashOf(d), 1e12);
        (, active) = ah.deficitDiscount(d, e1);
        assertTrue(active);

        // the sale sells the dust left on the account towards the residual debt, never more than
        // the debt needs, and ends once it is repaid
        uint256 fundBefore = usdg.balanceOf(address(insurance));
        uint256 need = F.divWadUp(ch.socializedDebtOf(d) - ch.cashOf(d), 176.4e18);
        assertLt(need, ch.collateralOf(d, address(nvda)));
        vm.prank(carol);
        vm.expectRevert(AuctionHouse.ExceedsDeficit.selector);
        ah.bidDeficit(d, e1, address(nvda), need + 1, c, type(uint256).max);
        vm.expectEmit(true, true, true, true, address(ah));
        emit AuctionHouse.DeficitSaleEnded(d, e1);
        vm.prank(carol);
        ah.bidDeficit(d, e1, address(nvda), need, c, type(uint256).max);
        assertEq(ch.socializedDebtOf(d), 0);
        (total,,) = ch.deficitOf(d, e1);
        assertEq(total, 0);
        assertEq(usdg.balanceOf(address(insurance)), fundBefore + owed / 1e12);
        (, active) = ah.deficitDiscount(d, e1);
        assertFalse(active);
        vm.prank(dave);
        ch.withdraw(d, address(nvda), 0.025e18 - need, dave);
    }

    // ================================================================ helpers

    uint256 constant USDG_SCALE = 1e12;

    /// @dev alice sells 10 NVDA puts K=170 (next week) to bob at 50 on `usdgUnits` of cash.
    function _shortPuts(uint256 usdgUnits) internal returns (uint256 a, uint256 b) {
        a = _fund(alice, usdgUnits, 0);
        b = _fund(bob, 10_000 * USDG, 0);
        _trade(a, alice, b, bob, put170, -10e18, 50e18);
    }

    /// @dev alice: 20 USDG and ten 0.019 short NVDA puts (strikes 135..180, next week), each lot
    /// under twice the minimum; NVDA down to 30 makes it insolvent. The fund holds 1,000 USDG.
    function _tinyShortBook() internal returns (uint256 a) {
        a = _fund(alice, 20 * USDG, 0);
        uint256 b = _fund(bob, 10_000 * USDG, 0);
        for (uint256 i; i < 10; ++i) {
            uint32 sid = _list(address(nvda), e2, uint128(135e18 + i * 5e18), false);
            _trade(a, alice, b, bob, sid, -0.019e18, 0.01e18);
        }
        usdg.mint(address(insurance), 1_000 * USDG);
        _setPrice(address(nvda), 30e18);
        assertLt(ch.accountState(a).equity, 0);
    }

    /// @dev alice short 10 puts on 520 USDG, NVDA down to 150: equity ~297 > 0 but < MM ~340.
    function _liquidatable() internal returns (uint256 a) {
        (a,) = _shortPuts(520 * USDG);
        _setPrice(address(nvda), 150e18);
        assertTrue(ch.accountState(a).liquidatable);
    }

    /// @dev dave (50 USDG, 10 NVDA) wrote 10 e1 calls K=180 to bob at 30. e1 settles so that,
    /// once dave's 79.46 of cash is paid in, he owes the fund `bridgedWad` (the fund bridges all it
    /// holds) and the e1 pool `pendingWad`. Settled right after the close, which starts the
    /// deficit sale; NVDA is back at 180 for the bids.
    function _deficitAccount(uint256 pendingWad, uint256 bridgedWad) internal returns (uint256 d) {
        return _deficitAccount(pendingWad, bridgedWad, 0);
    }

    /// @dev Same, with `extraNvda` more NVDA collateral.
    function _deficitAccount(uint256 pendingWad, uint256 bridgedWad, uint256 extraNvda) internal returns (uint256 d) {
        d = _fund(dave, 50 * USDG, 10e18 + extraNvda);
        uint256 b = _fund(bob, 10_000 * USDG, 0);
        uint32 call180 = _list(address(nvda), e1, 180e18, true);
        _trade(d, dave, b, bob, call180, -10e18, 30e18);
        uint256 debt = ch.cashOf(d) + pendingWad + bridgedWad;
        deal(address(usdg), address(insurance), bridgedWad / USDG_SCALE);

        vm.warp(e1 + 300);
        _settleExpiry(address(nvda), e1, 180e18 + debt / 10);
        _setPrice(address(nvda), 180e18);
        _setPrice(address(spy), 600e18);
        vm.expectEmit(true, true, true, true, address(ah));
        emit IAuctionHouse.DeficitSaleStarted(d, e1, uint64(e1 + 300));
        ch.settleAccount(d, e1);
        (, uint256 bridged, uint256 pend) = ch.deficitOf(d, e1);
        assertEq(bridged, bridgedWad, "bridged");
        assertEq(pend, pendingWad, "pending");
        assertEq(ch.cashOf(d), 0);
    }

    function _trade(
        uint256 takerId,
        address taker,
        uint256 makerId,
        address maker,
        uint32 sid,
        int256 qty,
        uint256 premium
    ) internal {
        venue.trade(
            TradeParams({
                takerActor: taker,
                makerActor: maker,
                takerId: takerId,
                makerId: makerId,
                seriesId: sid,
                qty: qty,
                premium: premium
            })
        );
    }

    function _assertDiscount(uint256 id, uint256 expected, bool expectedActive) internal view {
        (uint256 d, bool active) = ah.liquidationDiscount(id);
        assertEq(d, expected, "discount");
        assertEq(active, expectedActive, "active");
    }

    function _assertPos(uint256 id, uint32 sid, int256 qty) internal view {
        Position[] memory ps = ch.positionsOf(id);
        for (uint256 i = 0; i < ps.length; ++i) {
            if (ps[i].seriesId == sid) {
                assertEq(ps[i].qty, qty);
                return;
            }
        }
        assertEq(qty, 0, "position missing");
    }

    function _shortQty(uint64 ex) internal view returns (uint256 q) {
        (,, q) = ch.pool(ex);
    }

    /// @dev USDG held by the clearinghouse covers the cash of `ids` (0 = skip) plus both pools;
    /// stock held covers the collateral.
    function _assertBacked(uint256[3] memory ids) internal view {
        uint256 owed;
        uint256 nv;
        uint256 sp;
        for (uint256 i = 0; i < 3; ++i) {
            if (ids[i] == 0) continue;
            owed += ch.cashOf(ids[i]);
            nv += ch.collateralOf(ids[i], address(nvda));
            sp += ch.collateralOf(ids[i], address(spy));
        }
        (uint256 p1,,) = ch.pool(e1);
        (uint256 p2,,) = ch.pool(e2);
        assertGe(usdg.balanceOf(address(ch)) * USDG_SCALE, owed + p1 + p2, "usdg backing");
        assertGe(nvda.balanceOf(address(ch)), nv, "nvda backing");
        assertGe(spy.balanceOf(address(ch)), sp, "spy backing");
    }

    /// @dev Gives `id` an unpaid claim of `wad` on `expiry` (claim books only, no pool behind it).
    function _cheatClaim(uint256 id, uint64 expiry, uint256 wad) internal {
        bytes memory code = address(ch).code;
        vm.etch(address(ch), address(seeder).code);
        SettlementSeeder(address(ch)).setClaim(id, expiry, wad);
        vm.etch(address(ch), code);
    }

    function _mw(uint256 a, uint256 b) internal pure returns (uint256) {
        return a * b / 1e18;
    }

    function _ids(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[3] memory r) {
        r[0] = a;
        r[1] = b;
        r[2] = c;
    }
}
