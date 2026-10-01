// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {FixedPointMath as F} from "../../libraries/FixedPointMath.sol";
import {Series, WAD} from "../../types/Types.sol";

/// @notice The settlement value of a position, shared by the margin procedure (expired positions
/// not yet settled into the pool) and by expiry settlement itself, so the two can never disagree.
library Payoff {
    using SafeCast for uint256;

    /// @notice `qty` contracts of `s` at settlement price `price`, rounded against the holder:
    /// a long gets +floor(qty * payoff), a short owes -ceil(|qty| * payoff).
    function settled(Series memory s, uint256 price, int256 qty) internal pure returns (int256) {
        uint256 k = s.strike;
        uint256 payoff = s.isCall ? (price > k ? price - k : 0) : (k > price ? k - price : 0);
        if (qty > 0) return (uint256(qty) * payoff / WAD).toInt256();
        return -F.mulWadUp(uint256(-qty), payoff).toInt256();
    }
}
