// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {CHS, CHStorage, CHErrors, Account, Deps} from "../ClearinghouseStorage.sol";
import {Position, Series, WAD} from "../../types/Types.sol";

/// @notice The ledger moves behind the auction house: liquidation takeovers, deficit-sale
/// payments, penalties and insurance payouts. Linked into the Clearinghouse and run against its
/// storage; the Clearinghouse only lets the bound auction house call them. No margin check here:
/// the auction house checks the bidder after the whole bid.
library AuctionHookLogic {
    using SafeERC20 for IERC20;

    /// @notice Moves the fraction `f` (WAD, 0 < f <= 1) of `fromId`'s book to `toId`:
    ///  - every position: trunc(qty * f), adjusted to whole lots so that no side is left with a
    ///    position below minTradeQty (see _lot); the receiver must not end up with one either;
    ///  - each collateral token: floor(amount * f);
    ///  - cash: floor(cashNorm * f) of index-scaled norm, so the cash index doesn't round it.
    /// Unpaid settlement claims and the deficit stay with `fromId`.
    /// Every position moves on every transfer (no window an owner could arrange its book around);
    /// at the 256-position cap a 50% transfer costs about 16.5M gas, see AuctionHouse.
    function transferFraction(Deps memory d, uint256 fromId, uint256 toId, uint256 f) external {
        if (fromId == toId) revert CHErrors.SelfTrade();
        if (f == 0 || f > WAD) revert CHErrors.InvalidFraction();
        CHStorage storage $ = CHS.s();
        uint256 minQty = d.params.globals().minTradeQty;

        // positions: copy first, movePosition reorders the array when a position closes
        Position[] memory ps = $.positions[fromId];
        for (uint256 i = 0; i < ps.length; ++i) {
            int256 q = ps[i].qty;
            int256 m = _lot(q, q * int256(f) / int256(WAD), minQty);
            if (m == 0) continue;
            uint32 sid = ps[i].seriesId;
            Series memory s = d.registry.series(sid);
            CHS.movePosition(fromId, sid, -m, s);
            (, int256 newQty) = CHS.movePosition(toId, sid, m, s);
            if (newQty != 0 && _abs(newQty) < minQty && _abs(q) >= minQty) {
                revert CHErrors.DustPosition(toId, newQty);
            }
        }

        // collateral: copy first, removeCollateral reorders the token list when one runs out
        address[] memory toks = $.collateralTokens[fromId];
        for (uint256 i = 0; i < toks.length; ++i) {
            uint256 amt = $.collateral[fromId][toks[i]] * f / WAD;
            CHS.removeCollateral(fromId, toks[i], amt);
            CHS.addCollateral(toId, toks[i], amt);
        }

        // cash
        Account storage from = $.accounts[fromId];
        uint256 n = from.cashNorm * f / WAD;
        from.cashNorm -= n;
        $.accounts[toId].cashNorm += n;
    }

    function transferCash(uint256 fromId, uint256 toId, uint256 wad) external {
        CHS.debit(fromId, wad);
        CHS.credit(toId, wad);
    }

    function transferCollateral(uint256 fromId, uint256 toId, address token, uint256 wad) external {
        CHS.removeCollateral(fromId, token, wad);
        CHS.addCollateral(toId, token, wad);
    }

    /// @notice Takes min(wad, cash) from `id` and sends it to the InsuranceFund in whole USDG units;
    /// the sub-unit rest stays in the clearinghouse.
    function chargePenalty(Deps memory d, uint256 id, uint256 wad) external {
        uint256 cash = CHS.cashOf(id);
        uint256 x = wad < cash ? wad : cash;
        if (x == 0) return;
        CHS.debit(id, x);
        uint256 units = x / d.usdgScale;
        if (units != 0) IERC20(d.usdg).safeTransfer(address(d.insurance), units);
    }

    /// @notice Asks the InsuranceFund for `wad`, writes off what it booked (a liquidation bonus is
    /// never recovered) and credits `toId` with what it actually covered: the smaller of what the
    /// fund reports and what arrived, so no cash is ever credited without USDG behind it.
    function insurancePay(Deps memory d, uint256 toId, uint256 wad) external returns (uint256 paid) {
        if (wad == 0) return 0;
        IERC20 token = IERC20(d.usdg);
        uint256 before = token.balanceOf(address(this));
        uint256 covered = d.insurance.cover(wad);
        uint256 arrived = (token.balanceOf(address(this)) - before) * d.usdgScale;
        if (covered != 0) d.insurance.notifyWrittenOff(covered);
        paid = covered < arrived ? covered : arrived;
        CHS.credit(toId, paid);
    }

    /// @notice The account's underlyings: every registered underlying it holds as collateral or
    /// has a position on (expired positions included until settleAccount closes them).
    function underlyingsOf(Deps memory d, uint256 id) external view returns (address[] memory us) {
        CHStorage storage $ = CHS.s();
        uint256 n = d.params.underlyingCount();
        us = new address[](n);
        uint256 k;
        for (uint256 i = 0; i < n; ++i) {
            address u = d.params.underlyingAt(uint8(i));
            if ($.positionsOn[id][u] != 0 || $.collateral[id][u] != 0) us[k++] = u;
        }
        assembly ("memory-safe") {
            mstore(us, k)
        }
    }

    /// @notice live: positions whose series hasn't expired; awaiting: expired positions whose
    /// (underlying, expiry) the registry hasn't settled yet (valued on spot until it does).
    function positionStatus(Deps memory d, uint256 id) external view returns (uint256 live, uint256 awaiting) {
        Position[] storage ps = CHS.s().positions[id];
        uint256 n = ps.length;
        for (uint256 i = 0; i < n; ++i) {
            Series memory s = d.registry.series(ps[i].seriesId);
            if (s.expiry > block.timestamp) {
                ++live;
            } else {
                (, bool settled) = d.registry.settlementPriceOf(s.underlying, s.expiry);
                if (!settled) ++awaiting;
            }
        }
    }

    /// @dev The lot that moves out of a position `q` when its fraction is trunc(q * f) = `m`:
    ///  - a position already below the minimum (only after minTradeQty is raised) moves whole;
    ///  - a part below the minimum is rounded up to the minimum;
    ///  - if what would stay behind is below the minimum, the whole position moves.
    /// So no sub-minimum lot is cut and the giving side never keeps a sub-minimum position; the
    /// lot only grows, by less than minTradeQty (or to the whole position). The auction house
    /// settles that difference at mark.
    function _lot(int256 q, int256 m, uint256 minQty) private pure returns (int256) {
        if (_abs(q) < minQty) return q;
        if (m != 0 && _abs(m) < minQty) m = q > 0 ? int256(minQty) : -int256(minQty);
        int256 rest = q - m;
        if (rest != 0 && _abs(rest) < minQty) return q;
        return m;
    }

    function _abs(int256 x) private pure returns (uint256) {
        return x >= 0 ? uint256(x) : uint256(-x);
    }
}
