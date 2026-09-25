// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IScaledUiAmount {
    function uiMultiplier() external view returns (uint256);
    function newUIMultiplier() external view returns (uint256);
    function effectiveAt() external view returns (uint256);
    function paused() external view returns (bool);
    function oraclePaused() external view returns (bool);
}
