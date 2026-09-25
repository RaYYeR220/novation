// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {KParams, KUnderlying, KPosition, KMarginOut} from "../types/Types.sol";

interface IRiskKernel {
    function margin(KParams calldata p, KUnderlying[] calldata us, KPosition[] calldata ps)
        external view returns (KMarginOut memory out, int256[] memory perUnderlyingWorst);
    /// @return pnl length 39: correlated portfolio PnL per scenario (index = v*13 + j)
    function scenarioGrid(KParams calldata p, KUnderlying[] calldata us, KPosition[] calldata ps)
        external view returns (int256[] memory pnl);
    function bsQuote(uint256 spot, uint256 strike, uint256 tau, uint256 vol, int256 rate, bool isCall)
        external view returns (uint256 price, int256 delta, uint256 gamma, uint256 vega, int256 theta);
    function ewmaUpdate(uint256 prevR2, uint256 prevDt, uint256 lastPrice, uint256[] calldata prices,
        uint256[] calldata dts, uint256 lambda) external view returns (uint256 r2, uint256 dt);
}
