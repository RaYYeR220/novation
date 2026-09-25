// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
    function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function getRoundData(uint80 roundId) external view returns (uint80, int256, uint256, uint256, uint80);
}
