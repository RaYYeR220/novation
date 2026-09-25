// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";

/// @notice Test-only Chainlink-style feed. Round ids pack phase and per-phase round number
/// exactly like the real RH proxy: roundId = (phase << 64) | aggRound. A round that was
/// never pushed reads back as zeros (does not revert), matching the real feed behaviour
/// that MarketDataHub depends on for settlement and vol pokes.
contract MockAggregator is IAggregatorV3 {
    struct Round {
        int256 answer;
        uint256 updatedAt;
    }

    uint8 private immutable _decimals;
    string private _description;
    uint16 private _phase = 1;

    mapping(uint16 => uint64) private _latestAggRound;
    mapping(uint16 => mapping(uint64 => Round)) private _rounds;

    constructor(uint8 decimals_, string memory description_) {
        _decimals = decimals_;
        _description = description_;
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function description() external view returns (string memory) {
        return _description;
    }

    /// @notice Simulates a Chainlink phase change (aggregator upgrade behind the proxy).
    function setPhase(uint16 phase_) external {
        _phase = phase_;
    }

    /// @notice Pushes the next round in the current phase and returns its packed id.
    function pushRound(int256 answer, uint256 updatedAt) external returns (uint80 roundId) {
        uint64 n = _latestAggRound[_phase] + 1;
        _latestAggRound[_phase] = n;
        _rounds[_phase][n] = Round({answer: answer, updatedAt: updatedAt});
        roundId = _pack(_phase, n);
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        uint64 n = _latestAggRound[_phase];
        Round memory r = _rounds[_phase][n];
        roundId = _pack(_phase, n);
        answer = r.answer;
        startedAt = r.updatedAt;
        updatedAt = r.updatedAt;
        answeredInRound = roundId;
    }

    /// @notice Mirrors the RH proxy: a round that doesn't exist returns zeros, never reverts.
    function getRoundData(uint80 roundId)
        external
        view
        returns (uint80, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        uint16 phase = uint16(roundId >> 64);
        uint64 n = uint64(roundId);
        Round memory r = _rounds[phase][n];
        answer = r.answer;
        startedAt = r.updatedAt;
        updatedAt = r.updatedAt;
        answeredInRound = roundId;
        return (roundId, answer, startedAt, updatedAt, answeredInRound);
    }

    function _pack(uint16 phase, uint64 aggRound) private pure returns (uint80) {
        return (uint80(phase) << 64) | uint80(aggRound);
    }
}
