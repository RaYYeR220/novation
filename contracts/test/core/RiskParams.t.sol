// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {RiskParams} from "../../src/core/RiskParams.sol";
import {UnderlyingParams, GlobalParams} from "../../src/interfaces/IRiskParams.sol";

contract RiskParamsTest is Test {
    RiskParams rp;

    address constant USDG = address(0x1);
    address constant TREASURY = address(0x2);
    address constant SEQ_FEED = address(0x3);
    address constant TIMELOCK = address(0x4);
    address constant GUARDIAN = address(0x5);
    address constant SETUP_ADMIN = address(0x6);
    address constant TOKEN = address(0x7);
    address constant FEED = address(0x8);
    address constant TOKEN2 = address(0x9);
    address constant FEED2 = address(0xA);

    function setUp() public {
        rp = new RiskParams(USDG, TREASURY, SEQ_FEED, TIMELOCK, GUARDIAN, SETUP_ADMIN, _validGlobals());
    }

    // ---- valid fixtures ----

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
            maxSettlementLag: 87300,
            haltWindow: 86400,
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
            index: 0, // ignored on input
            feed: FEED,
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
            maxStaleRegular: 93600,
            maxStaleExtended: 93600,
            maxStaleClosed: 345600,
            volStaleness: 172800,
            minPrice: 20e18,
            maxPrice: 2000e18
        });
    }

    // ---- access control ----

    function test_setupAdminCanAddBeforeFinalize() public {
        vm.prank(SETUP_ADMIN);
        rp.addUnderlying(TOKEN, _validUnderlying());
        assertEq(rp.underlyingCount(), 1);
        assertEq(rp.underlyingAt(0), TOKEN);
    }

    function test_onlyTimelockAfterFinalize() public {
        vm.prank(SETUP_ADMIN);
        rp.finalizeSetup();

        vm.prank(SETUP_ADMIN);
        vm.expectRevert(RiskParams.Unauthorized.selector);
        rp.addUnderlying(TOKEN, _validUnderlying());

        vm.prank(TIMELOCK);
        rp.addUnderlying(TOKEN, _validUnderlying());
        assertEq(rp.underlyingCount(), 1);
    }

    function test_finalizeSetupOnlyOnce() public {
        vm.prank(SETUP_ADMIN);
        rp.finalizeSetup();

        vm.prank(SETUP_ADMIN);
        vm.expectRevert(RiskParams.AlreadyFinalized.selector);
        rp.finalizeSetup();
    }

    function test_finalizeSetupOnlySetupAdmin() public {
        vm.prank(TIMELOCK);
        vm.expectRevert(RiskParams.Unauthorized.selector);
        rp.finalizeSetup();
    }

    function test_guardianCanOnlyPause() public {
        vm.prank(GUARDIAN);
        rp.pauseOpening();
        assertTrue(rp.openingPaused());

        vm.prank(GUARDIAN);
        rp.unpauseOpening();
        assertFalse(rp.openingPaused());

        vm.prank(GUARDIAN);
        vm.expectRevert(RiskParams.Unauthorized.selector);
        rp.setGlobals(_validGlobals());
    }

    function test_timelockCanPause() public {
        vm.prank(TIMELOCK);
        rp.pauseOpening();
        assertTrue(rp.openingPaused());
    }

    function test_randomCallerCannotAddOrPause() public {
        address stranger = address(0xdead);
        vm.startPrank(stranger);
        vm.expectRevert(RiskParams.Unauthorized.selector);
        rp.addUnderlying(TOKEN, _validUnderlying());

        vm.expectRevert(RiskParams.Unauthorized.selector);
        rp.pauseOpening();

        vm.expectRevert(RiskParams.Unauthorized.selector);
        rp.setGlobals(_validGlobals());
        vm.stopPrank();
    }

    // ---- add/set semantics ----

    function test_feedAndIndexImmutable() public {
        vm.startPrank(SETUP_ADMIN);
        rp.addUnderlying(TOKEN, _validUnderlying());

        UnderlyingParams memory p2 = _validUnderlying();
        p2.feed = FEED2; // should be ignored
        p2.index = 7; // should be ignored
        rp.setUnderlying(TOKEN, p2);
        vm.stopPrank();

        UnderlyingParams memory stored = rp.underlying(TOKEN);
        assertEq(stored.feed, FEED);
        assertEq(stored.index, 0);
    }

    function test_indexAssignment() public {
        vm.startPrank(SETUP_ADMIN);
        rp.addUnderlying(TOKEN, _validUnderlying());
        UnderlyingParams memory u2 = _validUnderlying();
        u2.feed = FEED2;
        rp.addUnderlying(TOKEN2, u2);
        vm.stopPrank();

        assertEq(rp.underlying(TOKEN).index, 0);
        assertEq(rp.underlying(TOKEN2).index, 1);
        assertEq(rp.underlyingAt(0), TOKEN);
        assertEq(rp.underlyingAt(1), TOKEN2);
        assertEq(rp.underlyingCount(), 2);
    }

    function test_underlyingAtRoundTrip() public {
        vm.prank(SETUP_ADMIN);
        rp.addUnderlying(TOKEN, _validUnderlying());

        UnderlyingParams memory stored = rp.underlying(TOKEN);
        UnderlyingParams memory input = _validUnderlying();
        assertEq(stored.enabled, input.enabled);
        assertEq(stored.feed, input.feed);
        assertEq(stored.strikeStep, input.strikeStep);
        assertEq(stored.volFloor, input.volFloor);
        assertEq(stored.volCap, input.volCap);
        assertEq(stored.lambda, input.lambda);
        assertEq(stored.shockK, input.shockK);
        assertEq(stored.minShock, input.minShock);
        assertEq(stored.horizonDays, input.horizonDays);
        assertEq(stored.volUp, input.volUp);
        assertEq(stored.volDown, input.volDown);
        assertEq(stored.multExtended, input.multExtended);
        assertEq(stored.multWeekend, input.multWeekend);
        assertEq(stored.multHoliday, input.multHoliday);
        assertEq(stored.multHalted, input.multHalted);
        assertEq(stored.maxOpenInterest, input.maxOpenInterest);
        assertEq(stored.maxStaleRegular, input.maxStaleRegular);
        assertEq(stored.maxStaleExtended, input.maxStaleExtended);
        assertEq(stored.maxStaleClosed, input.maxStaleClosed);
        assertEq(stored.volStaleness, input.volStaleness);
        assertEq(stored.minPrice, input.minPrice);
        assertEq(stored.maxPrice, input.maxPrice);
        assertEq(rp.underlyingAt(0), TOKEN);
    }

    function test_addUnderlyingRejectsZeroToken() public {
        vm.prank(SETUP_ADMIN);
        vm.expectRevert(RiskParams.ZeroAddress.selector);
        rp.addUnderlying(address(0), _validUnderlying());
    }

    function test_addUnderlyingRejectsZeroFeed() public {
        UnderlyingParams memory p = _validUnderlying();
        p.feed = address(0);
        vm.prank(SETUP_ADMIN);
        vm.expectRevert(RiskParams.ZeroAddress.selector);
        rp.addUnderlying(TOKEN, p);
    }

    function test_addUnderlyingRejectsDuplicate() public {
        vm.startPrank(SETUP_ADMIN);
        rp.addUnderlying(TOKEN, _validUnderlying());
        vm.expectRevert(RiskParams.AlreadyAdded.selector);
        rp.addUnderlying(TOKEN, _validUnderlying());
        vm.stopPrank();
    }

    function test_addUnderlyingRejectsAboveMaxCount() public {
        vm.startPrank(SETUP_ADMIN);
        for (uint256 i = 0; i < 64; i++) {
            UnderlyingParams memory p = _validUnderlying();
            p.feed = address(uint160(0x1000 + i));
            rp.addUnderlying(address(uint160(0x2000 + i)), p);
        }
        UnderlyingParams memory p65 = _validUnderlying();
        p65.feed = address(uint160(0x3000));
        vm.expectRevert(RiskParams.TooManyUnderlyings.selector);
        rp.addUnderlying(address(uint160(0x4000)), p65);
        vm.stopPrank();
    }

    function test_setUnderlyingRejectsUnknownToken() public {
        vm.prank(SETUP_ADMIN);
        vm.expectRevert(RiskParams.UnknownUnderlying.selector);
        rp.setUnderlying(TOKEN, _validUnderlying());
    }

    // ---- bounds: table-driven ----

    struct BoundCase {
        string label;
        bool isGlobal;
        bytes32 field;
    }

    function test_boundsEnforced_underlying() public {
        // strikeStep [0.01e18, 1000e18]
        _expectUnderlyingRevert("strikeStep", _setU("strikeStep", 0.01e18 - 1));
        _expectUnderlyingRevert("strikeStep", _setU("strikeStep", 1000e18 + 1));

        // volFloor [0.05e18, 2e18]
        _expectUnderlyingRevert("volFloor", _setU("volFloor", 0.05e18 - 1));
        _expectUnderlyingRevert("volFloor", _setU("volFloor", 2e18 + 1));

        // volCap [volFloor, 5e18]
        _expectUnderlyingRevert("volCap", _setU("volCap", 0.35e18 - 1)); // below volFloor default (0.35e18)
        _expectUnderlyingRevert("volCap", _setU("volCap", 5e18 + 1));

        // lambda [0.8e18, 0.999e18]
        _expectUnderlyingRevert("lambda", _setU("lambda", 0.8e18 - 1));
        _expectUnderlyingRevert("lambda", _setU("lambda", 0.999e18 + 1));

        // shockK [1e18, 6e18]
        _expectUnderlyingRevert("shockK", _setU("shockK", 1e18 - 1));
        _expectUnderlyingRevert("shockK", _setU("shockK", 6e18 + 1));

        // minShock [0.02e18, 0.5e18]
        _expectUnderlyingRevert("minShock", _setU("minShock", 0.02e18 - 1));
        _expectUnderlyingRevert("minShock", _setU("minShock", 0.5e18 + 1));

        // horizonDays [1, 10]
        _expectUnderlyingRevert("horizonDays", _setU("horizonDays", 0));
        _expectUnderlyingRevert("horizonDays", _setU("horizonDays", 11));

        // volUp [0.1e18, 2e18]
        _expectUnderlyingRevert("volUp", _setU("volUp", 0.1e18 - 1));
        _expectUnderlyingRevert("volUp", _setU("volUp", 2e18 + 1));

        // volDown [0.1e18, 0.9e18]
        _expectUnderlyingRevert("volDown", _setU("volDown", 0.1e18 - 1));
        _expectUnderlyingRevert("volDown", _setU("volDown", 0.9e18 + 1));

        // multExtended/Weekend/Holiday/Halted [1e18, 4e18]
        _expectUnderlyingRevert("multExtended", _setU("multExtended", 1e18 - 1));
        _expectUnderlyingRevert("multExtended", _setU("multExtended", 4e18 + 1));
        _expectUnderlyingRevert("multWeekend", _setU("multWeekend", 1e18 - 1));
        _expectUnderlyingRevert("multWeekend", _setU("multWeekend", 4e18 + 1));
        _expectUnderlyingRevert("multHoliday", _setU("multHoliday", 1e18 - 1));
        _expectUnderlyingRevert("multHoliday", _setU("multHoliday", 4e18 + 1));
        _expectUnderlyingRevert("multHalted", _setU("multHalted", 1e18 - 1));
        _expectUnderlyingRevert("multHalted", _setU("multHalted", 4e18 + 1));

        // maxOpenInterest [1e18, 1e27]
        _expectUnderlyingRevert("maxOpenInterest", _setU("maxOpenInterest", 1e18 - 1));
        _expectUnderlyingRevert("maxOpenInterest", _setU("maxOpenInterest", 1e27 + 1));

        // maxStaleRegular/Extended [300, 172800]
        _expectUnderlyingRevert("maxStaleRegular", _setU("maxStaleRegular", 299));
        _expectUnderlyingRevert("maxStaleRegular", _setU("maxStaleRegular", 172801));
        _expectUnderlyingRevert("maxStaleExtended", _setU("maxStaleExtended", 299));
        _expectUnderlyingRevert("maxStaleExtended", _setU("maxStaleExtended", 172801));

        // maxStaleClosed [3600, 345600]
        _expectUnderlyingRevert("maxStaleClosed", _setU("maxStaleClosed", 3599));
        _expectUnderlyingRevert("maxStaleClosed", _setU("maxStaleClosed", 345601));

        // volStaleness [3600, 604800]
        _expectUnderlyingRevert("volStaleness", _setU("volStaleness", 3599));
        _expectUnderlyingRevert("volStaleness", _setU("volStaleness", 604801));

        // minPrice [1e16, maxPrice)
        _expectUnderlyingRevert("minPrice", _setU("minPrice", 1e16 - 1));
        _expectUnderlyingRevert("minPrice", _setU("minPrice", 2000e18)); // >= default maxPrice

        // maxPrice (minPrice, 1e24]
        _expectUnderlyingRevert("maxPrice", _setU("maxPrice", 1e24 + 1));
    }

    function test_boundsEnforced_global() public {
        // mmRatio [0.5e18, 0.95e18]
        _expectGlobalRevert("mmRatio", _setG("mmRatio", 0.5e18 - 1));
        _expectGlobalRevert("mmRatio", _setG("mmRatio", 0.95e18 + 1));

        // diversificationCredit [0, 0.5e18]
        _expectGlobalRevert("diversificationCredit", _setG("diversificationCredit", 0.5e18 + 1));

        // shortOptionMinPct [0.005e18, 0.1e18]
        _expectGlobalRevert("shortOptionMinPct", _setG("shortOptionMinPct", 0.005e18 - 1));
        _expectGlobalRevert("shortOptionMinPct", _setG("shortOptionMinPct", 0.1e18 + 1));

        // feeRate [0, 0.001e18]
        _expectGlobalRevert("feeRate", _setG("feeRate", 0.001e18 + 1));

        // feeCapOfPremium [0.01e18, 0.2e18]
        _expectGlobalRevert("feeCapOfPremium", _setG("feeCapOfPremium", 0.01e18 - 1));
        _expectGlobalRevert("feeCapOfPremium", _setG("feeCapOfPremium", 0.2e18 + 1));

        // insuranceShare [0.2e18, 1e18]
        _expectGlobalRevert("insuranceShare", _setG("insuranceShare", 0.2e18 - 1));
        _expectGlobalRevert("insuranceShare", _setG("insuranceShare", 1e18 + 1));

        // startDiscount [0, 0.05e18]
        _expectGlobalRevert("startDiscount", _setG("startDiscount", 0.05e18 + 1));

        // maxDiscount [startDiscount, 0.25e18]
        _expectGlobalRevert("maxDiscount", _setG("maxDiscount", 0.02e18 - 1)); // below default startDiscount
        _expectGlobalRevert("maxDiscount", _setG("maxDiscount", 0.25e18 + 1));

        // maxFractionPerBid [0.1e18, 1e18]
        _expectGlobalRevert("maxFractionPerBid", _setG("maxFractionPerBid", 0.1e18 - 1));
        _expectGlobalRevert("maxFractionPerBid", _setG("maxFractionPerBid", 1e18 + 1));

        // liquidationPenalty [0, 0.05e18]
        _expectGlobalRevert("liquidationPenalty", _setG("liquidationPenalty", 0.05e18 + 1));

        // auctionDuration [300, 21600]
        _expectGlobalRevert("auctionDuration", _setG("auctionDuration", 299));
        _expectGlobalRevert("auctionDuration", _setG("auctionDuration", 21601));

        // maxSettlementLag [60, 90000]
        _expectGlobalRevert("maxSettlementLag", _setG("maxSettlementLag", 59));
        _expectGlobalRevert("maxSettlementLag", _setG("maxSettlementLag", 90001));

        // haltWindow [3600, 259200]
        _expectGlobalRevert("haltWindow", _setG("haltWindow", 3599));
        _expectGlobalRevert("haltWindow", _setG("haltWindow", 259201));

        // maxWeeksOut [1, 12]
        _expectGlobalRevert("maxWeeksOut", _setG("maxWeeksOut", 0));
        _expectGlobalRevert("maxWeeksOut", _setG("maxWeeksOut", 13));

        // maxStrikeDeviation [0.1e18, 0.9e18]
        _expectGlobalRevert("maxStrikeDeviation", _setG("maxStrikeDeviation", 0.1e18 - 1));
        _expectGlobalRevert("maxStrikeDeviation", _setG("maxStrikeDeviation", 0.9e18 + 1));

        // rate [0, 0.2e18]
        _expectGlobalRevert("rate", _setGRate(-1));
        _expectGlobalRevert("rate", _setGRate(0.2e18 + 1));

        // minTradeQty [1e15, 1e18]
        _expectGlobalRevert("minTradeQty", _setG("minTradeQty", 1e15 - 1));
        _expectGlobalRevert("minTradeQty", _setG("minTradeQty", 1e18 + 1));

        // dustEquity [0, 100e18]
        _expectGlobalRevert("dustEquity", _setG("dustEquity", 100e18 + 1));
    }

    function test_boundsEnforced_validDefaultsAccepted() public {
        vm.prank(SETUP_ADMIN);
        rp.addUnderlying(TOKEN, _validUnderlying());

        vm.prank(SETUP_ADMIN);
        rp.setGlobals(_validGlobals());
    }

    // ---- helpers for the bounds table ----

    function _setU(bytes32 field, uint256 value) internal pure returns (UnderlyingParams memory p) {
        p = _validUnderlying();
        if (field == "strikeStep") p.strikeStep = uint128(value);
        else if (field == "volFloor") p.volFloor = uint64(value);
        else if (field == "volCap") p.volCap = uint64(value);
        else if (field == "lambda") p.lambda = uint64(value);
        else if (field == "shockK") p.shockK = uint64(value);
        else if (field == "minShock") p.minShock = uint64(value);
        else if (field == "horizonDays") p.horizonDays = uint64(value);
        else if (field == "volUp") p.volUp = uint64(value);
        else if (field == "volDown") p.volDown = uint64(value);
        else if (field == "multExtended") p.multExtended = uint64(value);
        else if (field == "multWeekend") p.multWeekend = uint64(value);
        else if (field == "multHoliday") p.multHoliday = uint64(value);
        else if (field == "multHalted") p.multHalted = uint64(value);
        else if (field == "maxOpenInterest") p.maxOpenInterest = uint128(value);
        else if (field == "maxStaleRegular") p.maxStaleRegular = uint32(value);
        else if (field == "maxStaleExtended") p.maxStaleExtended = uint32(value);
        else if (field == "maxStaleClosed") p.maxStaleClosed = uint32(value);
        else if (field == "volStaleness") p.volStaleness = uint32(value);
        else if (field == "minPrice") p.minPrice = uint128(value);
        else if (field == "maxPrice") p.maxPrice = uint128(value);
        else revert("bad field");
    }

    function _setG(bytes32 field, uint256 value) internal pure returns (GlobalParams memory g) {
        g = _validGlobals();
        if (field == "mmRatio") g.mmRatio = uint64(value);
        else if (field == "diversificationCredit") g.diversificationCredit = uint64(value);
        else if (field == "shortOptionMinPct") g.shortOptionMinPct = uint64(value);
        else if (field == "feeRate") g.feeRate = uint64(value);
        else if (field == "feeCapOfPremium") g.feeCapOfPremium = uint64(value);
        else if (field == "insuranceShare") g.insuranceShare = uint64(value);
        else if (field == "startDiscount") g.startDiscount = uint64(value);
        else if (field == "maxDiscount") g.maxDiscount = uint64(value);
        else if (field == "maxFractionPerBid") g.maxFractionPerBid = uint64(value);
        else if (field == "liquidationPenalty") g.liquidationPenalty = uint64(value);
        else if (field == "auctionDuration") g.auctionDuration = uint32(value);
        else if (field == "maxSettlementLag") g.maxSettlementLag = uint32(value);
        else if (field == "haltWindow") g.haltWindow = uint32(value);
        else if (field == "maxWeeksOut") g.maxWeeksOut = uint32(value);
        else if (field == "maxStrikeDeviation") g.maxStrikeDeviation = uint64(value);
        else if (field == "minTradeQty") g.minTradeQty = uint128(value);
        else if (field == "dustEquity") g.dustEquity = uint128(value);
        else revert("bad field");
    }

    function _setGRate(int256 value) internal pure returns (GlobalParams memory g) {
        g = _validGlobals();
        g.rate = int64(value);
    }

    function _expectUnderlyingRevert(bytes32 field, UnderlyingParams memory p) internal {
        vm.prank(SETUP_ADMIN);
        vm.expectRevert(abi.encodeWithSelector(RiskParams.OutOfBounds.selector, field));
        rp.addUnderlying(TOKEN, p);
    }

    function _expectGlobalRevert(bytes32 field, GlobalParams memory g) internal {
        vm.prank(SETUP_ADMIN);
        vm.expectRevert(abi.encodeWithSelector(RiskParams.OutOfBounds.selector, field));
        rp.setGlobals(g);
    }

    function test_constructorValidatesInitialGlobals() public {
        GlobalParams memory bad = _validGlobals();
        bad.mmRatio = 0.5e18 - 1;
        vm.expectRevert(abi.encodeWithSelector(RiskParams.OutOfBounds.selector, bytes32("mmRatio")));
        new RiskParams(USDG, TREASURY, SEQ_FEED, TIMELOCK, GUARDIAN, SETUP_ADMIN, bad);
    }
}
