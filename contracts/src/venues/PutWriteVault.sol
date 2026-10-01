// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IClearinghouse} from "../interfaces/IClearinghouse.sol";
import {ISeriesRegistry} from "../interfaces/ISeriesRegistry.sol";
import {IMarketDataHub} from "../interfaces/IMarketDataHub.sol";
import {IRiskParams} from "../interfaces/IRiskParams.sol";
import {FixedPointMath as F} from "../libraries/FixedPointMath.sol";
import {OptionVaultBase, VaultConfig} from "./OptionVaultBase.sol";
import {Series, WAD} from "../types/Types.sol";

/// @notice Holds USDG and sells out-of-the-money puts on one underlying, cash-secured: the strike
/// notional of every short put is covered by cash in the account.
contract PutWriteVault is OptionVaultBase {
    constructor(
        IERC20Metadata usdg,
        address underlying_,
        IClearinghouse ch_,
        ISeriesRegistry registry_,
        IMarketDataHub hub_,
        IRiskParams params_,
        VaultConfig memory cfg
    )
        OptionVaultBase(
            usdg,
            underlying_,
            ch_,
            registry_,
            hub_,
            params_,
            cfg,
            string.concat("Novation Put Write ", IERC20Metadata(underlying_).symbol()),
            string.concat("npw", IERC20Metadata(underlying_).symbol())
        )
    {
        if (address(usdg) != params_.usdg()) revert BadConfig();
    }

    /// @dev Puts only, strike <= spot * (1 - minOtm). Cash security (sum of |short put| * K plus
    /// qty * K <= cash) is checked by the base through _lockedFor and _backingWad.
    function _checkStrategy(Series memory s, uint256 spot) internal view override {
        if (s.isCall) revert WrongOptionType();
        if (s.strike > _mulWad(spot, WAD - _cfg.minOtm)) revert StrikeNotOtm();
    }

    /// @dev Strike notional, rounded up.
    function _lockedFor(uint32 seriesId, uint256 absQty) internal view override returns (uint256) {
        return F.mulWadUp(absQty, registry.series(seriesId).strike);
    }

    function _backingWad() internal view override returns (uint256) {
        return ch.cashOf(vaultId);
    }

    function _equityToAssets(uint256 equityWad) internal view override returns (uint256) {
        return equityWad / _assetScale;
    }
}
