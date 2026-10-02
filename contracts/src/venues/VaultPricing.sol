// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BlackScholes} from "../libraries/BlackScholes.sol";
import {FixedPointMath as F} from "../libraries/FixedPointMath.sol";
import {WAD} from "../types/Types.sol";

/// @notice Single-option pricing for the option vaults: a linked library, so the Black-Scholes
/// code isn't inlined into each vault (they stay under the contract size limit). Pure; the vault
/// passes in everything it prices with. BlackScholes.price is bit-identical to the risk kernel's
/// bsQuote price and to the mark the kernel gives each position: one evaluation measured 26.9k gas
/// here against 46.5k through an uncached call into the Stylus kernel on Robinhood Chain.
library VaultPricing {
    /// @notice Price per contract for a vault quote:
    ///   volQ = vol * (1 + skewSlope * |ln(K / S)| + utilTerm) + sessionAdd
    ///   taker buys:  px(volQ)
    ///   taker sells: min(px(volQ), px(vol)), never above the price NAV marks the short at
    function unitPrice(
        uint256 spot,
        uint256 strike,
        uint256 tau,
        uint256 vol,
        uint256 skewSlope,
        uint256 utilTerm,
        uint256 sessionAdd,
        int256 rate,
        bool isCall,
        bool takerBuys
    ) external pure returns (uint256 px) {
        int256 lnm = F.lnWad(F.divWad(int256(strike), int256(spot)));
        uint256 m = lnm < 0 ? uint256(-lnm) : uint256(lnm);
        uint256 volQ = _mulWad(vol, WAD + _mulWad(skewSlope, m) + utilTerm) + sessionAdd;
        px = BlackScholes.price(spot, strike, tau, volQ, rate, isCall);
        if (takerBuys) return px;
        uint256 mark = BlackScholes.price(spot, strike, tau, vol, rate, isCall);
        if (mark < px) px = mark;
    }

    /// @notice |delta| of the option at `vol`.
    function absDelta(uint256 spot, uint256 strike, uint256 tau, uint256 vol, int256 rate, bool isCall)
        external
        pure
        returns (uint256)
    {
        (int256 delta,,,) = BlackScholes.greeks(spot, strike, tau, vol, rate, isCall);
        return delta < 0 ? uint256(-delta) : uint256(delta);
    }

    function _mulWad(uint256 a, uint256 b) private pure returns (uint256) {
        return a * b / WAD;
    }
}
