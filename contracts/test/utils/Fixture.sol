// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Clearinghouse} from "../../src/core/Clearinghouse.sol";
import {CHS} from "../../src/core/ClearinghouseStorage.sol";
import {RiskParams} from "../../src/core/RiskParams.sol";
import {MarketDataHub} from "../../src/core/MarketDataHub.sol";
import {SeriesRegistry} from "../../src/core/SeriesRegistry.sol";
import {InsuranceFund} from "../../src/core/InsuranceFund.sol";
import {KernelReference} from "../../src/kernel/KernelReference.sol";
import {MockAggregator} from "../../src/mocks/MockAggregator.sol";
import {MockStockToken} from "../../src/mocks/MockStockToken.sol";
import {MockUSDG} from "../../src/mocks/MockUSDG.sol";
import {IClearinghouse, TradeParams} from "../../src/interfaces/IClearinghouse.sol";
import {UnderlyingParams, GlobalParams} from "../../src/interfaces/IRiskParams.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {NyseCalendar} from "../../src/libraries/NyseCalendar.sol";
import {Series} from "../../src/types/Types.sol";

/// @notice Test-only venue that forwards any TradeParams to the clearinghouse unchanged, so a
/// test can act for any taker/maker actor. It lets anyone spoof actors: never deploy it outside
/// tests.
contract TestVenue {
    IClearinghouse public immutable ch;

    constructor(IClearinghouse ch_) {
        ch = ch_;
    }

    function trade(TradeParams calldata t) external returns (uint256 fee) {
        return ch.trade(t);
    }
}

/// @notice Test-only. Its runtime code is etched over the clearinghouse for a single call, so the
/// production CHS helpers run against the clearinghouse's own ERC-7201 storage. Tests use it to
/// seed state that has no public path (yet): positions, deficits, a lowered cash index. Every
/// derived field (position index, open interest, short quantity per expiry, underlying cap) stays
/// consistent because the same code as the production paths does the write.
contract CHStorageWriter {
    function movePosition(uint256 id, uint32 seriesId, int256 delta, Series memory series)
        external
        returns (int256 oldQty, int256 newQty)
    {
        return CHS.movePosition(id, seriesId, delta, series);
    }

    function setDeficitTotal(uint256 id, uint256 wad) external {
        CHS.s().accounts[id].deficitTotal = wad;
    }

    function setCashIndex(uint256 index) external {
        CHS.s().cashIndex = index;
    }
}

