// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IClearinghouse} from "../interfaces/IClearinghouse.sol";
import {ISeriesRegistry} from "../interfaces/ISeriesRegistry.sol";
import {IMarketDataHub} from "../interfaces/IMarketDataHub.sol";
import {IRiskParams} from "../interfaces/IRiskParams.sol";
import {OptionVaultBase, VaultConfig} from "./OptionVaultBase.sol";
import {Series, Session, WAD} from "../types/Types.sol";

/// @notice Holds a stock token and sells out-of-the-money calls on it, never more calls than
/// tokens held (fully covered, although portfolio margin would allow more). Premiums arrive as
/// USDG cash in the account and count toward NAV at spot.
///
/// Exits are paid in kind: an exit of a fraction f of NAV takes f of the account's USDG cash in
/// USDG and the rest of its value in tokens (withdraw, redeem and the redemption queue alike;
/// the ERC-4626 `assets` amounts are the exit's value in tokens at spot, the Withdraw event and
/// redeemable() report the token part, CashLegPaid and redeemableCash() the USDG part). So cash per
/// share stays the same across exits: the stock doesn't drain to those who leave while the
/// premium cash piles up for those who stay, and the last holder gets the last of both.
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

    /// @dev With NAV `ta` and cash C (cashA in tokens at spot, rounded up), an exit worth `assets`
    /// is paid C * assets / ta in USDG (floored to units) and assets * (ta - cashA) / ta in tokens
    /// (floored): together never more than `assets` at spot, and the last holder's exit (assets =
    /// ta) takes no more tokens than the account holds. If cash is worth the whole NAV or more (a
    /// loss due on an expired short not settled yet), the exit is all USDG, at most its value.
    function _split(uint256 assets) internal view override returns (uint256 tokens, uint256 cash) {
        uint256 c = ch.cashOf(vaultId);
        uint256 ta = totalAssets();
        if (c == 0 || ta == 0) return (assets, 0);
        (uint256 spot,,) = hub.spot(underlying);
        uint256 px = spot * _assetScale; // WAD USD per raw token unit, times 1e18
        uint256 cashA = Math.mulDiv(c, WAD, px, Math.Rounding.Ceil);
        if (cashA < ta) {
            tokens = Math.mulDiv(assets, ta - cashA, ta);
            c = Math.mulDiv(c, assets, ta);
        } else {
            uint256 value = Math.mulDiv(assets, px, WAD);
            if (value < c) c = value;
        }
        cash = c / _usdgScale;
    }

    /// @dev equity / spot in tokens, then to raw token units; 0 while spot can't be read.
    function _equityToAssets(uint256 equityWad) internal view override returns (uint256) {
        try hub.spot(underlying) returns (uint256 spot, Session, bool) {
            return equityWad * WAD / spot / _assetScale;
        } catch {
            return 0;
        }
    }
}
