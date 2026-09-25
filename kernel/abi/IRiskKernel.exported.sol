// SPDX-License-Identifier: MIT
// Interface exported from the Stylus risk kernel (`cargo test --features export-abi --test export_abi`).
// It must keep the selectors of contracts/src/interfaces/IRiskKernel.sol.
pragma solidity 0.8.30;

struct KParams { uint256 nowTs; int256 rate; uint256 diversificationCredit; uint256 shortOptionMinPct; }
struct KUnderlying { uint256 spot; uint256 vol; uint256 shockRange; uint256 volUp; uint256 volDown; int256 tokenQty; }
struct KPosition { uint256 u; bool isCall; uint256 expiry; uint256 strike; int256 qty; }
struct KMarginOut { int256 mtm; uint256 lossIM; uint256 lossCorr; uint256 lossIndep; uint256 shortMin; uint256 worstScenario; }

interface IRiskKernel {
    function margin(KParams p, KUnderlying[] memory us, KPosition[] memory ps) external view returns (KMarginOut memory, int256[] memory);

    function scenarioGrid(KParams p, KUnderlying[] memory us, KPosition[] memory ps) external view returns (int256[] memory);

    function bsQuote(uint256 spot, uint256 strike, uint256 tau, uint256 vol, int256 rate, bool isCall) external view returns (uint256, int256, uint256, uint256, int256);

    function ewmaUpdate(uint256 prevR2, uint256 prevDt, uint256 lastPrice, uint256[] memory prices, uint256[] memory dts, uint256 lambda) external view returns (uint256, uint256);

    error ExpOverflow();

    error LnNonPositive();

    error BadUnderlyingIndex();

    error BadShockRange();

    error LengthMismatch();

    error Panic(uint256);
}
