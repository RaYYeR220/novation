// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {MarketDataHub} from "../../src/core/MarketDataHub.sol";
import {RiskParams} from "../../src/core/RiskParams.sol";
import {KernelReference} from "../../src/kernel/KernelReference.sol";
import {MockAggregator} from "../../src/mocks/MockAggregator.sol";
import {MockStockToken} from "../../src/mocks/MockStockToken.sol";
import {MockUSDG} from "../../src/mocks/MockUSDG.sol";
import {UnderlyingParams, GlobalParams} from "../../src/interfaces/IRiskParams.sol";
import {Session} from "../../src/types/Types.sol";

/// @notice A stock-token stand-in whose paused() always reverts, to test the
/// fail-closed "either call reverts" halt rule.
contract RevertingPausedToken {
    error NotImplemented();

    function uiMultiplier() external pure returns (uint256) {
        return 1e18;
    }

    function newUIMultiplier() external pure returns (uint256) {
        return 1e18;
    }

    function effectiveAt() external pure returns (uint256) {
        return 0;
    }

    function paused() external pure returns (bool) {
        revert NotImplemented();
    }

    function oraclePaused() external pure returns (bool) {
        return false;
    }
}

contract MarketDataHubTest is Test {
    MarketDataHub hub;
    RiskParams rp;
    KernelReference kernel;
    MockAggregator feed;
    MockStockToken token;
    MockUSDG usdg;

    address constant TREASURY = address(0x2);
    address constant TIMELOCK = address(0x4);
    address constant GUARDIAN = address(0x5);
    address constant SETUP_ADMIN = address(0x6);

    uint256 constant REGULAR_TS = 1790344800; // 2026-09-25 Fri 14:00 UTC = 10:00 EDT
    uint256 constant WEEKEND_TS = 1790434800; // 2026-09-26 Sat 15:00 UTC
    uint256 constant EXPIRY = 1790366400; // 2026-09-25 Fri 16:00 EDT close (weekly expiry)

    function setUp() public {
        kernel = new KernelReference();
        usdg = new MockUSDG();
        feed = new MockAggregator(8, "TEST/USD");
        token = new MockStockToken("Test Stock", "TST");

        rp = new RiskParams(address(usdg), TREASURY, address(0), TIMELOCK, GUARDIAN, SETUP_ADMIN, _validGlobals());

        UnderlyingParams memory p = _validUnderlying();
        p.feed = address(feed);
        vm.prank(SETUP_ADMIN);
        rp.addUnderlying(address(token), p);

        hub = new MarketDataHub(rp, kernel);
    }

    // ---- fixtures ----

    function _validGlobals() internal pure returns (GlobalParams memory g) {
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
            maxSettlementLag: 87300, // 24h15m
            haltWindow: 3600,
            maxWeeksOut: 6,
            maxStrikeDeviation: 0.5e18,
            rate: 0,
            minTradeQty: 0.01e18,
            dustEquity: 5e18
        });
    }

    function _validUnderlying() internal pure returns (UnderlyingParams memory p) {
        p = UnderlyingParams({
            enabled: true,
            index: 0,
            feed: address(0), // overwritten by caller
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

    function _roundId(uint16 phase, uint64 n) internal pure returns (uint80) {
        return (uint80(phase) << 64) | uint80(n);
    }

    // ---- spot / session ----

    function test_spotScalesDecimals() public {
        vm.warp(REGULAR_TS);
        feed.pushRound(150_00000000, REGULAR_TS); // $150.00 at 8 decimals

        (uint256 price, Session s, bool ok) = hub.spot(address(token));
        assertEq(price, 150e18);
        assertEq(uint8(s), uint8(Session.REGULAR));
        assertTrue(ok);
    }

    function test_staleRegularHalts() public {
        vm.warp(REGULAR_TS);
        feed.pushRound(150e8, REGULAR_TS - 301); // maxStaleRegular = 300
        assertEq(uint8(hub.session(address(token))), uint8(Session.HALTED));
    }

    function test_staleWeekendToleratedUntilClosedLimit() public {
        vm.warp(WEEKEND_TS);
        feed.pushRound(150e8, WEEKEND_TS - 3600); // exactly at maxStaleClosed, still ok
        assertEq(uint8(hub.session(address(token))), uint8(Session.WEEKEND));

        feed.pushRound(150e8, WEEKEND_TS - 3601); // over the limit
        assertEq(uint8(hub.session(address(token))), uint8(Session.HALTED));
    }

    function test_pausedTokenHalts() public {
        vm.warp(REGULAR_TS);
        feed.pushRound(150e8, REGULAR_TS);
        token.setPaused(true);
        assertEq(uint8(hub.session(address(token))), uint8(Session.HALTED));
    }

    function test_pausedCallRevertHalts() public {
        MockAggregator feed2 = new MockAggregator(8, "TEST2/USD");
        RevertingPausedToken badToken = new RevertingPausedToken();

        UnderlyingParams memory p = _validUnderlying();
        p.feed = address(feed2);
        vm.prank(SETUP_ADMIN);
        rp.addUnderlying(address(badToken), p);

        vm.warp(REGULAR_TS);
        feed2.pushRound(150e8, REGULAR_TS);
        assertEq(uint8(hub.session(address(badToken))), uint8(Session.HALTED));
    }

    function test_oraclePausedHalts() public {
        vm.warp(REGULAR_TS);
        feed.pushRound(150e8, REGULAR_TS);
        token.setOraclePaused(true);
        assertEq(uint8(hub.session(address(token))), uint8(Session.HALTED));
    }

    function test_multiplierWindowHalts() public {
        vm.warp(REGULAR_TS);
        feed.pushRound(150e8, REGULAR_TS);
        uint256 ea = REGULAR_TS + 100;
        token.setUiMultiplier(1e18, 1.05e18, ea);
        assertEq(uint8(hub.session(address(token))), uint8(Session.HALTED));

        uint256 later = ea + 3600 + 1; // haltWindow + 3600 grace elapsed past ea
        vm.warp(later);
        feed.pushRound(150e8, later);
        assertEq(uint8(hub.session(address(token))), uint8(Session.REGULAR));
    }

    function test_sequencerDownHalts() public {
        (RiskParams rp2, MarketDataHub hub2, MockAggregator seqFeed) = _deployWithSequencer();

        vm.warp(REGULAR_TS);
        feed.pushRound(150e8, REGULAR_TS);
        seqFeed.pushRound(1, REGULAR_TS - 10000); // answer == 1 -> down
        assertEq(uint8(hub2.session(address(token))), uint8(Session.HALTED));
        rp2; // silence unused warning if any
    }

    function test_sequencerGracePeriodHalts() public {
        (, MarketDataHub hub2, MockAggregator seqFeed) = _deployWithSequencer();

        vm.warp(REGULAR_TS);
        feed.pushRound(150e8, REGULAR_TS);
        seqFeed.pushRound(0, REGULAR_TS - 1000); // up, but started too recently
        assertEq(uint8(hub2.session(address(token))), uint8(Session.HALTED));

        uint256 t2 = REGULAR_TS - 1000 + 3600; // grace period elapsed
        vm.warp(t2);
        feed.pushRound(150e8, t2);
        assertEq(uint8(hub2.session(address(token))), uint8(Session.REGULAR));
    }

    function test_implausiblePriceHaltsAndSpotReverts() public {
        vm.warp(REGULAR_TS);
        feed.pushRound(1e8, REGULAR_TS); // $1, below minPrice = 20e18
        assertEq(uint8(hub.session(address(token))), uint8(Session.HALTED));

        vm.expectRevert(MarketDataHub.ImplausiblePrice.selector);
        hub.spot(address(token));
    }

    function _deployWithSequencer() internal returns (RiskParams rp2, MarketDataHub hub2, MockAggregator seqFeed) {
        seqFeed = new MockAggregator(0, "SEQ");
        rp2 =
            new RiskParams(address(usdg), TREASURY, address(seqFeed), TIMELOCK, GUARDIAN, SETUP_ADMIN, _validGlobals());
        UnderlyingParams memory p = _validUnderlying();
        p.feed = address(feed);
        vm.prank(SETUP_ADMIN);
        rp2.addUnderlying(address(token), p);
        hub2 = new MarketDataHub(rp2, kernel);
    }

    // ---- vol ----

    function test_markVolDefaultsToCapUntilInit() public {
        assertEq(hub.markVol(address(token)), 1.5e18); // volCap
    }

    function test_pokeVolConsecutiveOnly() public {
        vm.warp(REGULAR_TS);
        feed.pushRound(150e8, REGULAR_TS); // round (1,1)
        hub.initVol(address(token));

        feed.pushRound(151e8, REGULAR_TS + 10); // round (1,2)
        feed.pushRound(152e8, REGULAR_TS + 20); // round (1,3)

        uint80[] memory skipIds = new uint80[](1);
        skipIds[0] = _roundId(1, 3); // skips round 2
        vm.expectRevert(MarketDataHub.NonConsecutiveRound.selector);
        hub.pokeVol(address(token), skipIds);

        feed.setPhase(2);
        feed.pushRound(160e8, REGULAR_TS + 30); // round (2,1)
        uint80[] memory crossPhaseIds = new uint80[](1);
        crossPhaseIds[0] = _roundId(2, 1);
        vm.expectRevert(MarketDataHub.NonConsecutiveRound.selector);
        hub.pokeVol(address(token), crossPhaseIds);
    }

    function test_pokeVolMatchesKernel() public {
        vm.warp(REGULAR_TS);
        feed.pushRound(150e8, REGULAR_TS);
        hub.initVol(address(token));

        (uint256 r2_0, uint256 dt_0,, uint256 lastPrice_0,,) = hub.volState(address(token));

        feed.pushRound(151e8, REGULAR_TS + 100);
        feed.pushRound(152e8, REGULAR_TS + 250);

        uint80[] memory ids = new uint80[](2);
        ids[0] = _roundId(1, 2);
        ids[1] = _roundId(1, 3);
        hub.pokeVol(address(token), ids);

        uint256[] memory prices = new uint256[](2);
        prices[0] = 151e8;
        prices[1] = 152e8;
        uint256[] memory dts = new uint256[](2);
        dts[0] = 100;
        dts[1] = 150;

        (uint256 expR2, uint256 expDt) = kernel.ewmaUpdate(r2_0, dt_0, lastPrice_0, prices, dts, 0.97e18);

        (uint256 r2, uint256 dt, uint80 lastRoundId, uint256 lastPrice, uint64 lastUpdatedAt,) =
            hub.volState(address(token));
        assertEq(r2, expR2);
        assertEq(dt, expDt);
        assertEq(lastRoundId, ids[1]);
        assertEq(lastPrice, 152e8);
        assertEq(lastUpdatedAt, REGULAR_TS + 250);
    }

    function test_markVolStaleFallsBackToCap() public {
        vm.warp(REGULAR_TS);
        feed.pushRound(150e8, REGULAR_TS);
        hub.initVol(address(token));

        vm.warp(REGULAR_TS + 3601); // volStaleness = 3600
        assertEq(hub.markVol(address(token)), 1.5e18); // volCap fallback
    }

    function test_rebaseAfterPhaseChange() public {
        vm.warp(REGULAR_TS);
        feed.pushRound(150e8, REGULAR_TS);
        hub.initVol(address(token));

        vm.expectRevert(MarketDataHub.NoPhaseChange.selector);
        hub.rebaseVol(address(token));

        (uint256 r2Before, uint256 dtBefore,,,,) = hub.volState(address(token));

        feed.setPhase(2);
        feed.pushRound(160e8, REGULAR_TS + 500);

        hub.rebaseVol(address(token));

        (uint256 r2After, uint256 dtAfter, uint80 lastRoundId, uint256 lastPrice, uint64 lastUpdatedAt,) =
            hub.volState(address(token));
        assertEq(r2After, r2Before);
        assertEq(dtAfter, dtBefore);
        assertEq(lastRoundId, _roundId(2, 1));
        assertEq(lastPrice, 160e8);
        assertEq(lastUpdatedAt, REGULAR_TS + 500);
    }

    function test_pokeVolRejectsNonexistentRound() public {
        vm.warp(REGULAR_TS);
        feed.pushRound(150e8, REGULAR_TS);
        hub.initVol(address(token));

        uint80[] memory ids = new uint80[](1);
        ids[0] = _roundId(1, 2); // consecutive numbering, never pushed -> zeros
        vm.expectRevert(MarketDataHub.InvalidRound.selector);
        hub.pokeVol(address(token), ids);
    }

    // ---- settlement ----

    function test_settlementPriceHappyPath() public {
        feed.pushRound(150e8, EXPIRY - 120); // hint round
        feed.pushRound(151e8, EXPIRY + 300); // proof: next round after expiry
        vm.warp(EXPIRY);

        uint256 price = hub.settlementPrice(address(token), uint64(EXPIRY), _roundId(1, 1));
        assertEq(price, 150e18);
    }

    function test_settlementRejectsLateHint() public {
        feed.pushRound(150e8, EXPIRY + 10); // updatedAt > expiry
        vm.warp(EXPIRY);

        vm.expectRevert(MarketDataHub.BadHint.selector);
        hub.settlementPrice(address(token), uint64(EXPIRY), _roundId(1, 1));
    }

    function test_settlementRejectsNotLastRound() public {
        feed.pushRound(150e8, EXPIRY - 200); // round 1
        feed.pushRound(151e8, EXPIRY - 100); // round 2, still <= expiry
        vm.warp(EXPIRY);

        vm.expectRevert(MarketDataHub.NextRoundMissing.selector);
        hub.settlementPrice(address(token), uint64(EXPIRY), _roundId(1, 1));
    }

    function test_settlementRejectsLag() public {
        feed.pushRound(150e8, EXPIRY - 25 hours); // 90000s > 87300s maxSettlementLag
        vm.warp(EXPIRY);

        vm.expectRevert(MarketDataHub.BadHint.selector);
        hub.settlementPrice(address(token), uint64(EXPIRY), _roundId(1, 1));
    }

    function test_settlementWithLatestRoundAfterClose() public {
        feed.pushRound(150e8, EXPIRY - 120); // only round so far
        vm.warp(EXPIRY);

        uint256 price = hub.settlementPrice(address(token), uint64(EXPIRY), _roundId(1, 1));
        assertEq(price, 150e18);
    }

    function test_settlementNextRoundZeroesTreatedAsMissing() public {
        feed.pushRound(150e8, EXPIRY - 120);
        uint80 hint = _roundId(1, 1);

        (, int256 nextAnswer,, uint256 nextUpdatedAt,) = feed.getRoundData(hint + 1);
        assertEq(nextAnswer, 0);
        assertEq(nextUpdatedAt, 0);

        vm.warp(EXPIRY);
        uint256 price = hub.settlementPrice(address(token), uint64(EXPIRY), hint);
        assertEq(price, 150e18);
    }

    function test_settlementTooEarly() public {
        feed.pushRound(150e8, EXPIRY - 120);
        vm.warp(EXPIRY - 1);

        vm.expectRevert(MarketDataHub.TooEarly.selector);
        hub.settlementPrice(address(token), uint64(EXPIRY), _roundId(1, 1));
    }
}
