// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IMarketDataHub} from "../interfaces/IMarketDataHub.sol";
import {IRiskParams, UnderlyingParams} from "../interfaces/IRiskParams.sol";
import {IRiskKernel} from "../interfaces/IRiskKernel.sol";
import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";
import {IScaledUiAmount} from "../interfaces/IScaledUiAmount.sol";
import {NyseCalendar} from "../libraries/NyseCalendar.sol";
import {FixedPointMath as F} from "../libraries/FixedPointMath.sol";
import {Session, YEAR} from "../types/Types.sol";

/// @notice Session/halt oracle, spot price source and on-chain realized-vol EWMA for one
/// risk-params registry. Every halt condition here is fail-closed: on any doubt about a
/// feed or a token, the session reads HALTED rather than REGULAR.
contract MarketDataHub is IMarketDataHub, ReentrancyGuardTransient {
    error ZeroAddress();
    error NoPrice();
    error ImplausiblePrice();
    error NotExpiry();
    error TooEarly();
    error BadHint();
    error NextRoundMissing();
    error NonConsecutiveRound();
    error InvalidRound();
    error BadRoundCount();
    error AlreadyInitialized();
    error NotInitialized();
    error NoPhaseChange();

    struct VolState {
        bool initialized;
        uint256 r2;
        uint256 dt;
        uint80 lastRoundId;
        uint256 lastPrice;
        uint64 lastUpdatedAt;
        uint64 lastPokeTs;
    }

    /// @dev Intermediate result of one halt evaluation; shared by session() and spot()
    /// so both read the feed and the token exactly once per call.
    struct Eval {
        Session base;
        bool hasPrice; // answer > 0
        uint256 wadPrice;
        bool inBand; // wadPrice within [minPrice, maxPrice], only meaningful if hasPrice
        bool halted;
    }

    IRiskParams public immutable params;
    IRiskKernel public immutable kernel;

    mapping(address => VolState) private _vol;

    constructor(IRiskParams params_, IRiskKernel kernel_) {
        if (address(params_) == address(0)) revert ZeroAddress();
        if (address(kernel_) == address(0)) revert ZeroAddress();
        params = params_;
        kernel = kernel_;
    }

    // ---- session / spot ----

    function session(address u) external view returns (Session) {
        Eval memory e = _evaluate(u);
        return e.halted ? Session.HALTED : e.base;
    }

    /// @return price last valid WAD price (reverts NoPrice if answer <= 0),
    /// s session (HALTED if unusable), ok == (s != HALTED)
    function spot(address u) external view returns (uint256 price, Session s, bool ok) {
        Eval memory e = _evaluate(u);
        if (!e.hasPrice) revert NoPrice();
        if (!e.inBand) revert ImplausiblePrice();
        price = e.wadPrice;
        s = e.halted ? Session.HALTED : e.base;
        ok = !e.halted;
    }

    function _evaluate(address u) private view returns (Eval memory e) {
        UnderlyingParams memory p = params.underlying(u);
        e.base = NyseCalendar.baseSession(block.timestamp);

        (, int256 answer,, uint256 updatedAt,) = IAggregatorV3(p.feed).latestRoundData();
        if (answer <= 0) {
            e.halted = true;
            return e;
        }
        e.hasPrice = true;
        uint8 dec = IAggregatorV3(p.feed).decimals();
        e.wadPrice = uint256(answer) * (10 ** (18 - dec));
        e.inBand = e.wadPrice >= p.minPrice && e.wadPrice <= p.maxPrice;

        uint256 staleLimit = e.base == Session.REGULAR
            ? p.maxStaleRegular
            : e.base == Session.EXTENDED ? p.maxStaleExtended : p.maxStaleClosed;
        if (block.timestamp - updatedAt > staleLimit) {
            e.halted = true;
            return e;
        }

        if (_tokenHalted(u)) {
            e.halted = true;
            return e;
        }

        if (!e.inBand) {
            e.halted = true;
            return e;
        }

        uint256 ea = IScaledUiAmount(u).effectiveAt();
        if (ea != 0) {
            uint32 haltWindow = params.globals().haltWindow;
            if (block.timestamp + haltWindow >= ea && block.timestamp <= ea + 3600) {
                e.halted = true;
                return e;
            }
        }

        address seq = params.sequencerUptimeFeed();
        if (seq != address(0)) {
            (, int256 seqAnswer, uint256 seqStartedAt,,) = IAggregatorV3(seq).latestRoundData();
            if (seqAnswer == 1 || block.timestamp - seqStartedAt < 3600) {
                e.halted = true;
                return e;
            }
        }
    }

    /// @dev true if the token reports paused/oraclePaused, or either call reverts (fail closed).
    function _tokenHalted(address u) private view returns (bool) {
        try IScaledUiAmount(u).paused() returns (bool p) {
            if (p) return true;
        } catch {
            return true;
        }
        try IScaledUiAmount(u).oraclePaused() returns (bool p) {
            if (p) return true;
        } catch {
            return true;
        }
        return false;
    }

    // ---- realized vol ----

    function markVol(address u) external view returns (uint256 vol) {
        VolState storage v = _vol[u];
        UnderlyingParams memory p = params.underlying(u);
        if (!v.initialized || block.timestamp - v.lastPokeTs > p.volStaleness) {
            return p.volCap;
        }
        uint256 raw = F.sqrtWad(_divWad(v.r2, v.dt));
        if (raw < p.volFloor) return p.volFloor;
        if (raw > p.volCap) return p.volCap;
        return raw;
    }

    function initVol(address u) external nonReentrant {
        VolState storage v = _vol[u];
        if (v.initialized) revert AlreadyInitialized();
        UnderlyingParams memory p = params.underlying(u);
        (uint80 roundId, int256 answer,, uint256 updatedAt,) = IAggregatorV3(p.feed).latestRoundData();
        if (answer <= 0 || updatedAt == 0) revert InvalidRound();

        uint256 d = uint256(86400e18) / YEAR;
        uint256 volCap2 = _mulWad(p.volCap, p.volCap);

        v.initialized = true;
        v.r2 = _mulWad(volCap2, d);
        v.dt = d;
        v.lastRoundId = roundId;
        v.lastPrice = uint256(answer);
        v.lastUpdatedAt = uint64(updatedAt);
        v.lastPokeTs = uint64(block.timestamp);

        emit VolInitialized(u, roundId);
    }

    function pokeVol(address u, uint80[] calldata roundIds) external nonReentrant {
        uint256 n = roundIds.length;
        if (n == 0 || n > 64) revert BadRoundCount();

        VolState storage v = _vol[u];
        if (!v.initialized) revert NotInitialized();
        UnderlyingParams memory p = params.underlying(u);
        IAggregatorV3 feed = IAggregatorV3(p.feed);

        uint80 prevId = v.lastRoundId;
        uint256 prevUpdatedAt = v.lastUpdatedAt;

        uint256[] memory prices = new uint256[](n);
        uint256[] memory dts = new uint256[](n);

        for (uint256 i = 0; i < n; ++i) {
            uint80 id = roundIds[i];
            if ((id >> 64) != (prevId >> 64) || uint64(id) != uint64(prevId) + 1) {
                revert NonConsecutiveRound();
            }
            (, int256 answer,, uint256 updatedAt,) = feed.getRoundData(id);
            if (answer <= 0 || updatedAt < prevUpdatedAt) revert InvalidRound();

            prices[i] = uint256(answer);
            dts[i] = updatedAt - prevUpdatedAt;
            prevId = id;
            prevUpdatedAt = updatedAt;
        }

        (uint256 r2, uint256 dt) = kernel.ewmaUpdate(v.r2, v.dt, v.lastPrice, prices, dts, p.lambda);

        v.r2 = r2;
        v.dt = dt;
        v.lastRoundId = prevId;
        v.lastPrice = prices[n - 1];
        v.lastUpdatedAt = uint64(prevUpdatedAt);
        v.lastPokeTs = uint64(block.timestamp);

        emit VolPoked(u, prevId, r2);
    }

    /// @notice Permissionless: after a Chainlink phase change, restart the round anchor
    /// from the latest round. r2/dt (the EWMA state) are kept as-is.
    function rebaseVol(address u) external nonReentrant {
        VolState storage v = _vol[u];
        if (!v.initialized) revert NotInitialized();
        UnderlyingParams memory p = params.underlying(u);
        (uint80 roundId, int256 answer,, uint256 updatedAt,) = IAggregatorV3(p.feed).latestRoundData();
        if ((roundId >> 64) <= (v.lastRoundId >> 64)) revert NoPhaseChange();
        if (answer <= 0 || updatedAt == 0) revert InvalidRound();

        v.lastRoundId = roundId;
        v.lastPrice = uint256(answer);
        v.lastUpdatedAt = uint64(updatedAt);
    }

    function volState(address u)
        external
        view
        returns (uint256 r2, uint256 dt, uint80 lastRoundId, uint256 lastPrice, uint64 lastUpdatedAt, uint64 lastPokeTs)
    {
        VolState storage v = _vol[u];
        return (v.r2, v.dt, v.lastRoundId, v.lastPrice, v.lastUpdatedAt, v.lastPokeTs);
    }

    // ---- settlement ----

    /// @notice The feed's last print at or before the weekly expiry close. RH equity
    /// feeds publish no round at the Friday close, so the caller must supply a hint
    /// round and prove it is the last one at or before expiry: either the following
    /// round exists and printed after expiry, or the hint is still the latest round
    /// (no later round exists yet, so any future one must print at/after now > expiry).
    function settlementPrice(address u, uint64 expiry, uint80 hint) external view returns (uint256 price) {
        if (!NyseCalendar.isWeeklyExpiry(expiry)) revert NotExpiry();
        if (block.timestamp < expiry) revert TooEarly();

        UnderlyingParams memory p = params.underlying(u);
        IAggregatorV3 feed = IAggregatorV3(p.feed);

        (, int256 answer,, uint256 updatedAt,) = feed.getRoundData(hint);
        if (answer <= 0 || updatedAt == 0) revert BadHint();
        if (updatedAt > expiry) revert BadHint();
        if (expiry - updatedAt > params.globals().maxSettlementLag) revert BadHint();

        (,,, uint256 nextUpdatedAt,) = feed.getRoundData(hint + 1);
        if (nextUpdatedAt != 0) {
            if (nextUpdatedAt <= expiry) revert NextRoundMissing();
        } else {
            (uint80 latestId,,,,) = feed.latestRoundData();
            if (latestId != hint) revert NextRoundMissing();
        }

        uint8 dec = feed.decimals();
        price = uint256(answer) * (10 ** (18 - dec));
    }

    // ---- WAD helpers (uint256; the shared FixedPointMath is signed-only) ----

    function _mulWad(uint256 a, uint256 b) private pure returns (uint256) {
        return uint256(F.mulWad(int256(a), int256(b)));
    }

    function _divWad(uint256 a, uint256 b) private pure returns (uint256) {
        return uint256(F.divWad(int256(a), int256(b)));
    }
}
