// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {Series} from "../types/Types.sol";

interface ISeriesRegistry {
    event SeriesListed(uint32 indexed id, address indexed underlying, uint64 expiry, uint128 strike, bool isCall);
    event ExpirySettled(address indexed underlying, uint64 indexed expiry, uint256 price, uint80 roundId);

    function listSeries(address u, uint64 expiry, uint128 strike, bool isCall) external returns (uint32 id);
    function seriesId(address u, uint64 expiry, uint128 strike, bool isCall) external view returns (uint32); // 0 = none
    function series(uint32 id) external view returns (Series memory);
    function seriesCount() external view returns (uint32);
    function settleExpiry(address u, uint64 expiry, uint80 roundIdHint) external returns (uint256 price);
    function settlementPriceOf(address u, uint64 expiry) external view returns (uint256 price, bool settled);
}
