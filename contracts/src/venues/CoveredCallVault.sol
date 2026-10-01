// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IClearinghouse} from "../interfaces/IClearinghouse.sol";
import {ISeriesRegistry} from "../interfaces/ISeriesRegistry.sol";
import {IMarketDataHub} from "../interfaces/IMarketDataHub.sol";
import {IRiskParams} from "../interfaces/IRiskParams.sol";
import {OptionVaultBase, VaultConfig} from "./OptionVaultBase.sol";
import {Series, WAD} from "../types/Types.sol";

/// @notice Holds a stock token and sells out-of-the-money calls on it, never more calls than
/// tokens held (fully covered, although portfolio margin would allow more). Premiums arrive as
/// USDG cash in the account and count toward NAV at spot.
contract CoveredCallVault is OptionVaultBase {
    constructor(
        IERC20Metadata stockToken,
        IClearinghouse ch_,
        ISeriesRegistry registry_,
        IMarketDataHub hub_,
        IRiskParams params_,
        VaultConfig memory cfg
    )
        OptionVaultBase(
            stockToken,
            address(stockToken),
            ch_,
            registry_,
            hub_,
            params_,
            cfg,
            string.concat("Novation Covered Call ", stockToken.symbol()),
            string.concat("ncc", stockToken.symbol())
        )
    {}

    /// @dev Calls only, strike >= spot * (1 + minOtm). Cover (sum of |short calls| + qty <= tokens
    /// held) is checked by the base through _lockedFor and _backingWad.
    function _checkStrategy(Series memory s, uint256 spot) internal view override {
        if (!s.isCall) revert WrongOptionType();
        if (s.strike < _mulWad(spot, WAD + _cfg.minOtm)) revert StrikeNotOtm();
    }

    /// @dev One token per short call.
    function _lockedFor(uint32, uint256 absQty) internal pure override returns (uint256) {
        return absQty;
    }

    function _backingWad() internal view override returns (uint256) {
        return ch.collateralOf(vaultId, underlying);
    }

    /// @dev equity / spot in tokens, then to raw token units.
    function _equityToAssets(uint256 equityWad) internal view override returns (uint256) {
        (uint256 spot,,) = hub.spot(underlying);
        return equityWad * WAD / spot / _assetScale;
    }
}
