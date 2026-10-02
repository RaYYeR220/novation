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
/// USDG and the rest of its value in tokens (withdraw, redeem and the redemption queue alike). So
/// cash per share stays the same across exits: the stock doesn't drain to those who leave while
/// the premium cash piles up for those who stay, and the last holder gets the last of both.
///
/// ERC-4626 amounts on the way out are tokens that actually move: previewRedeem, redeem's return
/// value, maxWithdraw, withdraw's `assets` and the Withdraw event are the token part, and the
/// USDG part comes on top (CashLegPaid). An integrator that only handles the asset never credits
/// more tokens than it received; to see and bound both parts use previewRedeemInKind and
/// redeemInKind. Deposits, convertToAssets and totalAssets stay in value (NAV in tokens at spot),
/// so previewRedeem is below convertToAssets by the USDG part, like a withdrawal fee paid back in
/// USDG.
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
        (uint256 c, uint256 ta, uint256 px, uint256 cashA) = _cashParts();
        if (c == 0 || ta == 0) return (assets, 0);
        if (cashA < ta) {
            tokens = Math.mulDiv(assets, ta - cashA, ta);
            c = Math.mulDiv(c, assets, ta);
        } else {
            uint256 value = Math.mulDiv(assets, px, WAD);
            if (value < c) c = value;
        }
        cash = c / _usdgScale;
    }

    /// @dev The exit value whose token part is at least `tokens`: tokens * ta / (ta - cashA), rounded
    /// up. With cash worth the whole NAV no exit has a token part (the value overflows: withdraw of
    /// any tokens then reverts, and maxWithdraw is 0).
    function _grossUp(uint256 tokens) internal view override returns (uint256) {
        (uint256 c, uint256 ta,, uint256 cashA) = _cashParts();
        if (c == 0 || ta == 0 || tokens == 0) return tokens;
        if (cashA >= ta) return type(uint256).max;
        return Math.mulDiv(tokens, ta, ta - cashA, Math.Rounding.Ceil);
    }

    /// @dev The account's cash C (WAD), NAV ta (tokens), the token price px (WAD USD per raw unit,
    /// times 1e18) and C in tokens at spot, rounded up. px and cashA are 0 when C or ta is.
    function _cashParts() private view returns (uint256 c, uint256 ta, uint256 px, uint256 cashA) {
        c = ch.cashOf(vaultId);
        ta = totalAssets();
        if (c == 0 || ta == 0) return (c, ta, 0, 0);
        (uint256 spot,,) = hub.spot(underlying);
        px = spot * _assetScale;
        cashA = Math.mulDiv(c, WAD, px, Math.Rounding.Ceil);
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
