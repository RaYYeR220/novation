// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {Session} from "../types/Types.sol";

interface IMarketDataHub {
    event VolPoked(address indexed underlying, uint80 lastRoundId, uint256 variance);
    event VolInitialized(address indexed underlying, uint80 roundId);
    event VolRebased(address indexed underlying, uint80 oldRoundId, uint80 newRoundId);

    function session(address u) external view returns (Session);
    /// @return price last valid WAD price (reverts NoPrice if answer <= 0), s session (HALTED if unusable), ok == (s != HALTED)
    function spot(address u) external view returns (uint256 price, Session s, bool ok);
    function markVol(address u) external view returns (uint256 vol);
    function settlementPrice(address u, uint64 expiry, uint80 roundIdHint) external view returns (uint256 price);
    /// @notice Oracle-only fallback when the normal last-round proof can't be produced (pre-close print stale or implausible). Callable 72h after expiry.
    function settlementPriceFallback(address u, uint64 expiry, uint80 firstAfterHint)
        external
        view
        returns (uint256 price);
    /// @notice Oracle-only last resort 7 days after expiry: the last print at or before the close, proven as in settlementPrice, without the lag bound.
    function settlementPriceLastResort(address u, uint64 expiry, uint80 roundIdHint)
        external
        view
        returns (uint256 price);
    function initVol(address u) external;
    function pokeVol(address u, uint80[] calldata roundIds) external;
    function syncVol(address u) external; // permissionless: pokes every round up to the feed's latest (same phase, <= 64 per call)
    function syncVolUpTo(address u, uint256 maxRounds) external returns (bool current); // syncVol folding <= maxRounds; current afterwards
    function volCurrent(address u) external view returns (bool); // the vol estimate has folded in the feed's latest round
    function volStale(address u) external view returns (bool); // markVol is at volCap: a printed round has sat unfolded for volStaleness
    function volState(address u)
        external
        view
        returns (uint256 r2, uint256 dt, uint80 lastRoundId, uint256 lastPrice, uint64 lastUpdatedAt, uint64 lastPokeTs);
    function rebaseVol(address u) external; // permissionless: after a Chainlink phase change, restart from the latest round (keeps r2/dt)
}
