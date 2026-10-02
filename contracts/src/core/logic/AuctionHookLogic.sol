// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {CHS, CHStorage, CHErrors, Account, Deps} from "../ClearinghouseStorage.sol";
import {IClearinghouse} from "../../interfaces/IClearinghouse.sol";
import {Series, WAD, MAX_CLAIM_EXPIRIES} from "../../types/Types.sol";

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
    ///  - each unpaid settlement claim: one its pool can pay now (as claim would, pool not
    ///    impaired) is paid into the account's cash first and moves as cash; any other moves
    ///    floor(claim * f), so the receiver holds its share of what the account is owed along with
    ///    its share of the book (a bid is priced on equity, and equity counts unpaid claims at
    ///    face; a claim left behind would let a bid take liabilities the claims cover while the
    ///    InsuranceFund pays the bidder for them). Paying a claim at face leaves equity unchanged
    ///    (an impaired pool's would not, so those move). Both accounts must hold claims on at most
    ///    MAX_CLAIM_EXPIRIES expiries (TooManyClaimExpiries: anyone can claim the ready ones first);
    ///  - cash: floor(cashNorm * f) of index-scaled norm, so the cash index doesn't round it.
    /// The deficit stays with `fromId`.
    /// Every position moves on every transfer (no window an owner could arrange its book around);
    /// at the 256-position cap a 50% transfer into an empty account costs about 11.8M gas, see
    /// AuctionHouse.
    function transferFraction(Deps memory d, uint256 fromId, uint256 toId, uint256 f) external {
        if (fromId == toId) revert CHErrors.SelfTrade();
        if (f == 0 || f > WAD) revert CHErrors.InvalidFraction();
        CHStorage storage $ = CHS.s();
        uint256 minQty = d.params.globals().minTradeQty;

        // positions: copy the list first, movePosition reorders it when a position closes
        uint32[] memory sids = $.positionSeries[fromId];
        mapping(uint32 => uint256) storage pos = $.position[fromId];
        for (uint256 i = 0; i < sids.length; ++i) {
            uint32 sid = sids[i];
            int256 q = CHS.qtyIn(pos[sid]);
            int256 m = _lot(q, q * int256(f) / int256(WAD), minQty);
            if (m == 0) continue;
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

        // unpaid claims, before the cash: copy first, a claim that is paid or moves whole leaves
        // the list
        uint64[] memory es = $.claimExpiries[fromId];
        if (es.length > MAX_CLAIM_EXPIRIES) revert CHErrors.TooManyClaimExpiries(fromId);
        for (uint256 i = 0; i < es.length; ++i) {
            uint64 e = es[i];
            uint256 c = $.claimable[fromId][e];
            if ($.unsettledShortQty[e] == 0 && $.pending[e] == 0 && !$.impaired[e] && $.pool[e] >= c) {
                CHS.payClaim(fromId, e, c, c);
                emit IClearinghouse.Claimed(fromId, e, c);
                continue;
            }
            uint256 m = c * f / WAD;
            if (m == 0) continue;
            $.claimable[fromId][e] = c - m;
            if (c == m) CHS.dropExpiry($.claimExpiries[fromId], e);
            uint256 t = $.claimable[toId][e];
            if (t == 0) {
                $.claimExpiries[toId].push(e);
                if ($.claimExpiries[toId].length > MAX_CLAIM_EXPIRIES) revert CHErrors.TooManyClaimExpiries(toId);
            }
            $.claimable[toId][e] = t + m;
            $.claimableTotal[fromId] -= m;
            $.claimableTotal[toId] += m;
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

    /// @notice live: positions whose series hasn't expired; awaiting: expired positions whose
    /// (underlying, expiry) the registry hasn't settled yet (valued on spot until it does).
    function positionStatus(Deps memory d, uint256 id) external view returns (uint256 live, uint256 awaiting) {
        uint32[] memory sids = CHS.s().positionSeries[id];
        for (uint256 i = 0; i < sids.length; ++i) {
            Series memory s = d.registry.series(sids[i]);
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
