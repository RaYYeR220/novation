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
import {IMarketDataHub} from "../../src/interfaces/IMarketDataHub.sol";

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

/// @notice No paused(), but a silent fallback that returns empty data.
contract FallbackToken {
    function uiMultiplier() external pure returns (uint256) {
        return 1e18;
    }

    function newUIMultiplier() external pure returns (uint256) {
        return 1e18;
    }

    function effectiveAt() external pure returns (uint256) {
        return 0;
    }

    function oraclePaused() external pure returns (bool) {
        return false;
    }

    fallback() external {}
}

/// @notice Implements the pause getters but not effectiveAt().
contract NoEffectiveAtToken {
    function paused() external pure returns (bool) {
        return false;
    }

    function oraclePaused() external pure returns (bool) {
        return false;
    }
}

/// @notice oraclePaused() always reverts.
contract RevertingOracleToken {
    error NotImplemented();

    function paused() external pure returns (bool) {
        return false;
    }

    function oraclePaused() external pure returns (bool) {
        revert NotImplemented();
    }

    function effectiveAt() external pure returns (uint256) {
        return 0;
    }
}

/// @notice A feed whose latestRoundData() returns two words instead of five.
contract ShortRoundFeed {
    function decimals() external pure returns (uint8) {
        return 8;
    }

    fallback() external {
        assembly {
            mstore(0, 1)
            mstore(0x20, 15000000000)
            return(0, 0x40)
        }
    }
}

