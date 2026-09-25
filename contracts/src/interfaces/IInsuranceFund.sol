// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
interface IInsuranceFund {
    event Covered(uint256 requestedWad, uint256 coveredWad);
    event Recovered(uint256 amountWad);
    event WrittenOff(uint256 amountWad);
    function balanceWad() external view returns (uint256);
    function outstandingWad() external view returns (uint256);
    function cover(uint256 amountWad) external returns (uint256 coveredWad); // clearinghouse only; sends min(amount, balance) USDG to the clearinghouse
    function notifyRecovered(uint256 amountWad) external;                    // clearinghouse only
    function notifyWrittenOff(uint256 amountWad) external;                   // clearinghouse only
}
