// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ISeriesRegistry} from "../interfaces/ISeriesRegistry.sol";
import {IRiskParams, UnderlyingParams, GlobalParams} from "../interfaces/IRiskParams.sol";
import {IMarketDataHub} from "../interfaces/IMarketDataHub.sol";
import {NyseCalendar} from "../libraries/NyseCalendar.sol";
import {Series} from "../types/Types.sol";

/// @notice Permissionless registry of option series (weekly NYSE-close expiries) and of the
/// one-shot settlement price per (underlying, expiry). Series ids start at 1.
contract SeriesRegistry is ISeriesRegistry, ReentrancyGuardTransient {
    error ZeroAddress();
    error UnderlyingDisabled();
    error UnderlyingHalted();
    error NotWeeklyExpiry();
    error BadExpiry();
    error BadStrike();
    error StrikeTooFar();
    error AlreadySettled();

    IRiskParams public immutable params;
    IMarketDataHub public immutable hub;

    Series[] private _series; // _series[id - 1]
    mapping(bytes32 key => uint32 id) private _ids;
    mapping(address underlying => mapping(uint64 expiry => uint256 price)) private _settlePrice;
    mapping(address underlying => mapping(uint64 expiry => bool done)) private _settled;

    constructor(IRiskParams params_, IMarketDataHub hub_) {
        if (address(params_) == address(0) || address(hub_) == address(0)) revert ZeroAddress();
        params = params_;
        hub = hub_;
    }

    function listSeries(address u, uint64 expiry, uint128 strike, bool isCall)
        external
        nonReentrant
        returns (uint32 id)
    {
        bytes32 key = _key(u, expiry, strike, isCall);
        id = _ids[key];
        if (id != 0) return id;

        UnderlyingParams memory p = params.underlying(u);
        if (!p.enabled) revert UnderlyingDisabled();
        (uint256 spot,, bool ok) = hub.spot(u);
        if (!ok) revert UnderlyingHalted();

        if (!NyseCalendar.isWeeklyExpiry(expiry)) revert NotWeeklyExpiry();
        if (expiry <= block.timestamp) revert BadExpiry();
        GlobalParams memory g = params.globals();
        if (expiry > block.timestamp + uint256(g.maxWeeksOut) * 7 days) revert BadExpiry();

        if (strike == 0 || strike % p.strikeStep != 0) revert BadStrike();
        uint256 diff = strike > spot ? strike - spot : spot - strike;
        if (diff > spot * g.maxStrikeDeviation / 1e18) revert StrikeTooFar();

        _series.push(Series({underlying: u, expiry: expiry, isCall: isCall, strike: strike}));
        id = uint32(_series.length);
        _ids[key] = id;
        emit SeriesListed(id, u, expiry, strike, isCall);
    }

    function seriesId(address u, uint64 expiry, uint128 strike, bool isCall) external view returns (uint32) {
        return _ids[_key(u, expiry, strike, isCall)];
    }

    function series(uint32 id) external view returns (Series memory) {
        return _series[id - 1];
    }

    function seriesCount() external view returns (uint32) {
        return uint32(_series.length);
    }

    function settleExpiry(address u, uint64 expiry, uint80 roundIdHint) external nonReentrant returns (uint256 price) {
        if (_settled[u][expiry]) revert AlreadySettled();
        price = hub.settlementPrice(u, expiry, roundIdHint);
        _store(u, expiry, price, roundIdHint, false);
    }

    function settleExpiryFallback(address u, uint64 expiry, uint80 firstAfterHint)
        external
        nonReentrant
        returns (uint256 price)
    {
        if (_settled[u][expiry]) revert AlreadySettled();
        price = hub.settlementPriceFallback(u, expiry, firstAfterHint);
        _store(u, expiry, price, firstAfterHint, true);
    }

    function settlementPriceOf(address u, uint64 expiry) external view returns (uint256 price, bool settled) {
        return (_settlePrice[u][expiry], _settled[u][expiry]);
    }

    function _store(address u, uint64 expiry, uint256 price, uint80 roundId, bool fallbackUsed) private {
        _settlePrice[u][expiry] = price;
        _settled[u][expiry] = true;
        emit ExpirySettled(u, expiry, price, roundId, fallbackUsed);
    }

    function _key(address u, uint64 expiry, uint128 strike, bool isCall) private pure returns (bytes32) {
        return keccak256(abi.encode(u, expiry, strike, isCall));
    }
}