/// @notice Full Novation core deployed on mocks, with KernelReference as the risk kernel.
///
/// State after setUp():
///  - time is T0 = 2026-09-23 14:00 UTC (Wednesday 10:00 EDT, REGULAR session);
///  - NVDA at 180 USD and SPY at 600 USD, 8-decimal feeds with a fresh round at T0, vol initialised
///    from the volCap prior (mark vol = volCap up to r2 truncation, e.g. SPY 0.79999999999999990;
///    exactly volCap once a printed round has waited unfolded for volStaleness, 2 days);
///  - RiskParams with the deploy defaults; this contract is its setupAdmin and setup is NOT
///    finalized, so tests may still add or change underlyings and globals directly;
///  - the clearinghouse's setup phase is also open (TestVenue added, no auction house bound), so
///    later suites can add venues or bind an auction house (or a mock of one) before finalizing.
///
/// Amount conventions for the helpers: USDG in raw 6-decimal units (use the USDG constant for one
/// dollar), stock tokens in raw 18-decimal units (= WAD), prices in WAD USD per raw token.
abstract contract Fixture is Test {
    uint256 internal constant T0 = 1_790_172_000; // 2026-09-23 Wed 14:00 UTC
    uint256 internal constant USDG = 1e6; // one USDG in raw units
    address internal constant TIMELOCK = address(0x7100);
    address internal constant GUARDIAN = address(0x6600);
    address internal constant TREASURY = address(0x7E00);

    MockUSDG internal usdg;
    MockStockToken internal nvda;
    MockStockToken internal spy;
    KernelReference internal kernel;
    RiskParams internal params;
    MarketDataHub internal hub;
    SeriesRegistry internal registry;
    InsuranceFund internal insurance;
    Clearinghouse internal ch;
    TestVenue internal venue;

    /// @dev feed of every underlying the fixture (or _addUnderlying) registered
    mapping(address token => MockAggregator feed) internal feedOf;

    CHStorageWriter private _writer;

    function setUp() public virtual {
        vm.warp(T0);

        usdg = new MockUSDG();
        kernel = new KernelReference();
        params =
            new RiskParams(address(usdg), TREASURY, address(0), TIMELOCK, GUARDIAN, address(this), _defaultGlobals());
        hub = new MarketDataHub(params, kernel);

        nvda = _addUnderlying("NVDA", 180e18, 0.35e18, 1.5e18, 20e18, 2000e18);
        spy = _addUnderlying("SPY", 600e18, 0.12e18, 0.8e18, 60e18, 6000e18);

        registry = new SeriesRegistry(params, hub);
        insurance = new InsuranceFund(IERC20Metadata(address(usdg)), address(this));
        ch = new Clearinghouse(params, hub, registry, kernel, insurance, address(this));
        insurance.bindClearinghouse(address(ch));

        venue = new TestVenue(ch);
        ch.addVenue(address(venue));

        _writer = new CHStorageWriter();

        vm.label(address(usdg), "USDG");
        vm.label(address(ch), "Clearinghouse");
        vm.label(address(venue), "TestVenue");
    }

    // ---------------------------------------------------------------- parameters

    function _defaultGlobals() internal pure returns (GlobalParams memory) {
        return GlobalParams({
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

    function _defaultUnderlying(address feed, uint64 volFloor, uint64 volCap, uint128 minPrice, uint128 maxPrice)
        internal
        pure
        returns (UnderlyingParams memory)
    {
        return UnderlyingParams({
            enabled: true,
            index: 0,
            feed: feed,
            strikeStep: 5e18,
            volFloor: volFloor,
            volCap: volCap,
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
            minPrice: minPrice,
            maxPrice: maxPrice
        });
    }

    /// @notice Deploys a mock stock token + 8-decimal feed (fresh round now), registers it in
    /// RiskParams with the default schema and initialises its vol.
    function _addUnderlying(
        string memory symbol,
        uint256 priceWad,
        uint64 volFloor,
        uint64 volCap,
        uint128 minPrice,
        uint128 maxPrice
    ) internal returns (MockStockToken token) {
        token = new MockStockToken(symbol, symbol);
        _registerUnderlying(address(token), symbol, priceWad, volFloor, volCap, minPrice, maxPrice);
    }

    /// @notice Registers an already deployed token (e.g. a test-only token variant) as an
    /// underlying: new 8-decimal feed with a fresh round, default schema, vol initialised.
    function _registerUnderlying(
        address token,
        string memory symbol,
        uint256 priceWad,
        uint64 volFloor,
        uint64 volCap,
        uint128 minPrice,
        uint128 maxPrice
    ) internal {
        MockAggregator feed = new MockAggregator(8, string.concat(symbol, " / USD"));
        feedOf[token] = feed;
        feed.pushRound(_answer(priceWad), block.timestamp);
        params.addUnderlying(token, _defaultUnderlying(address(feed), volFloor, volCap, minPrice, maxPrice));
        hub.initVol(token);
        vm.label(token, symbol);
    }

    // ---------------------------------------------------------------- accounts and funds

    function _user(string memory name) internal returns (address) {
        return makeAddr(name);
    }

    function _newAccount(address owner) internal returns (uint256 id) {
        vm.prank(owner);
        id = ch.createSubaccount();
    }

    /// @notice Mints `amount` raw units of `token` to `from` and deposits them into `id` as `from`.
    function _deposit(address from, uint256 id, address token, uint256 amount) internal {
        MockUSDG(token).mint(from, amount); // MockUSDG and MockStockToken share mint(address,uint256)
        vm.startPrank(from);
        MockUSDG(token).approve(address(ch), amount);
        ch.deposit(id, token, amount);
        vm.stopPrank();
    }

    /// @notice Creates a subaccount owned by `user` and deposits `usdgUnits` USDG (raw 6-decimal
    /// units) and `nvdaWad` NVDA (raw 18-decimal units); zero amounts are skipped.
    function _fund(address user, uint256 usdgUnits, uint256 nvdaWad) internal returns (uint256 id) {
        id = _newAccount(user);
        if (usdgUnits != 0) _deposit(user, id, address(usdg), usdgUnits);
        if (nvdaWad != 0) _deposit(user, id, address(nvda), nvdaWad);
    }

    // ---------------------------------------------------------------- series, prices, time

    function _expiry() internal view returns (uint64) {
        return uint64(NyseCalendar.nextWeeklyExpiry(block.timestamp));
    }

    function _list(address u, uint64 expiry, uint128 strike, bool isCall) internal returns (uint32) {
        return registry.listSeries(u, expiry, strike, isCall);
    }

    /// @notice Pushes a new feed round for `u` at the current time (8-decimal answer, truncated).
    function _setPrice(address u, uint256 priceWad) internal returns (uint80 roundId) {
        roundId = feedOf[u].pushRound(_answer(priceWad), block.timestamp);
    }

    /// @notice Settles (u, expiry) in the registry at `priceWad`: pushes a round stamped exactly at
    /// the close and proves it as the latest round. Call it after warping past the expiry and
    /// before pushing any post-close round for `u`.
    function _settleExpiry(address u, uint64 expiry, uint256 priceWad) internal {
        uint80 rid = feedOf[u].pushRound(_answer(priceWad), expiry);
        registry.settleExpiry(u, expiry, rid);
    }

    function _answer(uint256 priceWad) private pure returns (int256) {
        return int256(priceWad / 1e10);
    }

    // ---------------------------------------------------------------- storage cheats

    /// @notice Moves a position through the production CHS.movePosition (see CHStorageWriter).
    /// Ledger only: no premium, fee, margin, opening or authorisation check, and no counterparty
    /// (so per-series quantities need not net to zero unless the test moves both sides).
    function _cheatMovePosition(uint256 id, uint32 seriesId, int256 delta)
        internal
        returns (int256 oldQty, int256 newQty)
    {
        Series memory s = registry.series(seriesId);
        bytes memory code = _etchWriter();
        (oldQty, newQty) = CHStorageWriter(address(ch)).movePosition(id, seriesId, delta, s);
        vm.etch(address(ch), code);
    }

    /// @notice Same as _cheatMovePosition, expecting the move to revert with `err`.
    function _cheatMovePositionReverts(uint256 id, uint32 seriesId, int256 delta, bytes memory err) internal {
        Series memory s = registry.series(seriesId);
        bytes memory code = _etchWriter();
        vm.expectRevert(err);
        CHStorageWriter(address(ch)).movePosition(id, seriesId, delta, s);
        vm.etch(address(ch), code);
    }

    /// @notice Overwrites only Account.deficitTotal (no per-expiry deficit, pool or insurance
    /// bookkeeping): for tests of the deficit gates.
    function _cheatDeficitTotal(uint256 id, uint256 wad) internal {
        bytes memory code = _etchWriter();
        CHStorageWriter(address(ch)).setDeficitTotal(id, wad);
        vm.etch(address(ch), code);
    }

    /// @notice Overwrites the global cash index (as if a loss had been socialized); nothing else
    /// is adjusted.
    function _cheatCashIndex(uint256 index) internal {
        bytes memory code = _etchWriter();
        CHStorageWriter(address(ch)).setCashIndex(index);
        vm.etch(address(ch), code);
    }

    function _etchWriter() private returns (bytes memory chCode) {
        chCode = address(ch).code;
        vm.etch(address(ch), address(_writer).code);
    }
}
