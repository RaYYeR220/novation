// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IMarketDataHub} from "../interfaces/IMarketDataHub.sol";
import {IRiskParams, UnderlyingParams} from "../interfaces/IRiskParams.sol";
import {IRiskKernel} from "../interfaces/IRiskKernel.sol";
import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";
import {NyseCalendar} from "../libraries/NyseCalendar.sol";
import {FixedPointMath as F} from "../libraries/FixedPointMath.sol";
import {Session, YEAR} from "../types/Types.sol";

/// @notice Session/halt oracle, spot price source and on-chain realized-vol EWMA for one
/// risk-params registry. Every halt condition here is fail-closed: on any doubt about a
/// feed or a token, the session reads HALTED rather than REGULAR, and session()/spot()
/// never revert because of a misbehaving feed or token (spot keeps its explicit
/// NoPrice/ImplausiblePrice reverts).
contract MarketDataHub is IMarketDataHub, ReentrancyGuardTransient {
    error ZeroAddress();
    error NoPrice();
    error ImplausiblePrice();
    error NotExpiry();
    error TooEarly();
    error BadHint();
    error NextRoundMissing();
    error NotFirstAfter();
    error FallbackNotAllowed();
    error NonConsecutiveRound();
    error InvalidRound();
    error BadRoundCount();
    error BadDecimals();
    error AlreadyInitialized();
    error NotInitialized();
    error NoPhaseChange();
    error PhaseNotExhausted();

    uint256 private constant FALLBACK_DELAY = 72 hours;
    uint256 private constant SEQ_GRACE = 3600;
    uint64 private constant MAX_ROUND_SEARCH = 1 << 40;

    /// @dev lastPrice is stored in WAD (feed answer scaled by 10**(18 - decimals)).
    struct VolState {
        uint256 r2;
        uint256 dt;
        uint256 lastPrice;
        bool initialized;
        uint80 lastRoundId;
        uint64 lastUpdatedAt;
        uint64 lastPokeTs;
    }

    /// @dev Intermediate result of one halt evaluation, shared by session() and spot().
    struct Eval {
        Session base;
        bool hasPrice; // feed readable, answer > 0, decimals <= 18
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

    /// @return price last valid WAD price (reverts NoPrice if unreadable or answer <= 0),
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
        e.halted = true; // closed unless every check below passes
        UnderlyingParams memory p = params.underlying(u);
        e.base = NyseCalendar.baseSession(block.timestamp);

        uint256 updatedAt;
        {
            // raw reads: a feed that reverts, has no code or returns data that wouldn't decode
            // (short, or a word out of its type's range) reads as no price, never as a revert
            (bool ok, int256 answer,, uint256 ut) = _readRound(p.feed);
            if (!ok) return e;
            updatedAt = ut;
            uint256 dec;
            (ok, dec) = _readUint(p.feed, IAggregatorV3.decimals.selector);
            if (!ok || answer <= 0 || dec > 18 || uint256(answer) > type(uint128).max) return e;
            e.hasPrice = true;
            e.wadPrice = uint256(answer) * (10 ** (18 - dec));
            e.inBand = e.wadPrice >= p.minPrice && e.wadPrice <= p.maxPrice;
        }

        if (updatedAt > block.timestamp) return e;
        uint256 staleLimit = e.base == Session.REGULAR
            ? p.maxStaleRegular
            : e.base == Session.EXTENDED ? p.maxStaleExtended : p.maxStaleClosed;
        if (block.timestamp - updatedAt > staleLimit) return e;

        if (_pausedOrUnreadable(u)) return e;
        if (!e.inBand) return e;
        if (_inMultiplierWindow(u)) return e;
        if (_sequencerBad()) return e;

        e.halted = false;
    }

    /// @dev true if paused()/oraclePaused() report true, revert, or return malformed data.
    function _pausedOrUnreadable(address u) private view returns (bool) {
        (bool ok, uint256 v) = _readUint(u, bytes4(keccak256("paused()")));
        if (!ok || v != 0) return true;
        (ok, v) = _readUint(u, bytes4(keccak256("oraclePaused()")));
        return !ok || v != 0;
    }

    /// @dev true if effectiveAt() is unreadable or now is in [ea - haltWindow, ea + 1h].
    function _inMultiplierWindow(address u) private view returns (bool) {
        (bool ok, uint256 ea) = _readUint(u, bytes4(keccak256("effectiveAt()")));
        if (!ok) return true;
        if (ea == 0) return false;
        uint256 haltWindow = params.globals().haltWindow;
        if (block.timestamp + haltWindow < ea) return false;
        return ea >= block.timestamp || block.timestamp - ea <= 3600;
    }

    /// @dev true if the sequencer feed is configured and down, unreadable, or inside its grace period.
    function _sequencerBad() private view returns (bool) {
        address seq = params.sequencerUptimeFeed();
        if (seq == address(0)) return false;
        (bool ok, int256 a, uint256 startedAt,) = _readRound(seq);
        if (!ok || a != 0 || startedAt == 0 || startedAt > block.timestamp) return true;
        return block.timestamp - startedAt < SEQ_GRACE;
    }

    /// @dev staticcall that reads one 32-byte word; ok is false on revert or short return data.
    function _readUint(address target, bytes4 selector) private view returns (bool ok, uint256 v) {
        bytes memory cd = abi.encodeWithSelector(selector);
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, 0)
            ok := staticcall(gas(), target, add(cd, 0x20), mload(cd), ptr, 0x20)
            if lt(returndatasize(), 0x20) { ok := 0 }
            v := mload(ptr)
        }
    }

    /// @dev latestRoundData() as raw words; ok is false on revert or when the call returns fewer
    /// than its five words. The round id words aren't used, so they aren't checked.
    function _readRound(address feed)
        private
        view
        returns (bool ok, int256 answer, uint256 startedAt, uint256 updatedAt)
    {
        bytes4 sel = IAggregatorV3.latestRoundData.selector;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, sel)
            ok := staticcall(gas(), feed, ptr, 4, ptr, 0xa0)
            if lt(returndatasize(), 0xa0) { ok := 0 }
            if ok {
                answer := mload(add(ptr, 0x20))
                startedAt := mload(add(ptr, 0x40))
                updatedAt := mload(add(ptr, 0x60))
            }
        }
    }

    // ---- realized vol ----

    /// @notice The mark vol: the EWMA estimate clamped to [volFloor, volCap]. It falls back to
    /// volCap before initVol, and when the estimate is stale: not refreshed within volStaleness
    /// while the feed has printed a round it hasn't folded in. A feed that prints nothing (every
    /// weekend, 48 hours and more) leaves the estimate current, so the marks don't jump to volCap
    /// at the reopen; a round printed but not yet folded does, until anyone syncs (syncVol).
    function markVol(address u) external view returns (uint256 vol) {
        VolState storage v = _vol[u];
        UnderlyingParams memory p = params.underlying(u);
        if (!v.initialized || (block.timestamp - v.lastPokeTs > p.volStaleness && !_current(v, p.feed))) {
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
        IAggregatorV3 feed = IAggregatorV3(p.feed);
        (uint80 roundId, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        if (answer <= 0 || updatedAt == 0) revert InvalidRound();

        uint256 d = uint256(86400e18) / YEAR;
        uint256 volCap2 = _mulWad(p.volCap, p.volCap);

        v.initialized = true;
        v.r2 = _mulWad(volCap2, d);
        v.dt = d;
        v.lastRoundId = roundId;
        v.lastPrice = _scale(feed, answer);
        v.lastUpdatedAt = uint64(updatedAt);
        v.lastPokeTs = uint64(block.timestamp);

        emit VolInitialized(u, roundId);
    }

    /// @notice Feeds consecutive rounds into the EWMA. Ids at or before the stored round in the
    /// stored phase are skipped (so a front-run poke can't make a keeper batch revert); the rest
    /// must be consecutive from the stored round + 1. A batch with nothing new is a no-op.
    function pokeVol(address u, uint80[] calldata roundIds) external nonReentrant {
        uint256 n = roundIds.length;
        if (n == 0 || n > 64) revert BadRoundCount();
        VolState storage v = _vol[u];
        if (!v.initialized) revert NotInitialized();
        _fold(u, v, params.underlying(u), roundIds);
    }

    /// @notice Permissionless: feeds every round after the stored one, up to the feed's latest in
    /// the stored phase, into the EWMA, at most 64 per call (call again to catch up further). A
    /// no-op when nothing is new, or when the feed has moved to a later phase (see rebaseVol).
    /// Venues call it before pricing, so the mark vol can't change between their trades in one
    /// transaction.
    function syncVol(address u) external nonReentrant {
        VolState storage v = _vol[u];
        if (!v.initialized) revert NotInitialized();
        UnderlyingParams memory p = params.underlying(u);
        (uint80 latest,,,,) = IAggregatorV3(p.feed).latestRoundData();
        uint80 last = v.lastRoundId;
        if ((latest >> 64) != (last >> 64) || latest <= last) return;
        uint256 n = uint64(latest) - uint64(last);
        if (n > 64) n = 64;
        uint80[] memory ids = new uint80[](n);
        for (uint256 i = 0; i < n; ++i) {
            ids[i] = last + 1 + uint80(i);
        }
        _fold(u, v, p, ids);
    }

    function _fold(address u, VolState storage v, UnderlyingParams memory p, uint80[] memory ids) private {
        (uint256[] memory prices, uint256[] memory dts, uint80 lastId, uint256 lastAt) =
            _collect(IAggregatorV3(p.feed), v.lastRoundId, v.lastUpdatedAt, ids);
        uint256 m = prices.length;
        if (m == 0) {
            // only bad prints: the anchor moves past them, the estimate stays
            if (lastId != v.lastRoundId) v.lastRoundId = lastId;
            return;
        }

        (uint256 r2, uint256 dt) = kernel.ewmaUpdate(v.r2, v.dt, v.lastPrice, prices, dts, p.lambda);

        v.r2 = r2;
        v.dt = dt;
        v.lastRoundId = lastId;
        v.lastPrice = prices[m - 1];
        v.lastUpdatedAt = uint64(lastAt);
        v.lastPokeTs = uint64(block.timestamp);

        emit VolPoked(u, lastId, r2);
    }

    function _collect(IAggregatorV3 feed, uint80 startId, uint256 startAt, uint80[] memory ids)
        private
        view
        returns (uint256[] memory prices, uint256[] memory dts, uint80 prevId, uint256 prevAt)
    {
        uint256 n = ids.length;
        prices = new uint256[](n);
        dts = new uint256[](n);
        prevId = startId;
        prevAt = startAt;
        uint256 mul = _scaleFactor(feed);
        uint256 m;
        for (uint256 i = 0; i < n; ++i) {
            uint80 id = ids[i];
            if ((id >> 64) == (startId >> 64) && id <= startId) continue;
            if ((id >> 64) != (prevId >> 64) || uint64(id) != uint64(prevId) + 1) revert NonConsecutiveRound();
            (int256 answer, uint256 updatedAt) = _round(feed, id);
            if (updatedAt == 0) revert InvalidRound(); // not printed (yet): the anchor can't pass it
            prevId = id;
            // a bad print (no positive answer, or stamped before its predecessor) is skipped: the
            // next good round's return and time span cover it, and the estimate never sticks on it
            if (answer <= 0 || updatedAt < prevAt) continue;
            prices[m] = uint256(answer) * mul;
            dts[m] = updatedAt - prevAt;
            prevAt = updatedAt;
            ++m;
        }
        assembly ("memory-safe") {
            mstore(prices, m)
            mstore(dts, m)
        }
    }

    /// @notice Permissionless: once the stored phase is exhausted (no further round in it) and the
    /// feed has moved to a later phase, restart the round anchor from the latest round.
    /// r2/dt (the EWMA state) are kept as-is.
    function rebaseVol(address u) external nonReentrant {
        VolState storage v = _vol[u];
        if (!v.initialized) revert NotInitialized();
        UnderlyingParams memory p = params.underlying(u);
        IAggregatorV3 feed = IAggregatorV3(p.feed);
        (uint80 roundId, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        uint80 oldId = v.lastRoundId;
        if ((roundId >> 64) <= (oldId >> 64)) revert NoPhaseChange();
        (, uint256 nextAt) = _round(feed, oldId + 1);
        if (nextAt != 0) revert PhaseNotExhausted();
        if (answer <= 0 || updatedAt == 0) revert InvalidRound();

        v.lastRoundId = roundId;
        v.lastPrice = _scale(feed, answer);
        v.lastUpdatedAt = uint64(updatedAt);

        emit VolRebased(u, oldId, roundId);
    }

    /// @notice Whether the vol estimate has folded in the feed's latest round (false before
    /// initVol, after a phase change until rebaseVol, and while the feed can't be read).
    function volCurrent(address u) external view returns (bool) {
        VolState storage v = _vol[u];
        return v.initialized && _current(v, params.underlying(u).feed);
    }

    function _current(VolState storage v, address feed) private view returns (bool) {
        bytes4 sel = IAggregatorV3.latestRoundData.selector;
        bool ok;
        uint256 id;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, sel)
            ok := staticcall(gas(), feed, ptr, 4, ptr, 0xa0)
            if lt(returndatasize(), 0xa0) { ok := 0 }
            id := mload(ptr)
        }
        return ok && id == v.lastRoundId;
    }

    /// @dev lastPrice is in WAD (feed answer scaled to 18 decimals)
    function volState(address u)
        external
        view
        returns (uint256 r2, uint256 dt, uint80 lastRoundId, uint256 lastPrice, uint64 lastUpdatedAt, uint64 lastPokeTs)
    {
        VolState storage v = _vol[u];
        return (v.r2, v.dt, v.lastRoundId, v.lastPrice, v.lastUpdatedAt, v.lastPokeTs);
    }

    // ---- settlement ----

    /// @notice The feed's last print at or before the weekly expiry close. RH equity feeds publish
    /// no round at the Friday close, so the caller supplies a hint round and proves it is the last
    /// one at or before expiry, by any of:
    ///  (i)   the next round in the same phase exists and printed after expiry;
    ///  (ii)  the hint is still the latest round and now is strictly after expiry (any future
    ///        round must print at or after now, hence after expiry);
    ///  (iii) the feed changed phase after the close: round 1 of the next phase printed after expiry.
    /// The price must lie in the plausibility band; if the pre-close print is stale or
    /// implausible, use settlementPriceFallback.
    function settlementPrice(address u, uint64 expiry, uint80 hint) external view returns (uint256 price) {
        if (!NyseCalendar.isWeeklyExpiry(expiry)) revert NotExpiry();
        if (block.timestamp < expiry) revert TooEarly();

        UnderlyingParams memory p = params.underlying(u);
        IAggregatorV3 feed = IAggregatorV3(p.feed);

        (int256 answer, uint256 updatedAt) = _round(feed, hint);
        if (answer <= 0 || updatedAt == 0 || updatedAt > expiry) revert BadHint();
        if (expiry - updatedAt > params.globals().maxSettlementLag) revert BadHint();

        _requireLastRound(feed, expiry, hint);
        price = _bandedPrice(feed, answer, p);
    }

    function _requireLastRound(IAggregatorV3 feed, uint64 expiry, uint80 hint) private view {
        (, uint256 nextAt) = _round(feed, hint + 1);
        if (nextAt != 0) {
            if (nextAt <= expiry) revert NextRoundMissing();
            return;
        }
        (uint80 latestId,,,,) = feed.latestRoundData();
        if (latestId == hint) {
            if (block.timestamp <= expiry) revert NextRoundMissing();
            return;
        }
        if ((latestId >> 64) > (hint >> 64)) {
            (, uint256 firstAt) = _round(feed, (((hint >> 64) + 1) << 64) | 1);
            if (firstAt > expiry) return;
        }
        revert NextRoundMissing();
    }

    /// @notice Oracle-only escape hatch, 72h after expiry. firstAfter must be the first round that
    /// printed after expiry; its predecessor (the last pre-close print) must be older than
    /// maxSettlementLag before expiry or outside the plausibility band. Returns firstAfter's price,
    /// which must itself be in the band.
    function settlementPriceFallback(address u, uint64 expiry, uint80 firstAfter)
        external
        view
        returns (uint256 price)
    {
        if (!NyseCalendar.isWeeklyExpiry(expiry)) revert NotExpiry();
        if (block.timestamp < uint256(expiry) + FALLBACK_DELAY) revert TooEarly();

        UnderlyingParams memory p = params.underlying(u);
        IAggregatorV3 feed = IAggregatorV3(p.feed);

        (int256 answer, uint256 updatedAt) = _round(feed, firstAfter);
        if (answer <= 0 || updatedAt <= expiry) revert BadHint();

        (int256 predAnswer, uint256 predAt) = _predecessor(feed, firstAfter);
        if (predAt == 0 || predAt > expiry) revert NotFirstAfter();
        bool stale = expiry - predAt > params.globals().maxSettlementLag;
        bool implausible = predAnswer <= 0 || !_inBand(_scale(feed, predAnswer), p);
        if (!stale && !implausible) revert FallbackNotAllowed();

        price = _bandedPrice(feed, answer, p);
    }

    function _predecessor(IAggregatorV3 feed, uint80 id) private view returns (int256 answer, uint256 updatedAt) {
        if (uint64(id) > 1) return _round(feed, id - 1);
        uint80 phase = id >> 64;
        if (phase <= 1) return (0, 0);
        uint64 last = _lastRoundOfPhase(feed, phase - 1);
        if (last == 0) return (0, 0);
        return _round(feed, ((phase - 1) << 64) | uint80(last));
    }

    /// @dev Highest existing round number in a phase (0 if none), by doubling then bisecting.
    function _lastRoundOfPhase(IAggregatorV3 feed, uint80 phase) private view returns (uint64) {
        uint80 base = phase << 64;
        if (!_exists(feed, base | 1)) return 0;
        uint64 lo = 1;
        uint64 hi = 2;
        while (hi <= MAX_ROUND_SEARCH && _exists(feed, base | hi)) {
            lo = hi;
            hi <<= 1;
        }
        while (hi - lo > 1) {
            uint64 mid = lo + (hi - lo) / 2;
            if (_exists(feed, base | mid)) lo = mid;
            else hi = mid;
        }
        return lo;
    }

    function _exists(IAggregatorV3 feed, uint80 id) private view returns (bool) {
        (, uint256 updatedAt) = _round(feed, id);
        return updatedAt != 0;
    }

    // ---- helpers ----

    /// @dev getRoundData that maps a revert to "does not exist" (zeros), like a missing round.
    function _round(IAggregatorV3 feed, uint80 id) private view returns (int256 answer, uint256 updatedAt) {
        try feed.getRoundData(id) returns (uint80, int256 a, uint256, uint256 ut, uint80) {
            return (a, ut);
        } catch {
            return (0, 0);
        }
    }

    function _scaleFactor(IAggregatorV3 feed) private view returns (uint256) {
        uint8 dec = feed.decimals();
        if (dec > 18) revert BadDecimals();
        return 10 ** (18 - dec);
    }

    function _scale(IAggregatorV3 feed, int256 answer) private view returns (uint256) {
        return uint256(answer) * _scaleFactor(feed);
    }

    function _inBand(uint256 wad, UnderlyingParams memory p) private pure returns (bool) {
        return wad >= p.minPrice && wad <= p.maxPrice;
    }

    function _bandedPrice(IAggregatorV3 feed, int256 answer, UnderlyingParams memory p)
        private
        view
        returns (uint256 wad)
    {
        wad = _scale(feed, answer);
        if (!_inBand(wad, p)) revert ImplausiblePrice();
    }

    // ---- WAD helpers (uint256; the shared FixedPointMath is signed-only) ----

    function _mulWad(uint256 a, uint256 b) private pure returns (uint256) {
        return uint256(F.mulWad(int256(a), int256(b)));
    }

    function _divWad(uint256 a, uint256 b) private pure returns (uint256) {
        return uint256(F.divWad(int256(a), int256(b)));
    }
}
