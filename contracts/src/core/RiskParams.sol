// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IRiskParams, UnderlyingParams, GlobalParams} from "../interfaces/IRiskParams.sol";

/// @notice Hard-bounded, timelocked risk-parameter registry with a guardian pause.
/// Every setter enforces hard-coded bounds; only timelock (or setupAdmin pre-finalize)
/// may change parameters, and only guardian (or timelock) may pause/unpause opening.
contract RiskParams is IRiskParams, ReentrancyGuardTransient {
    error Unauthorized();
    error OutOfBounds(bytes32 field);
    error ZeroAddress();
    error AlreadyAdded();
    error UnknownUnderlying();
    error TooManyUnderlyings();
    error AlreadyFinalized();

    uint256 private constant MAX_UNDERLYING_TOKENS = 64;

    // ---- underlying bounds ----
    uint128 private constant MIN_STRIKE_STEP = 0.01e18;
    uint128 private constant MAX_STRIKE_STEP = 1000e18;

    uint64 private constant MIN_VOL_FLOOR = 0.05e18;
    uint64 private constant MAX_VOL_FLOOR = 2e18;
    uint64 private constant MAX_VOL_CAP = 5e18; // min is volFloor (dynamic)

    uint64 private constant MIN_LAMBDA = 0.8e18;
    uint64 private constant MAX_LAMBDA = 0.999e18;

    uint64 private constant MIN_SHOCK_K = 1e18;
    uint64 private constant MAX_SHOCK_K = 6e18;

    uint64 private constant MIN_MIN_SHOCK = 0.02e18;
    uint64 private constant MAX_MIN_SHOCK = 0.5e18;

    uint64 private constant MIN_HORIZON_DAYS = 1;
    uint64 private constant MAX_HORIZON_DAYS = 10;

    uint64 private constant MIN_VOL_UP = 0.1e18;
    uint64 private constant MAX_VOL_UP = 2e18;

    uint64 private constant MIN_VOL_DOWN = 0.1e18;
    uint64 private constant MAX_VOL_DOWN = 0.9e18;

    uint64 private constant MIN_MULT = 1e18;
    uint64 private constant MAX_MULT = 4e18;

    uint128 private constant MIN_MAX_OPEN_INTEREST = 1e18;
    uint128 private constant MAX_MAX_OPEN_INTEREST = 1e27;

    uint32 private constant MIN_MAX_STALE_REG_EXT = 300;
    uint32 private constant MAX_MAX_STALE_REG_EXT = 172800;

    uint32 private constant MIN_MAX_STALE_CLOSED = 3600;
    uint32 private constant MAX_MAX_STALE_CLOSED = 345600;

    uint32 private constant MIN_VOL_STALENESS = 3600;
    uint32 private constant MAX_VOL_STALENESS = 604800;

    uint128 private constant MIN_MIN_PRICE = 1e16; // minPrice's sole (independent) bound
    uint128 private constant MAX_MAX_PRICE = 1e24; // maxPrice's hard ceiling; its floor is minPrice (dynamic)

    // ---- global bounds ----
    uint64 private constant MIN_MM_RATIO = 0.5e18;
    uint64 private constant MAX_MM_RATIO = 0.95e18;

    uint64 private constant MAX_DIVERSIFICATION_CREDIT = 0.5e18;

    uint64 private constant MIN_SHORT_OPTION_MIN_PCT = 0.005e18;
    uint64 private constant MAX_SHORT_OPTION_MIN_PCT = 0.1e18;

    uint64 private constant MAX_FEE_RATE = 0.001e18;

    uint64 private constant MIN_FEE_CAP_OF_PREMIUM = 0.01e18;
    uint64 private constant MAX_FEE_CAP_OF_PREMIUM = 0.2e18;

    uint64 private constant MIN_INSURANCE_SHARE = 0.2e18;
    uint64 private constant MAX_INSURANCE_SHARE = 1e18;

    uint64 private constant MAX_START_DISCOUNT = 0.05e18;

    uint64 private constant MAX_MAX_DISCOUNT = 0.25e18; // min is startDiscount (dynamic)

    uint64 private constant MIN_MAX_FRACTION_PER_BID = 0.1e18;
    uint64 private constant MAX_MAX_FRACTION_PER_BID = 1e18;

    uint64 private constant MAX_LIQUIDATION_PENALTY = 0.05e18;

    uint32 private constant MIN_AUCTION_DURATION = 300;
    uint32 private constant MAX_AUCTION_DURATION = 21600;

    uint32 private constant MIN_MAX_SETTLEMENT_LAG = 60;
    uint32 private constant MAX_MAX_SETTLEMENT_LAG = 90000;

    uint32 private constant MIN_HALT_WINDOW = 3600;
    uint32 private constant MAX_HALT_WINDOW = 259200;

    uint32 private constant MIN_MAX_WEEKS_OUT = 1;
    uint32 private constant MAX_MAX_WEEKS_OUT = 12;

    uint64 private constant MIN_MAX_STRIKE_DEVIATION = 0.1e18;
    uint64 private constant MAX_MAX_STRIKE_DEVIATION = 0.9e18;

    int64 private constant MAX_RATE = 0.2e18;

    uint128 private constant MIN_MIN_TRADE_QTY = 1e15;
    uint128 private constant MAX_MIN_TRADE_QTY = 1e18;

    uint128 private constant MAX_DUST_EQUITY = 100e18;

    address public immutable usdg;
    address public immutable treasury;
    address public immutable sequencerUptimeFeed;
    address public immutable timelock;
    address public immutable guardian;
    address public immutable setupAdmin;

    bool public setupFinalized;
    bool public openingPaused;

    GlobalParams private _globals;
    mapping(address => UnderlyingParams) private _underlyings;
    address[] private _underlyingList;

    constructor(
        address usdg_,
        address treasury_,
        address sequencerUptimeFeed_,
        address timelock_,
        address guardian_,
        address setupAdmin_,
        GlobalParams memory initial
    ) {
        // sequencerUptimeFeed_ may be zero (feed disabled); every other role is required.
        if (usdg_ == address(0)) revert ZeroAddress();
        if (treasury_ == address(0)) revert ZeroAddress();
        if (timelock_ == address(0)) revert ZeroAddress();
        if (guardian_ == address(0)) revert ZeroAddress();
        if (setupAdmin_ == address(0)) revert ZeroAddress();
        _validateGlobals(initial);
        usdg = usdg_;
        treasury = treasury_;
        sequencerUptimeFeed = sequencerUptimeFeed_;
        timelock = timelock_;
        guardian = guardian_;
        setupAdmin = setupAdmin_;
        _globals = initial;
    }

    modifier onlyAdminOrTimelock() {
        bool authorized = msg.sender == timelock || (msg.sender == setupAdmin && !setupFinalized);
        if (!authorized) revert Unauthorized();
        _;
    }

    modifier onlyGuardianOrTimelock() {
        if (msg.sender != guardian && msg.sender != timelock) revert Unauthorized();
        _;
    }

    modifier onlySetupAdmin() {
        if (msg.sender != setupAdmin) revert Unauthorized();
        _;
    }

    /// @notice One-shot switch from setupAdmin-assisted setup to timelock-only governance.
    function finalizeSetup() external nonReentrant onlySetupAdmin {
        if (setupFinalized) revert AlreadyFinalized();
        setupFinalized = true;
    }

    function addUnderlying(address token, UnderlyingParams calldata p) external nonReentrant onlyAdminOrTimelock {
        if (token == address(0)) revert ZeroAddress();
        if (p.feed == address(0)) revert ZeroAddress();
        if (_underlyings[token].feed != address(0)) revert AlreadyAdded();
        if (_underlyingList.length >= MAX_UNDERLYING_TOKENS) revert TooManyUnderlyings();
        _validateUnderlying(p);

        uint8 idx = uint8(_underlyingList.length);
        UnderlyingParams memory stored = p;
        stored.index = idx;
        _underlyings[token] = stored;
        _underlyingList.push(token);

        emit UnderlyingAdded(token, idx);
    }

    function setUnderlying(address token, UnderlyingParams calldata p) external nonReentrant onlyAdminOrTimelock {
        UnderlyingParams storage existing = _underlyings[token];
        if (existing.feed == address(0)) revert UnknownUnderlying();
        _validateUnderlying(p);

        UnderlyingParams memory updated = p;
        updated.feed = existing.feed;
        updated.index = existing.index;
        _underlyings[token] = updated;

        emit UnderlyingUpdated(token);
    }

    function setGlobals(GlobalParams calldata g) external nonReentrant onlyAdminOrTimelock {
        _validateGlobals(g);
        _globals = g;
        emit GlobalsUpdated();
    }

    function pauseOpening() external nonReentrant onlyGuardianOrTimelock {
        openingPaused = true;
        emit OpeningPaused(true);
    }

    function unpauseOpening() external nonReentrant onlyGuardianOrTimelock {
        openingPaused = false;
        emit OpeningPaused(false);
    }

    function underlying(address token) external view returns (UnderlyingParams memory) {
        return _underlyings[token];
    }

    function underlyingAt(uint8 index) external view returns (address) {
        return _underlyingList[index];
    }

    function underlyingCount() external view returns (uint256) {
        return _underlyingList.length;
    }

    function globals() external view returns (GlobalParams memory) {
        return _globals;
    }

    function _validateUnderlying(UnderlyingParams memory p) private pure {
        if (p.strikeStep < MIN_STRIKE_STEP || p.strikeStep > MAX_STRIKE_STEP) revert OutOfBounds("strikeStep");
        if (p.volFloor < MIN_VOL_FLOOR || p.volFloor > MAX_VOL_FLOOR) revert OutOfBounds("volFloor");
        if (p.volCap < p.volFloor || p.volCap > MAX_VOL_CAP) revert OutOfBounds("volCap");
        if (p.lambda < MIN_LAMBDA || p.lambda > MAX_LAMBDA) revert OutOfBounds("lambda");
        if (p.shockK < MIN_SHOCK_K || p.shockK > MAX_SHOCK_K) revert OutOfBounds("shockK");
        if (p.minShock < MIN_MIN_SHOCK || p.minShock > MAX_MIN_SHOCK) revert OutOfBounds("minShock");
        if (p.horizonDays < MIN_HORIZON_DAYS || p.horizonDays > MAX_HORIZON_DAYS) revert OutOfBounds("horizonDays");
        if (p.volUp < MIN_VOL_UP || p.volUp > MAX_VOL_UP) revert OutOfBounds("volUp");
        if (p.volDown < MIN_VOL_DOWN || p.volDown > MAX_VOL_DOWN) revert OutOfBounds("volDown");
        if (p.multExtended < MIN_MULT || p.multExtended > MAX_MULT) revert OutOfBounds("multExtended");
        if (p.multWeekend < MIN_MULT || p.multWeekend > MAX_MULT) revert OutOfBounds("multWeekend");
        if (p.multHoliday < MIN_MULT || p.multHoliday > MAX_MULT) revert OutOfBounds("multHoliday");
        if (p.multHalted < MIN_MULT || p.multHalted > MAX_MULT) revert OutOfBounds("multHalted");
        if (p.maxOpenInterest < MIN_MAX_OPEN_INTEREST || p.maxOpenInterest > MAX_MAX_OPEN_INTEREST) {
            revert OutOfBounds("maxOpenInterest");
        }
        if (p.maxStaleRegular < MIN_MAX_STALE_REG_EXT || p.maxStaleRegular > MAX_MAX_STALE_REG_EXT) {
            revert OutOfBounds("maxStaleRegular");
        }
        if (p.maxStaleExtended < MIN_MAX_STALE_REG_EXT || p.maxStaleExtended > MAX_MAX_STALE_REG_EXT) {
            revert OutOfBounds("maxStaleExtended");
        }
        if (p.maxStaleClosed < MIN_MAX_STALE_CLOSED || p.maxStaleClosed > MAX_MAX_STALE_CLOSED) {
            revert OutOfBounds("maxStaleClosed");
        }
        if (p.volStaleness < MIN_VOL_STALENESS || p.volStaleness > MAX_VOL_STALENESS) {
            revert OutOfBounds("volStaleness");
        }
        // minPrice carries only its independent lower bound; maxPrice is the dependent field and
        // carries the cross-field ordering check, mirroring the volCap/maxDiscount pattern.
        if (p.minPrice < MIN_MIN_PRICE) revert OutOfBounds("minPrice");
        if (p.maxPrice <= p.minPrice || p.maxPrice > MAX_MAX_PRICE) revert OutOfBounds("maxPrice");
    }

    function _validateGlobals(GlobalParams memory g) private pure {
        if (g.mmRatio < MIN_MM_RATIO || g.mmRatio > MAX_MM_RATIO) revert OutOfBounds("mmRatio");
        if (g.diversificationCredit > MAX_DIVERSIFICATION_CREDIT) revert OutOfBounds("diversificationCredit");
        if (g.shortOptionMinPct < MIN_SHORT_OPTION_MIN_PCT || g.shortOptionMinPct > MAX_SHORT_OPTION_MIN_PCT) {
            revert OutOfBounds("shortOptionMinPct");
        }
        if (g.feeRate > MAX_FEE_RATE) revert OutOfBounds("feeRate");
        if (g.feeCapOfPremium < MIN_FEE_CAP_OF_PREMIUM || g.feeCapOfPremium > MAX_FEE_CAP_OF_PREMIUM) {
            revert OutOfBounds("feeCapOfPremium");
        }
        if (g.insuranceShare < MIN_INSURANCE_SHARE || g.insuranceShare > MAX_INSURANCE_SHARE) {
            revert OutOfBounds("insuranceShare");
        }
        if (g.startDiscount > MAX_START_DISCOUNT) revert OutOfBounds("startDiscount");
        if (g.maxDiscount < g.startDiscount || g.maxDiscount > MAX_MAX_DISCOUNT) revert OutOfBounds("maxDiscount");
        if (g.maxFractionPerBid < MIN_MAX_FRACTION_PER_BID || g.maxFractionPerBid > MAX_MAX_FRACTION_PER_BID) {
            revert OutOfBounds("maxFractionPerBid");
        }
        if (g.liquidationPenalty > MAX_LIQUIDATION_PENALTY) revert OutOfBounds("liquidationPenalty");
        if (g.auctionDuration < MIN_AUCTION_DURATION || g.auctionDuration > MAX_AUCTION_DURATION) {
            revert OutOfBounds("auctionDuration");
        }
        if (g.maxSettlementLag < MIN_MAX_SETTLEMENT_LAG || g.maxSettlementLag > MAX_MAX_SETTLEMENT_LAG) {
            revert OutOfBounds("maxSettlementLag");
        }
        if (g.haltWindow < MIN_HALT_WINDOW || g.haltWindow > MAX_HALT_WINDOW) revert OutOfBounds("haltWindow");
        if (g.maxWeeksOut < MIN_MAX_WEEKS_OUT || g.maxWeeksOut > MAX_MAX_WEEKS_OUT) {
            revert OutOfBounds("maxWeeksOut");
        }
        if (g.maxStrikeDeviation < MIN_MAX_STRIKE_DEVIATION || g.maxStrikeDeviation > MAX_MAX_STRIKE_DEVIATION) {
            revert OutOfBounds("maxStrikeDeviation");
        }
        if (g.rate < 0 || g.rate > MAX_RATE) revert OutOfBounds("rate");
        if (g.minTradeQty < MIN_MIN_TRADE_QTY || g.minTradeQty > MAX_MIN_TRADE_QTY) {
            revert OutOfBounds("minTradeQty");
        }
        if (g.dustEquity > MAX_DUST_EQUITY) revert OutOfBounds("dustEquity");
    }
}
