// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {CHS, CHStorage, CHErrors, Deps} from "../ClearinghouseStorage.sol";
import {MarginLogic} from "./MarginLogic.sol";
import {IClearinghouse, TradeParams, AgentPolicy, AccountState} from "../../interfaces/IClearinghouse.sol";
import {UnderlyingParams, GlobalParams} from "../../interfaces/IRiskParams.sol";
import {FixedPointMath as F} from "../../libraries/FixedPointMath.sol";
import {Series, Session, WAD} from "../../types/Types.sol";

/// @notice Venue trades: authorisation, opening rules, position and open-interest moves, premium
/// and fee, post-trade margin on both sides and agent risk budgets. Linked into the Clearinghouse
/// and run against its storage.
library TradeLogic {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /// @dev One side of a trade.
    struct Side {
        uint256 id;
        address actor;
        int256 delta; // position change
        bool agent; // acted for by an agent rather than the owner
        bool opening;
        bool restricted; // reducing side while opening is blocked for its account
        bool lastShortClosed; // bought back a short and left the account with no position at all
        int256 newQty; // position in the traded series after the trade
        int256 preEquity; // reducing and agent-acted sides only
        uint256 preIm; // reducing and agent-acted sides only
        uint256 feePaid;
        int256 equity; // post-trade
        uint256 im; // post-trade
    }

    /// @notice Executes `t` for a venue. Returns the fee charged to the taker (WAD USDG).
    function trade(Deps memory d, TradeParams calldata t) external returns (uint256 fee) {
        CHStorage storage $ = CHS.s();

        // 1. series and trade shape
        Series memory s = _series(d, t.seriesId);
        if (block.timestamp >= s.expiry) revert CHErrors.SeriesExpired();
        if (t.takerId == t.makerId) revert CHErrors.SelfTrade();
        GlobalParams memory g = d.params.globals();
        uint256 absQty = _abs(t.qty);
        if (absQty == 0) revert CHErrors.QtyTooSmall();

        // 2. who acts for each side, and what its position becomes. Below minTradeQty a trade may
        // only close a position out (one left below the minimum when governance raised it), so no
        // position is ever stuck; every resulting position is flat or at least the minimum.
        UnderlyingParams memory up = d.params.underlying(s.underlying);
        Side memory tk = _side($, t.takerId, t.takerActor, t.seriesId, t.qty, up.index);
        Side memory mk = _side($, t.makerId, t.makerActor, t.seriesId, -t.qty, up.index);
        if (absQty < g.minTradeQty && tk.newQty != 0 && mk.newQty != 0) revert CHErrors.QtyTooSmall();
        _noDust(tk, g.minTradeQty);
        _noDust(mk, g.minTradeQty);

        // 3. opening gates; while opening is blocked, reducing sides are held to §5.3 after the trade
        bool closedToOpening = !up.enabled || d.params.openingPaused() || d.hub.session(s.underlying) == Session.HALTED;
        _gate($, tk, up.enabled, closedToOpening);
        _gate($, mk, up.enabled, closedToOpening);

        // 4. pre-trade state of reducing and agent-acted sides
        _snapshot(d, tk);
        _snapshot(d, mk);

        // 5. positions and open interest
        uint256 oiBefore = $.longOI[t.seriesId];
        CHS.movePosition(tk.id, t.seriesId, tk.delta, s);
        CHS.movePosition(mk.id, t.seriesId, mk.delta, s);
        uint256 oiAfter = $.longOI[t.seriesId];
        if (oiAfter > oiBefore && oiAfter > up.maxOpenInterest) revert CHErrors.OpenInterestCap();

        // 6. premium and fee
        (uint256 spot,,) = d.hub.spot(s.underlying);
        fee = _min(F.mulWadUp(g.feeRate, _mulWad(absQty, spot)), F.mulWadUp(g.feeCapOfPremium, t.premium));
        if (t.qty > 0) {
            CHS.debit(tk.id, t.premium + fee);
            CHS.credit(mk.id, t.premium);
        } else {
            CHS.debit(mk.id, t.premium);
            CHS.credit(tk.id, t.premium);
            CHS.debit(tk.id, fee);
        }
        tk.feePaid = fee;

        // 7. post-trade margin on both sides
        _checkMargin(d, tk);
        _checkMargin(d, mk);

        // 8. agent risk budgets
        _checkBudget($, tk, t.premium);
        _checkBudget($, mk, t.premium);

        // 9. log it; the fee split goes out last (every check above has passed)
        emit IClearinghouse.Traded(t.takerId, t.makerId, t.seriesId, t.qty, t.premium, fee, t.takerActor, t.makerActor);
        _payFee(d, fee, g.insuranceShare);
    }

    // ---------------------------------------------------------------- steps

    /// @dev The registry reverts on an id it never issued; that leaves `s` empty -> UnknownSeries.
    function _series(Deps memory d, uint32 seriesId) private view returns (Series memory s) {
        try d.registry.series(seriesId) returns (Series memory got) {
            s = got;
        } catch {}
        if (s.underlying == address(0)) revert CHErrors.UnknownSeries();
    }

    /// @dev Authorises `actor` for `id` and classifies the side. The owner (never the zero address)
    /// acts freely; an agent needs a live policy that allows the series' underlying. A side opens
    /// when it grows |qty| or moves the position to the other side of zero (a flip is a close plus
    /// an open).
    function _side(CHStorage storage $, uint256 id, address actor, uint32 seriesId, int256 delta, uint8 uIndex)
        private
        view
        returns (Side memory x)
    {
        x.id = id;
        x.actor = actor;
        x.delta = delta;
        if (actor == address(0) || actor != $.accounts[id].owner) {
            AgentPolicy storage p = $.agents[id][actor];
            if (actor == address(0) || p.expiresAt <= block.timestamp) revert CHErrors.NotAuthorized(id, actor);
            if ((p.allowedMask >> uIndex) & 1 == 0) revert CHErrors.AgentUnderlyingNotAllowed();
            x.agent = true;
        }

        uint256 slot1 = $.posIndex[id][seriesId];
        int256 oldQty = slot1 == 0 ? int256(0) : int256($.positions[id][slot1 - 1].qty);
        int256 newQty = oldQty + delta;
        x.newQty = newQty;
        x.opening = newQty != 0 && (_abs(newQty) > _abs(oldQty) || (oldQty > 0) != (newQty > 0));
    }

    /// @dev The side's position must end flat or at least minTradeQty.
    function _noDust(Side memory x, uint256 minQty) private pure {
        if (x.newQty != 0 && _abs(x.newQty) < minQty) revert CHErrors.DustPosition(x.id, x.newQty);
    }

    /// @dev Opening is blocked on a disabled underlying, while paused or HALTED, and for an account
    /// in deficit. A reducing side in any of those states is marked `restricted`.
    function _gate(CHStorage storage $, Side memory x, bool enabled, bool closedToOpening) private view {
        bool blocked = closedToOpening || $.accounts[x.id].deficitTotal != 0;
        if (!x.opening) {
            x.restricted = blocked;
        } else if (!enabled) {
            revert CHErrors.UnderlyingDisabled();
        } else if (blocked) {
            revert CHErrors.OpeningNotAllowed(x.id);
        }
    }

    function _snapshot(Deps memory d, Side memory x) private view {
        if (x.opening && !x.agent) return;
        AccountState memory pre = MarginLogic.accountState(d, x.id);
        x.preEquity = pre.equity;
        x.preIm = pre.im;
    }

    /// @dev Post-trade margin of one side:
    ///  - a restricted (reducing, opening blocked) side may not raise the worst-case loss (§5.3);
    ///  - then equity >= IM, except that a reducing side may stay below IM when the trade is a pure
    ///    reduction: lossIM didn't rise and equity didn't fall (the fee aside, which goes to the
    ///    protocol, not the counterparty). An underwater account can cut risk at or below mark, but
    ///    can't strip a hedge or pay value away through an off-market price.
    /// A side that buys back a short and so leaves the account with no position at all is exempt
    /// from the lossIM comparisons: it removes the account's last option liability and sells no
    /// hedge, and what stays is collateral the account already held. It still needs equity >= IM
    /// or equity not falling (a buyback at or below mark). Without this, an account in deficit
    /// couldn't close its last covered call: the margin procedure then counts the remaining
    /// stock's downside as IM (with no deficit such an account takes the fast path, IM 0), more
    /// than the covered book's. Selling a last long (a protective put, say) gets no exemption.
    function _checkMargin(Deps memory d, Side memory x) private view {
        AccountState memory st = MarginLogic.accountState(d, x.id);
        x.equity = st.equity;
        x.im = st.im;
        x.lastShortClosed = x.delta > 0 && CHS.s().positions[x.id].length == 0;
        bool imOk = st.im <= x.preIm || x.lastShortClosed;
        if (x.restricted && !imOk) revert CHErrors.RiskIncreaseNotAllowed(x.id, st.im, x.preIm);
        if (st.equity >= st.im.toInt256()) return;
        if (!x.opening && imOk && st.equity + x.feePaid.toInt256() >= x.preEquity) return;
        revert CHErrors.InsufficientMargin(x.id, st.equity, st.im);
    }

    /// @dev Agent-acted sides:
    ///  - the account's worst-case loss (lossIM) must stay within maxWorstLoss; a reducing side that
    ///    doesn't raise lossIM, or buys back the account's last position (a short), passes
    ///    regardless, so an agent can always cut risk;
    ///  - premium <= maxPremiumPerTrade;
    ///  - the trade may cost the account at most maxPremiumPerTrade of equity against the kernel
    ///    mark (the fee aside), so an agent can't give positions away or overpay for them.
    function _checkBudget(CHStorage storage $, Side memory x, uint256 premium) private view {
        if (!x.agent) return;
        AgentPolicy storage p = $.agents[x.id][x.actor];
        uint256 budget = p.maxWorstLoss;
        if (x.im > budget && (x.opening || (x.im > x.preIm && !x.lastShortClosed))) {
            revert CHErrors.AgentRiskBudgetExceeded(x.id, x.im, budget);
        }
        uint256 cap = p.maxPremiumPerTrade;
        if (premium > cap) revert CHErrors.AgentPremiumExceeded();
        int256 loss = x.preEquity - (x.equity + x.feePaid.toInt256());
        if (loss > cap.toInt256()) revert CHErrors.AgentValueDrainExceeded(x.id, loss, cap);
    }

    /// @dev ins = fee * insuranceShare to the InsuranceFund, the rest to the treasury, each floored
    /// to token units. The sub-unit remainder stays in the clearinghouse.
    function _payFee(Deps memory d, uint256 fee, uint256 insuranceShare) private {
        if (fee == 0) return;
        uint256 ins = _mulWad(fee, insuranceShare);
        uint256 toInsurance = ins / d.usdgScale;
        uint256 toTreasury = (fee - ins) / d.usdgScale;
        IERC20 token = IERC20(d.usdg);
        if (toInsurance != 0) token.safeTransfer(address(d.insurance), toInsurance);
        if (toTreasury != 0) token.safeTransfer(d.params.treasury(), toTreasury);
    }

    // ---------------------------------------------------------------- math

    function _abs(int256 x) private pure returns (uint256) {
        return x >= 0 ? uint256(x) : uint256(-x);
    }

    function _mulWad(uint256 a, uint256 b) private pure returns (uint256) {
        return a * b / WAD;
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}
