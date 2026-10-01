// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {SeriesRegistry} from "../../src/core/SeriesRegistry.sol";
import {MarketDataHub} from "../../src/core/MarketDataHub.sol";
import {RiskParams} from "../../src/core/RiskParams.sol";
import {KernelReference} from "../../src/kernel/KernelReference.sol";
import {MockAggregator} from "../../src/mocks/MockAggregator.sol";
import {MockStockToken} from "../../src/mocks/MockStockToken.sol";
import {MockUSDG} from "../../src/mocks/MockUSDG.sol";
import {UnderlyingParams, GlobalParams} from "../../src/interfaces/IRiskParams.sol";
import {ISeriesRegistry} from "../../src/interfaces/ISeriesRegistry.sol";
import {Series} from "../../src/types/Types.sol";

contract SeriesRegistryTest is Test {
    SeriesRegistry reg;
    MarketDataHub hub;
    RiskParams rp;
    MockAggregator feed;
    MockStockToken token;
    MockUSDG usdg;

    address constant TREASURY = address(0x2);
    address constant TIMELOCK = address(0x4);
    address constant GUARDIAN = address(0x5);
    address constant SETUP_ADMIN = address(0x6);

    uint256 constant NOW_TS = 1790172000; // 2026-09-23 Wed 14:00 UTC, REGULAR
    uint64 constant EXPIRY = 1790366400; // 2026-09-25 Fri 16:00 EDT
    uint64 constant EXPIRY2 = EXPIRY + 7 days; // 2026-10-02

    function setUp() public {
        usdg = new MockUSDG();
        feed = new MockAggregator(8, "TEST/USD");
        token = new MockStockToken("Test Stock", "TST");
        rp = new RiskParams(address(usdg), TREASURY, address(0), TIMELOCK, GUARDIAN, SETUP_ADMIN, _globals());
        UnderlyingParams memory p = _underlying();
        p.feed = address(feed);
        vm.prank(SETUP_ADMIN);
        rp.addUnderlying(address(token), p);
        hub = new MarketDataHub(rp, new KernelReference());
        reg = new SeriesRegistry(rp, hub);

        vm.warp(NOW_TS);
        feed.pushRound(150e8, NOW_TS);
    }

    function _globals() internal pure returns (GlobalParams memory g) {
        g = GlobalParams({
            mmRatio: 0.75e18,
            diversificationCredit: 0.3e18,
            shortOptionMinPct: 0.01e18,
            feeRate: 0.0003e18,
            feeCapOfPremium: 0.125e18,
            insuranceShare: 0.5e18,
            startDiscount: 0.02e18,
            maxDiscount: 0.12e18,
            maxFractionPerBid: 0.5e18,
            liquidationPenalty: 0.01e18,
            auctionDuration: 1800,
            maxSettlementLag: 87300,
            haltWindow: 3600,
            maxWeeksOut: 1,
            maxStrikeDeviation: 0.5e18,
            rate: 0,
            minTradeQty: 0.01e18,
            dustEquity: 5e18
        });
    }

    function _underlying() internal pure returns (UnderlyingParams memory p) {
        p = UnderlyingParams({
            enabled: true,
            index: 0,
            feed: address(0),
            strikeStep: 5e18,
            volFloor: 0.35e18,
            volCap: 1.5e18,
            lambda: 0.97e18,
            shockK: 3e18,
            minShock: 0.1e18,
            horizonDays: 2,
            volUp: 0.4e18,
            volDown: 0.3e18,
            multExtended: 1.2e18,
            multWeekend: 1.75e18,
            multHoliday: 1.75e18,
            multHalted: 2.5e18,
            maxOpenInterest: 1_000_000e18,
            maxStaleRegular: 300,
            maxStaleExtended: 300,
            maxStaleClosed: 3600,
            volStaleness: 3600,
            minPrice: 20e18,
            maxPrice: 2000e18
        });
    }

    function test_listIdempotent() public {
        uint32 id = reg.listSeries(address(token), EXPIRY, 150e18, true);
        assertEq(id, 1);
        assertEq(reg.listSeries(address(token), EXPIRY, 150e18, true), 1);
        assertEq(reg.seriesCount(), 1);
        assertEq(reg.seriesId(address(token), EXPIRY, 150e18, true), 1);
        assertEq(reg.seriesId(address(token), EXPIRY, 150e18, false), 0);
        assertEq(reg.listSeries(address(token), EXPIRY, 150e18, false), 2);
        Series memory s = reg.series(2);
        assertEq(s.underlying, address(token));
        assertEq(s.expiry, EXPIRY);
        assertEq(s.strike, 150e18);
        assertFalse(s.isCall);
    }

    function test_listEmitsEvent() public {
        vm.expectEmit(true, true, false, true);
        emit ISeriesRegistry.SeriesListed(1, address(token), EXPIRY, 155e18, true);
        reg.listSeries(address(token), EXPIRY, 155e18, true);
    }

    function test_rejectsOffGridStrike() public {
        vm.expectRevert(SeriesRegistry.BadStrike.selector);
        reg.listSeries(address(token), EXPIRY, 152e18, true);
    }

    function test_rejectsZeroStrike() public {
        vm.expectRevert(SeriesRegistry.BadStrike.selector);
        reg.listSeries(address(token), EXPIRY, 0, true);
    }

    function test_rejectsFarStrike() public {
        reg.listSeries(address(token), EXPIRY, 225e18, true); // exactly +50%
        vm.expectRevert(SeriesRegistry.StrikeTooFar.selector);
        reg.listSeries(address(token), EXPIRY, 230e18, true);
        vm.expectRevert(SeriesRegistry.StrikeTooFar.selector);
        reg.listSeries(address(token), EXPIRY, 70e18, true);
    }

    function test_rejectsNonExpiry() public {
        vm.expectRevert(SeriesRegistry.NotWeeklyExpiry.selector);
        reg.listSeries(address(token), EXPIRY + 1 hours, 150e18, true);
    }

    function test_rejectsPastExpiry() public {
        vm.warp(EXPIRY);
        feed.pushRound(150e8, EXPIRY);
        vm.expectRevert(SeriesRegistry.BadExpiry.selector);
        reg.listSeries(address(token), EXPIRY, 150e18, true);
    }

    function test_rejectsTooFarOut() public {
        // maxWeeksOut = 1: EXPIRY2 is 9 days out
        vm.expectRevert(SeriesRegistry.BadExpiry.selector);
        reg.listSeries(address(token), EXPIRY2, 150e18, true);
        reg.listSeries(address(token), EXPIRY, 150e18, true);
    }

    /// maxWeeksOut is inclusive: an expiry exactly maxWeeksOut weeks from now lists, one second
    /// further out doesn't.
    function test_maxWeeksOutBoundaryExact() public {
        // maxWeeksOut = 1: EXPIRY2 is exactly 7 days after EXPIRY
        uint256 boundary = EXPIRY2 - 7 days;
        vm.warp(boundary - 1);
        feed.pushRound(150e8, boundary - 1);
        vm.expectRevert(SeriesRegistry.BadExpiry.selector);
        reg.listSeries(address(token), EXPIRY2, 150e18, true);

        vm.warp(boundary);
        feed.pushRound(150e8, boundary);
        assertEq(reg.listSeries(address(token), EXPIRY2, 150e18, true), 1);
    }

    /// While the underlying can't be priced, listSeries reverts with the hub's NoPrice or
    /// ImplausiblePrice, which the registry's ABI declares.
    function test_rejectsUnpricedUnderlying() public {
        feed.pushRound(0, NOW_TS);
        vm.expectRevert(SeriesRegistry.NoPrice.selector);
        reg.listSeries(address(token), EXPIRY, 150e18, true);
        assertEq(SeriesRegistry.NoPrice.selector, MarketDataHub.NoPrice.selector);

        feed.pushRound(5000e8, NOW_TS); // above maxPrice
        vm.expectRevert(SeriesRegistry.ImplausiblePrice.selector);
        reg.listSeries(address(token), EXPIRY, 150e18, true);
        assertEq(SeriesRegistry.ImplausiblePrice.selector, MarketDataHub.ImplausiblePrice.selector);
        assertEq(reg.seriesCount(), 0);
    }

    function test_rejectsHaltedUnderlying() public {
        token.setPaused(true);
        vm.expectRevert(SeriesRegistry.UnderlyingHalted.selector);
        reg.listSeries(address(token), EXPIRY, 150e18, true);
    }

    function test_rejectsDisabledUnderlying() public {
        UnderlyingParams memory p = rp.underlying(address(token));
        p.enabled = false;
        vm.prank(TIMELOCK);
        rp.setUnderlying(address(token), p);
        vm.expectRevert(SeriesRegistry.UnderlyingDisabled.selector);
        reg.listSeries(address(token), EXPIRY, 150e18, true);
    }

    function test_settleOnceThenAlreadySettled() public {
        feed.pushRound(151e8, EXPIRY - 120);
        feed.pushRound(152e8, EXPIRY + 300);
        vm.warp(EXPIRY);
        (uint256 p0, bool s0) = reg.settlementPriceOf(address(token), EXPIRY);
        assertEq(p0, 0);
        assertFalse(s0);

        vm.expectEmit(true, true, false, true);
        emit ISeriesRegistry.ExpirySettled(address(token), EXPIRY, 151e18, _rid(1, 2), false);
        assertEq(reg.settleExpiry(address(token), EXPIRY, _rid(1, 2)), 151e18);

        (uint256 p1, bool s1) = reg.settlementPriceOf(address(token), EXPIRY);
        assertEq(p1, 151e18);
        assertTrue(s1);

        vm.expectRevert(SeriesRegistry.AlreadySettled.selector);
        reg.settleExpiry(address(token), EXPIRY, _rid(1, 2));
        vm.expectRevert(SeriesRegistry.AlreadySettled.selector);
        reg.settleExpiryFallback(address(token), EXPIRY, _rid(1, 3));
    }

    function test_settlementVisibleForAllSeriesOfExpiry() public {
        reg.listSeries(address(token), EXPIRY, 150e18, true);
        reg.listSeries(address(token), EXPIRY, 155e18, false);
        feed.pushRound(151e8, EXPIRY - 120);
        feed.pushRound(152e8, EXPIRY + 300);
        vm.warp(EXPIRY + 400);
        reg.settleExpiry(address(token), EXPIRY, _rid(1, 2));
        Series memory a = reg.series(1);
        Series memory b = reg.series(2);
        (uint256 pa, bool sa) = reg.settlementPriceOf(a.underlying, a.expiry);
        (uint256 pb, bool sb) = reg.settlementPriceOf(b.underlying, b.expiry);
        assertEq(pa, 151e18);
        assertEq(pb, 151e18);
        assertTrue(sa && sb);
    }

    function test_settleBadHintReverts() public {
        feed.pushRound(151e8, EXPIRY - 120);
        feed.pushRound(152e8, EXPIRY + 300);
        vm.warp(EXPIRY);
        vm.expectRevert(MarketDataHub.BadHint.selector);
        reg.settleExpiry(address(token), EXPIRY, _rid(1, 3));
    }

    function test_fallbackSettlementWhenPreCloseStale() public {
        feed.pushRound(151e8, EXPIRY - 2 days); // (1,2) stale predecessor
        feed.pushRound(155e8, EXPIRY + 10 hours); // (1,3)
        vm.warp(EXPIRY + 72 hours);
        vm.expectEmit(true, true, false, true);
        emit ISeriesRegistry.ExpirySettled(address(token), EXPIRY, 155e18, _rid(1, 3), true);
        assertEq(reg.settleExpiryFallback(address(token), EXPIRY, _rid(1, 3)), 155e18);
        (uint256 p, bool s) = reg.settlementPriceOf(address(token), EXPIRY);
        assertEq(p, 155e18);
        assertTrue(s);
    }

    function test_fallbackRejectedWhenPreCloseValid() public {
        feed.pushRound(151e8, EXPIRY - 60);
        feed.pushRound(155e8, EXPIRY + 10 hours);
        vm.warp(EXPIRY + 72 hours);
        vm.expectRevert(MarketDataHub.FallbackNotAllowed.selector);
        reg.settleExpiryFallback(address(token), EXPIRY, _rid(1, 3));
    }

    function _rid(uint16 phase, uint64 n) internal pure returns (uint80) {
        return (uint80(phase) << 64) | uint80(n);
    }
}