/// @notice A feed with configurable raw return words: decimals() as a full word (a value above
/// 255 can't decode as uint8) and any answer and round ids.
contract RawFeed {
    uint256 public dec = 8;
    int256 public answer = 150e8;
    uint256 public roundWord = 1;
    uint256 public startedAt;

    function set(uint256 dec_, int256 answer_, uint256 roundWord_, uint256 startedAt_) external {
        (dec, answer, roundWord, startedAt) = (dec_, answer_, roundWord_, startedAt_);
    }

    function decimals() external view returns (uint256) {
        return dec;
    }

    function latestRoundData() external view returns (uint256, int256, uint256, uint256, uint256) {
        return (roundWord, answer, startedAt, block.timestamp, roundWord);
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

    function test_noPriceHalts() public {
        vm.warp(REGULAR_TS);
        feed.pushRound(0, REGULAR_TS); // answer <= 0
        assertEq(uint8(hub.session(address(token))), uint8(Session.HALTED));

        vm.expectRevert(MarketDataHub.NoPrice.selector);
        hub.spot(address(token));
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
        (, MarketDataHub hub2, MockAggregator seqFeed) = _deployWithSequencer();

        vm.warp(REGULAR_TS);
        feed.pushRound(150e8, REGULAR_TS);
        seqFeed.pushRound(1, REGULAR_TS - 10000); // answer == 1 -> down
        assertEq(uint8(hub2.session(address(token))), uint8(Session.HALTED));
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
        prices[0] = 151e18;
        prices[1] = 152e18;
        uint256[] memory dts = new uint256[](2);
        dts[0] = 100;
        dts[1] = 150;

        (uint256 expR2, uint256 expDt) = kernel.ewmaUpdate(r2_0, dt_0, lastPrice_0, prices, dts, 0.97e18);

        (uint256 r2, uint256 dt, uint80 lastRoundId, uint256 lastPrice, uint64 lastUpdatedAt,) =
            hub.volState(address(token));
        assertEq(r2, expR2);
        assertEq(dt, expDt);
        assertEq(lastRoundId, ids[1]);
        assertEq(lastPrice, 152e18);
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
        assertEq(lastPrice, 160e18);
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
        vm.warp(EXPIRY + 1);

        uint256 price = hub.settlementPrice(address(token), uint64(EXPIRY), _roundId(1, 1));
        assertEq(price, 150e18);
    }

    function test_settlementNextRoundZeroesTreatedAsMissing() public {
        feed.pushRound(150e8, EXPIRY - 120);
        uint80 hint = _roundId(1, 1);

        (, int256 nextAnswer,, uint256 nextUpdatedAt,) = feed.getRoundData(hint + 1);
        assertEq(nextAnswer, 0);
        assertEq(nextUpdatedAt, 0);

        vm.warp(EXPIRY + 1);
        assertEq(hub.settlementPrice(address(token), uint64(EXPIRY), hint), 150e18);
    }

    // hint+1 reads zeros but hint is not the latest round (next phase printed before the close)
    function test_settlementNextRoundZeroesNotLatestReverts() public {
        feed.pushRound(150e8, EXPIRY - 200); // (1,1)
        feed.setPhase(2);
        feed.pushRound(151e8, EXPIRY - 100); // (2,1), not after expiry
        vm.warp(EXPIRY + 1);
        vm.expectRevert(MarketDataHub.NextRoundMissing.selector);
        hub.settlementPrice(address(token), uint64(EXPIRY), _roundId(1, 1));
    }

    function test_settlementTooEarly() public {
        feed.pushRound(150e8, EXPIRY - 120);
        vm.warp(EXPIRY - 1);

        vm.expectRevert(MarketDataHub.TooEarly.selector);
        hub.settlementPrice(address(token), uint64(EXPIRY), _roundId(1, 1));
    }

    // ================= fix round: helpers =================

    function _addUnderlying(address t, address f) internal {
        UnderlyingParams memory p = _validUnderlying();
        p.feed = f;
        vm.prank(SETUP_ADMIN);
        rp.addUnderlying(t, p);
    }

    function _pokeN(uint64 firstN, uint64 count) internal {
        uint80[] memory ids = new uint80[](count);
        for (uint64 i = 0; i < count; i++) {
            ids[i] = _roundId(1, firstN + i);
        }
        hub.pokeVol(address(token), ids);
    }

    // ================= A. settlement =================

    function test_settlementSameSecondRace() public {
        feed.pushRound(150e8, EXPIRY - 120);
        vm.warp(EXPIRY);
        // rule (ii) is not allowed at T == expiry: a round with updatedAt == expiry could still land
        vm.expectRevert(MarketDataHub.NextRoundMissing.selector);
        hub.settlementPrice(address(token), uint64(EXPIRY), _roundId(1, 1));

        feed.pushRound(152e8, EXPIRY); // same second
        vm.expectRevert(MarketDataHub.NextRoundMissing.selector);
        hub.settlementPrice(address(token), uint64(EXPIRY), _roundId(1, 1));
        vm.expectRevert(MarketDataHub.NextRoundMissing.selector);
        hub.settlementPrice(address(token), uint64(EXPIRY), _roundId(1, 2));

        vm.warp(EXPIRY + 1);
        assertEq(hub.settlementPrice(address(token), uint64(EXPIRY), _roundId(1, 2)), 152e18);
    }

    function test_settlementAcrossPhaseChange() public {
        feed.pushRound(150e8, EXPIRY - 120); // (1,1) true last print
        feed.setPhase(2);
        feed.pushRound(151e8, EXPIRY + 2 days); // (2,1)
        vm.warp(EXPIRY + 2 days + 10);
        assertEq(hub.settlementPrice(address(token), uint64(EXPIRY), _roundId(1, 1)), 150e18);
        // a hint already after the close is still a bad hint
        vm.expectRevert(MarketDataHub.BadHint.selector);
        hub.settlementPrice(address(token), uint64(EXPIRY), _roundId(2, 1));
    }

    /// Review PoC: during an aggregator migration the old phase can keep printing after the new
    /// one already holds the true last print before the close. An old-phase hint whose successor
    /// printed after the close must not prove (proof (i)) while the later phase began before it.
    function test_settlementOldPhaseRoundRejectedDuringMigration() public {
        feed.pushRound(170e8, EXPIRY - 2 hours); // (1,1), the old aggregator
        feed.setPhase(2);
        feed.pushRound(200e8, EXPIRY - 5 minutes); // (2,1), the true last print
        feed.setPhase(1);
        feed.pushRound(171e8, EXPIRY + 1 hours); // (1,2), the old aggregator keeps printing
        feed.setPhase(2);
        vm.warp(EXPIRY + 2 hours);
        vm.expectRevert(MarketDataHub.NextRoundMissing.selector);
        hub.settlementPrice(address(token), uint64(EXPIRY), _roundId(1, 1));
        assertEq(hub.settlementPrice(address(token), uint64(EXPIRY), _roundId(2, 1)), 200e18);
    }

    function test_settlementRejectsOldPhaseHintWithoutProof() public {
        feed.pushRound(150e8, EXPIRY - 300); // (1,1)
        feed.pushRound(151e8, EXPIRY - 100); // (1,2) real last pre-close print
        feed.setPhase(2);
        feed.pushRound(152e8, EXPIRY + 1 hours); // (2,1)
        vm.warp(EXPIRY + 2 hours);
        // (1,1): next round exists but is pre-close
        vm.expectRevert(MarketDataHub.NextRoundMissing.selector);
        hub.settlementPrice(address(token), uint64(EXPIRY), _roundId(1, 1));
        // (1,2): zeros after it, older phase, (2,1) printed after expiry -> proof (iii)
        assertEq(hub.settlementPrice(address(token), uint64(EXPIRY), _roundId(1, 2)), 151e18);
    }

    function test_settlementRejectsImplausibleBand() public {
        feed.pushRound(150e18, EXPIRY - 120); // far above maxPrice
        vm.warp(EXPIRY + 1);
        vm.expectRevert(MarketDataHub.ImplausiblePrice.selector);
        hub.settlementPrice(address(token), uint64(EXPIRY), _roundId(1, 1));

        MockAggregator f2 = new MockAggregator(8, "LOW");
        MockStockToken t2 = new MockStockToken("L", "L");
        _addUnderlying(address(t2), address(f2));
        f2.pushRound(1e8, EXPIRY - 120); // $1 below minPrice
        vm.expectRevert(MarketDataHub.ImplausiblePrice.selector);
        hub.settlementPrice(address(t2), uint64(EXPIRY), _roundId(1, 1));
    }

    function test_settlementNotExpiry() public {
        feed.pushRound(150e8, EXPIRY - 120);
        vm.warp(EXPIRY + 1);
        vm.expectRevert(MarketDataHub.NotExpiry.selector);
        hub.settlementPrice(address(token), uint64(EXPIRY + 1), _roundId(1, 1));
    }

    function test_settlementHintNonexistent() public {
        feed.pushRound(150e8, EXPIRY - 120);
        vm.warp(EXPIRY + 1);
        vm.expectRevert(MarketDataHub.BadHint.selector);
        hub.settlementPrice(address(token), uint64(EXPIRY), _roundId(1, 9));
    }

    function test_settlementUpdatedAtEqualsExpiryAccepted() public {
        feed.pushRound(150e8, EXPIRY);
        vm.warp(EXPIRY + 1);
        assertEq(hub.settlementPrice(address(token), uint64(EXPIRY), _roundId(1, 1)), 150e18);
    }

    function test_settlementLagBoundary() public {
        feed.pushRound(150e8, EXPIRY - 87300); // lag == max
        vm.warp(EXPIRY + 1);
        assertEq(hub.settlementPrice(address(token), uint64(EXPIRY), _roundId(1, 1)), 150e18);

        MockAggregator f2 = new MockAggregator(8, "LAG");
        MockStockToken t2 = new MockStockToken("L", "L");
        _addUnderlying(address(t2), address(f2));
        f2.pushRound(150e8, EXPIRY - 87301); // lag == max + 1
        vm.expectRevert(MarketDataHub.BadHint.selector);
        hub.settlementPrice(address(t2), uint64(EXPIRY), _roundId(1, 1));
    }

    // ---- fallback (iv) ----

    function test_fallbackAllowedWhenPreClosePrintStale() public {
        feed.pushRound(150e8, EXPIRY - 2 days); // stale predecessor
        feed.pushRound(155e8, EXPIRY + 10 hours);
        vm.warp(EXPIRY + 72 hours);
        assertEq(hub.settlementPriceFallback(address(token), uint64(EXPIRY), _roundId(1, 2)), 155e18);
    }

    function test_fallbackAllowedWhenPreClosePrintImplausible() public {
        feed.pushRound(1e8, EXPIRY - 60); // $1, outside band
        feed.pushRound(155e8, EXPIRY + 10 hours);
        vm.warp(EXPIRY + 72 hours);
        assertEq(hub.settlementPriceFallback(address(token), uint64(EXPIRY), _roundId(1, 2)), 155e18);
    }

    function test_fallbackRejectedWhenPreClosePrintValid() public {
        feed.pushRound(150e8, EXPIRY - 60);
        feed.pushRound(155e8, EXPIRY + 10 hours);
        vm.warp(EXPIRY + 72 hours);
        vm.expectRevert(MarketDataHub.FallbackNotAllowed.selector);
        hub.settlementPriceFallback(address(token), uint64(EXPIRY), _roundId(1, 2));
    }

    function test_fallbackRejectedBefore72h() public {
        feed.pushRound(150e8, EXPIRY - 2 days);
        feed.pushRound(155e8, EXPIRY + 10 hours);
        vm.warp(EXPIRY + 72 hours - 1);
        vm.expectRevert(MarketDataHub.TooEarly.selector);
        hub.settlementPriceFallback(address(token), uint64(EXPIRY), _roundId(1, 2));
    }

    function test_fallbackRejectedIfNotFirstAfter() public {
        feed.pushRound(150e8, EXPIRY - 2 days); // (1,1)
        feed.pushRound(155e8, EXPIRY + 10 hours); // (1,2) first after
        feed.pushRound(156e8, EXPIRY + 11 hours); // (1,3)
        vm.warp(EXPIRY + 72 hours);
        vm.expectRevert(MarketDataHub.NotFirstAfter.selector);
        hub.settlementPriceFallback(address(token), uint64(EXPIRY), _roundId(1, 3));
        // a pre-close round is not a valid first-after either
        vm.expectRevert(MarketDataHub.BadHint.selector);
        hub.settlementPriceFallback(address(token), uint64(EXPIRY), _roundId(1, 1));
    }

    function test_fallbackAcrossPhaseBoundary() public {
        feed.pushRound(150e8, EXPIRY - 3 days); // (1,1)
        feed.pushRound(151e8, EXPIRY - 2 days); // (1,2) last of phase 1, stale
        feed.setPhase(2);
        feed.pushRound(155e8, EXPIRY + 10 hours); // (2,1)
        vm.warp(EXPIRY + 72 hours);
        assertEq(hub.settlementPriceFallback(address(token), uint64(EXPIRY), _roundId(2, 1)), 155e18);
    }

    function test_fallbackRejectsImplausibleFirstAfter() public {
        feed.pushRound(150e8, EXPIRY - 2 days);
        feed.pushRound(1e8, EXPIRY + 10 hours); // $1
        vm.warp(EXPIRY + 72 hours);
        vm.expectRevert(MarketDataHub.ImplausiblePrice.selector);
        hub.settlementPriceFallback(address(token), uint64(EXPIRY), _roundId(1, 2));
    }

    function test_fallbackNotExpiry() public {
        vm.warp(EXPIRY + 72 hours);
        vm.expectRevert(MarketDataHub.NotExpiry.selector);
        hub.settlementPriceFallback(address(token), uint64(EXPIRY + 1), _roundId(1, 2));
    }

    // ================= B. session never reverts =================

    function test_emptyPausedReturnHalts() public {
        MockAggregator f2 = new MockAggregator(8, "F2");
        FallbackToken t = new FallbackToken();
        _addUnderlying(address(t), address(f2));
        vm.warp(REGULAR_TS);
        f2.pushRound(150e8, REGULAR_TS);
        assertEq(uint8(hub.session(address(t))), uint8(Session.HALTED));
    }

    function test_effectiveAtMissingHalts() public {
        MockAggregator f2 = new MockAggregator(8, "F2");
        NoEffectiveAtToken t = new NoEffectiveAtToken();
        _addUnderlying(address(t), address(f2));
        vm.warp(REGULAR_TS);
        f2.pushRound(150e8, REGULAR_TS);
        assertEq(uint8(hub.session(address(t))), uint8(Session.HALTED));
    }

    function test_oraclePausedCallRevertHalts() public {
        MockAggregator f2 = new MockAggregator(8, "F2");
        RevertingOracleToken t = new RevertingOracleToken();
        _addUnderlying(address(t), address(f2));
        vm.warp(REGULAR_TS);
        f2.pushRound(150e8, REGULAR_TS);
        assertEq(uint8(hub.session(address(t))), uint8(Session.HALTED));
    }

    function test_decimalsAbove18HaltsAndSpotNoPrice() public {
        MockAggregator f2 = new MockAggregator(20, "F20");
        MockStockToken t = new MockStockToken("X", "X");
        _addUnderlying(address(t), address(f2));
        vm.warp(REGULAR_TS);
        f2.pushRound(150e20, REGULAR_TS);
        assertEq(uint8(hub.session(address(t))), uint8(Session.HALTED));
        vm.expectRevert(MarketDataHub.NoPrice.selector);
        hub.spot(address(t));
    }

    /// A configured feed that can't be decoded (no code, short return data, a word out of its
    /// type's range, an absurd answer) halts its underlying: session() reads HALTED and spot()
    /// reverts NoPrice, instead of every caller reverting on the decode.
    function test_undecodableFeedHalts() public {
        vm.warp(REGULAR_TS);
        MockStockToken t1 = new MockStockToken("A", "A");
        MockStockToken t2 = new MockStockToken("B", "B");
        MockStockToken t3 = new MockStockToken("C", "C");
        RawFeed raw = new RawFeed();
        _addUnderlying(address(t1), address(0xFEED)); // no code at all
        _addUnderlying(address(t2), address(new ShortRoundFeed()));
        _addUnderlying(address(t3), address(raw));

        // the raw feed starts out readable
        (uint256 price,, bool ok) = hub.spot(address(t3));
        assertEq(price, 150e18);
        assertTrue(ok);

        address[2] memory broken = [address(t1), address(t2)];
        for (uint256 i = 0; i < broken.length; ++i) {
            assertEq(uint8(hub.session(broken[i])), uint8(Session.HALTED));
            vm.expectRevert(MarketDataHub.NoPrice.selector);
            hub.spot(broken[i]);
        }

        raw.set(256, 150e8, 1, 0); // decimals() doesn't fit a uint8
        _assertNoPrice(address(t3));
        raw.set(8, 150e8, 1 << 80, 0); // a round id word beyond uint80 is ignored
        (price,, ok) = hub.spot(address(t3));
        assertEq(price, 150e18);
        assertTrue(ok);
        raw.set(0, int256(uint256(type(uint128).max) + 1), 1, 0); // would overflow the WAD price
        _assertNoPrice(address(t3));
        raw.set(18, type(int256).min, 1, 0);
        _assertNoPrice(address(t3));
    }

    function _assertNoPrice(address t) internal {
        assertEq(uint8(hub.session(t)), uint8(Session.HALTED));
        vm.expectRevert(MarketDataHub.NoPrice.selector);
        hub.spot(t);
    }

    /// An unreadable or undecodable sequencer feed reads as down, and a startedAt far in the
    /// future can't overflow the grace-period check.
    function test_undecodableSequencerFeedHalts() public {
        RawFeed seq = new RawFeed();
        RiskParams rp2 =
            new RiskParams(address(usdg), TREASURY, address(seq), TIMELOCK, GUARDIAN, SETUP_ADMIN, _validGlobals());
        UnderlyingParams memory p = _validUnderlying();
        p.feed = address(feed);
        vm.prank(SETUP_ADMIN);
        rp2.addUnderlying(address(token), p);
        MarketDataHub hub2 = new MarketDataHub(rp2, kernel);

        vm.warp(REGULAR_TS);
        feed.pushRound(150e8, REGULAR_TS);
        seq.set(0, 0, 1, REGULAR_TS - 10000); // up for long enough
        assertEq(uint8(hub2.session(address(token))), uint8(Session.REGULAR));
        seq.set(0, 0, 1, type(uint256).max); // startedAt in the future
        assertEq(uint8(hub2.session(address(token))), uint8(Session.HALTED));
        (,, bool ok) = hub2.spot(address(token));
        assertFalse(ok);

        RiskParams rp3 =
            new RiskParams(address(usdg), TREASURY, address(0xBEEF), TIMELOCK, GUARDIAN, SETUP_ADMIN, _validGlobals());
        vm.prank(SETUP_ADMIN);
        rp3.addUnderlying(address(token), p);
        MarketDataHub hub3 = new MarketDataHub(rp3, kernel);
        assertEq(uint8(hub3.session(address(token))), uint8(Session.HALTED)); // no code
    }

    function test_futureUpdatedAtHalts() public {
        vm.warp(REGULAR_TS);
        feed.pushRound(150e8, REGULAR_TS + 100);
        assertEq(uint8(hub.session(address(token))), uint8(Session.HALTED));
    }

    function test_sequencerNoRoundsHalts() public {
        (, MarketDataHub hub2,) = _deployWithSequencer(); // seq feed never pushed: startedAt == 0
        vm.warp(REGULAR_TS);
        feed.pushRound(150e8, REGULAR_TS);
        assertEq(uint8(hub2.session(address(token))), uint8(Session.HALTED));
    }

    function test_sequencerNonZeroAnswerHalts() public {
        (, MarketDataHub hub2, MockAggregator seqFeed) = _deployWithSequencer();
        vm.warp(REGULAR_TS);
        feed.pushRound(150e8, REGULAR_TS);
        seqFeed.pushRound(2, REGULAR_TS - 10000);
        assertEq(uint8(hub2.session(address(token))), uint8(Session.HALTED));
        seqFeed.pushRound(0, REGULAR_TS - 10000);
        assertEq(uint8(hub2.session(address(token))), uint8(Session.REGULAR));
    }

    function test_priceAboveMaxHaltsAndSpotReverts() public {
        vm.warp(REGULAR_TS);
        feed.pushRound(2001e8, REGULAR_TS);
        assertEq(uint8(hub.session(address(token))), uint8(Session.HALTED));
        vm.expectRevert(MarketDataHub.ImplausiblePrice.selector);
        hub.spot(address(token));
    }

    function test_spotOtherDecimals() public {
        MockAggregator f6 = new MockAggregator(6, "F6");
        MockAggregator f18 = new MockAggregator(18, "F18");
        MockStockToken t6 = new MockStockToken("A", "A");
        MockStockToken t18 = new MockStockToken("B", "B");
        _addUnderlying(address(t6), address(f6));
        _addUnderlying(address(t18), address(f18));
        vm.warp(REGULAR_TS);
        f6.pushRound(150e6, REGULAR_TS);
        f18.pushRound(150e18, REGULAR_TS);
        (uint256 p6,, bool ok6) = hub.spot(address(t6));
        (uint256 p18,, bool ok18) = hub.spot(address(t18));
        assertEq(p6, 150e18);
        assertEq(p18, 150e18);
        assertTrue(ok6 && ok18);
    }

    // ================= C. vol =================

    function test_rebaseRequiresExhaustedPhase() public {
        vm.warp(REGULAR_TS);
        feed.pushRound(150e8, REGULAR_TS); // (1,1)
        hub.initVol(address(token));
        feed.pushRound(151e8, REGULAR_TS + 10); // (1,2) unprocessed
        feed.setPhase(2);
        feed.pushRound(160e8, REGULAR_TS + 20); // (2,1)

        vm.expectRevert(MarketDataHub.PhaseNotExhausted.selector);
        hub.rebaseVol(address(token));

        _pokeN(2, 1); // consume the rest of phase 1
        vm.expectEmit(true, false, false, true, address(hub));
        emit IMarketDataHub.VolRebased(address(token), _roundId(1, 2), _roundId(2, 1));
        hub.rebaseVol(address(token));
    }

    function test_pokeVolSkipsAlreadyProcessedRounds() public {
        vm.warp(REGULAR_TS);
        feed.pushRound(150e8, REGULAR_TS);
        hub.initVol(address(token));
        feed.pushRound(151e8, REGULAR_TS + 10);
        feed.pushRound(152e8, REGULAR_TS + 20);

        _pokeN(2, 1); // front-run
        uint80[] memory keeper = new uint80[](3);
        keeper[0] = _roundId(1, 1); // at/below stored: skipped
        keeper[1] = _roundId(1, 2); // skipped
        keeper[2] = _roundId(1, 3);
        hub.pokeVol(address(token), keeper);
        (,, uint80 lastId, uint256 lastPrice,,) = hub.volState(address(token));
        assertEq(lastId, _roundId(1, 3));
        assertEq(lastPrice, 152e18);

        // nothing new: no-op, not a revert, and staleness is not refreshed
        (,,,,, uint64 pokeTsBefore) = hub.volState(address(token));
        vm.warp(REGULAR_TS + 100);
        hub.pokeVol(address(token), keeper);
        (,,,,, uint64 pokeTsAfter) = hub.volState(address(token));
        assertEq(pokeTsAfter, pokeTsBefore);

        // remaining ids must still be consecutive
        feed.pushRound(153e8, REGULAR_TS + 30);
        feed.pushRound(154e8, REGULAR_TS + 40);
        uint80[] memory gap = new uint80[](2);
        gap[0] = _roundId(1, 3);
        gap[1] = _roundId(1, 5);
        vm.expectRevert(MarketDataHub.NonConsecutiveRound.selector);
        hub.pokeVol(address(token), gap);
    }

    function _volSnapshot() internal view returns (bytes memory) {
        (uint256 r2, uint256 dt, uint80 id, uint256 px, uint64 at, uint64 pokeTs) = hub.volState(address(token));
        return abi.encode(r2, dt, id, px, at, pokeTs);
    }

    function test_syncVolEqualsPokingEveryNewRound() public {
        vm.warp(REGULAR_TS);
        feed.pushRound(150e8, REGULAR_TS);
        hub.initVol(address(token));
        feed.pushRound(151e8, REGULAR_TS + 100);
        feed.pushRound(148e8, REGULAR_TS + 250);
        feed.pushRound(152e8, REGULAR_TS + 400);
        vm.warp(REGULAR_TS + 500);

        uint256 snap = vm.snapshotState();
        _pokeN(2, 3);
        bytes memory poked = _volSnapshot();
        vm.revertToState(snap);

        vm.expectEmit(true, false, false, false, address(hub));
        emit IMarketDataHub.VolPoked(address(token), _roundId(1, 4), 0);
        hub.syncVol(address(token));
        assertEq(_volSnapshot(), poked);
        (,, uint80 lastId,,,) = hub.volState(address(token));
        (uint80 latest,,,,) = feed.latestRoundData();
        assertEq(lastId, latest);
    }

    function test_syncVolNoopWhenCurrent() public {
        vm.warp(REGULAR_TS);
        feed.pushRound(150e8, REGULAR_TS);
        hub.initVol(address(token));
        bytes memory before = _volSnapshot();
        vm.warp(REGULAR_TS + 100);
        hub.syncVol(address(token)); // nothing new: no state change, staleness not refreshed
        assertEq(_volSnapshot(), before);
    }

    function test_syncVolAtMost64PerCall() public {
        vm.warp(REGULAR_TS);
        feed.pushRound(150e8, REGULAR_TS);
        hub.initVol(address(token));
        for (uint64 i = 1; i <= 70; i++) {
            feed.pushRound(150e8, REGULAR_TS + 60 * i);
        }
        hub.syncVol(address(token));
        (,, uint80 lastId,,,) = hub.volState(address(token));
        assertEq(lastId, _roundId(1, 65));
        hub.syncVol(address(token));
        (,, lastId,,,) = hub.volState(address(token));
        assertEq(lastId, _roundId(1, 71));
    }

    function test_syncVolLeavesPhaseChangeToRebase() public {
        vm.warp(REGULAR_TS);
        feed.pushRound(150e8, REGULAR_TS);
        hub.initVol(address(token));
        feed.setPhase(2);
        feed.pushRound(151e8, REGULAR_TS + 10);
        feed.pushRound(151e8, REGULAR_TS + 15); // phase 2 is ahead of phase 1 in round count too
        bytes memory before = _volSnapshot();
        hub.syncVol(address(token));
        assertEq(_volSnapshot(), before);

        hub.rebaseVol(address(token));
        feed.pushRound(152e8, REGULAR_TS + 20);
        hub.syncVol(address(token));
        (,, uint80 lastId,,,) = hub.volState(address(token));
        assertEq(lastId, _roundId(2, 3));
    }

    function test_syncVolRequiresInit() public {
        vm.expectRevert(MarketDataHub.NotInitialized.selector);
        hub.syncVol(address(token));
    }

    function test_markVolFromCalmRoundsBelowCapThenStaleIsCap() public {
        vm.warp(REGULAR_TS);
        feed.pushRound(150e8, REGULAR_TS);
        hub.initVol(address(token));
        for (uint64 i = 0; i < 64; i++) {
            feed.pushRound(150e8, REGULAR_TS + 3600 * (i + 1));
        }
        _pokeN(2, 64);
        uint256 v = hub.markVol(address(token));
        assertLt(v, 1.5e18);
        assertGt(v, 0.35e18);

        // past volStaleness with nothing new printed (a weekend): the estimate is still current
        uint256 t = REGULAR_TS + 3600 * 64 + 3601;
        vm.warp(t);
        assertTrue(hub.volCurrent(address(token)));
        assertEq(hub.markVol(address(token)), v);

        // a round printed but not folded in (the first of the week): the estimate stays until that
        // round has waited unfolded for volStaleness, counted from its own timestamp
        feed.pushRound(150e8, t);
        assertFalse(hub.volCurrent(address(token)));
        assertFalse(hub.volStale(address(token)));
        assertEq(hub.markVol(address(token)), v);
        vm.warp(t + 3600);
        feed.pushRound(150e8, t + 3600); // a later print doesn't restart the age
        assertEq(hub.markVol(address(token)), v);
        vm.warp(t + 3601);
        assertTrue(hub.volStale(address(token)));
        assertEq(hub.markVol(address(token)), 1.5e18);
        // anyone lifts it by folding
        hub.syncVol(address(token));
        assertTrue(hub.volCurrent(address(token)));
        assertFalse(hub.volStale(address(token)));
        assertLt(hub.markVol(address(token)), 1.5e18);
    }

    /// A partial fold leaves the oldest unfolded round as the one that ages: a backlog whose head
    /// is older than volStaleness is still stale after a fold that didn't reach past it.
    function test_markVolAgeFromOldestUnfoldedRound() public {
        vm.warp(REGULAR_TS);
        feed.pushRound(150e8, REGULAR_TS);
        hub.initVol(address(token));
        feed.pushRound(151e8, REGULAR_TS + 10); // (1,2)
        vm.warp(REGULAR_TS + 3000);
        feed.pushRound(150e8, REGULAR_TS + 3000); // (1,3)
        vm.warp(REGULAR_TS + 3611);
        assertTrue(hub.volStale(address(token))); // (1,2) is 3601 s old
        _pokeN(2, 1);
        assertFalse(hub.volStale(address(token))); // now (1,3) ages: 611 s
        vm.warp(REGULAR_TS + 3000 + 3601);
        assertTrue(hub.volStale(address(token)));
        assertEq(hub.markVol(address(token)), 1.5e18);
    }

    /// After an aggregator migration the stored phase has no next round: the age counts from round
    /// 1 of the new phase, so the migration doesn't read volCap before anyone can rebase.
    function test_markVolAcrossPhaseChange() public {
        vm.warp(REGULAR_TS);
        feed.pushRound(150e8, REGULAR_TS);
        hub.initVol(address(token));
        for (uint64 i = 0; i < 64; i++) {
            feed.pushRound(150e8, REGULAR_TS + 60 * (i + 1));
        }
        hub.syncVol(address(token));
        uint256 v = hub.markVol(address(token));
        assertLt(v, 1.5e18);

        uint256 t = REGULAR_TS + 60 * 64 + 7200; // the old phase went quiet long ago
        vm.warp(t);
        feed.setPhase(2);
        feed.pushRound(151e8, t); // (2,1)
        assertFalse(hub.volCurrent(address(token)));
        assertFalse(hub.volStale(address(token)));
        assertEq(hub.markVol(address(token)), v);
        vm.warp(t + 3601);
        assertTrue(hub.volStale(address(token)));
        assertEq(hub.markVol(address(token)), 1.5e18);
        hub.rebaseVol(address(token));
        assertTrue(hub.volCurrent(address(token)));
        assertEq(hub.markVol(address(token)), v);
    }

    /// The old phase still has unfolded rounds after the migration: those age first.
    function test_markVolPhaseChangeOldPhaseBacklogAges() public {
        vm.warp(REGULAR_TS);
        feed.pushRound(150e8, REGULAR_TS);
        hub.initVol(address(token));
        feed.pushRound(151e8, REGULAR_TS + 10); // (1,2), never folded
        vm.warp(REGULAR_TS + 3000);
        feed.setPhase(2);
        feed.pushRound(152e8, REGULAR_TS + 3000); // (2,1)
        vm.warp(REGULAR_TS + 3611);
        assertTrue(hub.volStale(address(token))); // (1,2) is 3601 s old, (2,1) only 611 s
        _pokeN(2, 1); // the rest of phase 1
        assertFalse(hub.volStale(address(token))); // now (2,1) ages
    }

    /// A feed whose calls fail has no round to age: stale (markVol never reverts on it).
    function test_markVolUnreadableFeedIsStale() public {
        vm.warp(REGULAR_TS);
        feed.pushRound(150e8, REGULAR_TS);
        hub.initVol(address(token));
        vm.mockCallRevert(address(feed), abi.encodeWithSelector(MockAggregator.latestRoundData.selector), "");
        vm.mockCallRevert(address(feed), abi.encodeWithSelector(MockAggregator.getRoundData.selector), "");
        assertTrue(hub.volStale(address(token)));
        assertEq(hub.markVol(address(token)), 1.5e18);
    }

    /// A bad print (no positive answer) is skipped: the anchor moves past it, the next good round's
    /// return spans it, and the estimate never sticks on it.
    function test_badRoundIsSkipped() public {
        vm.warp(REGULAR_TS);
        feed.pushRound(150e8, REGULAR_TS);
        hub.initVol(address(token));
        (uint256 r2a, uint256 dta,,,,) = hub.volState(address(token));
        feed.pushRound(0, REGULAR_TS + 60);
        hub.syncVol(address(token)); // only the bad print: the anchor moves, nothing else
        (uint256 r2b, uint256 dtb, uint80 last,, uint64 at,) = hub.volState(address(token));
        assertEq(last, _roundId(1, 2));
        assertEq(r2b, r2a);
        assertEq(dtb, dta);
        assertEq(at, REGULAR_TS);
        assertTrue(hub.volCurrent(address(token)));

        feed.pushRound(-5, REGULAR_TS + 120);
        feed.pushRound(160e8, REGULAR_TS + 180);
        hub.syncVol(address(token));
        (,, last,,,) = hub.volState(address(token));
        assertEq(last, _roundId(1, 4));
        // the same as folding the good round alone, its time span counted from the last good one
        (uint256 r2, uint256 dt) = _ewmaOne(r2a, dta, 150e18, 160e18, 180);
        (r2b, dtb,,,,) = hub.volState(address(token));
        assertEq(r2b, r2);
        assertEq(dtb, dt);
    }

    function _ewmaOne(uint256 r2, uint256 dt, uint256 p0, uint256 p1, uint256 span)
        internal
        view
        returns (uint256, uint256)
    {
        uint256[] memory ps = new uint256[](1);
        uint256[] memory ds = new uint256[](1);
        ps[0] = p1;
        ds[0] = span;
        return kernel.ewmaUpdate(r2, dt, p0, ps, ds, 0.97e18);
    }

    function test_markVolClampsToFloor() public {
        vm.warp(REGULAR_TS);
        feed.pushRound(150e8, REGULAR_TS);
        hub.initVol(address(token));
        for (uint64 b = 0; b < 4; b++) {
            for (uint64 i = 0; i < 64; i++) {
                feed.pushRound(150e8, REGULAR_TS + 3600 * (b * 64 + i + 1));
            }
            _pokeN(b * 64 + 2, 64);
        }
        assertEq(hub.markVol(address(token)), 0.35e18);
    }

    function test_markVolClampsToCap() public {
        vm.warp(REGULAR_TS);
        feed.pushRound(150e8, REGULAR_TS);
        hub.initVol(address(token));
        for (uint64 i = 0; i < 4; i++) {
            feed.pushRound(i % 2 == 0 ? int256(300e8) : int256(150e8), REGULAR_TS + 60 * (i + 1));
        }
        _pokeN(2, 4);
        assertEq(hub.markVol(address(token)), 1.5e18);
        (uint256 r2, uint256 dt,,,,) = hub.volState(address(token));
        assertGt(r2 * 1e18 / dt, 1.5e18 * 1.5e18 / 1e18); // raw estimate is above the cap
    }
}
