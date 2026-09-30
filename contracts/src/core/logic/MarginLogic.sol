// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {CHS, CHStorage, CHErrors, Deps} from "../ClearinghouseStorage.sol";
import {AccountState} from "../../interfaces/IClearinghouse.sol";
import {UnderlyingParams, GlobalParams} from "../../interfaces/IRiskParams.sol";
import {FixedPointMath as F} from "../../libraries/FixedPointMath.sol";
import {
    Position,
    Series,
    Session,
    KParams,
    KUnderlying,
    KPosition,
    KMarginOut,
    WAD,
    MAX_POSITIONS,
    MAX_UNDERLYINGS
} from "../../types/Types.sol";

/// @notice The margin procedure: turns an account (optionally with one hypothetical position
/// and cash change) into kernel input, runs the risk kernel and derives equity / IM / MM.
/// Read-only; linked into the Clearinghouse and run against its storage.
library MarginLogic {
    using SafeCast for uint256;

    uint256 private constant MAX_SHOCK_RANGE = 0.9e18;

    /// @dev A book is the account's positions (plus the what-if change) as parallel arrays.
    struct Book {
        uint32[] seriesIds;
        int256[] qtys;
    }

    /// @dev Kernel input plus what the procedure derives alongside it.
    struct Input {
        KParams p;
        KUnderlying[] us;
        KPosition[] ps;
        int256 settledValue;
        uint256 mmRatio;
    }

    function accountState(Deps memory d, uint256 id) external view returns (AccountState memory) {
        return _state(d, id, 0, 0, 0);
    }

    /// @notice accountState as if `qtyDelta` were added to `seriesId` (a virtual position if the
    /// account has none) and `cashDelta` to the cash. `seriesId` is ignored when `qtyDelta == 0`.
    /// Reverts InsufficientCash if the cash would go negative. Never writes storage.
    function accountStateWith(Deps memory d, uint256 id, uint32 seriesId, int256 qtyDelta, int256 cashDelta)
        external
        view
        returns (AccountState memory)
    {
        return _state(d, id, seriesId, qtyDelta, cashDelta);
    }

    /// @notice Correlated portfolio PnL per scenario (39 values) of the account's live risk.
    function scenarioGrid(Deps memory d, uint256 id) external view returns (int256[] memory) {
        Input memory inp = _input(d, id, _book(id, 0, 0));
        return d.kernel.scenarioGrid(inp.p, inp.us, inp.ps);
    }

    // ---------------------------------------------------------------- procedure

    function _state(Deps memory d, uint256 id, uint32 seriesId, int256 qtyDelta, int256 cashDelta)
        private
        view
        returns (AccountState memory st)
    {
        uint256 cash = CHS.cashOf(id);
        if (cashDelta < 0) {
            uint256 outflow = uint256(-cashDelta);
            if (outflow > cash) revert CHErrors.InsufficientCash(id, cash, outflow);
            cash -= outflow;
        } else {
            cash += uint256(cashDelta);
        }
        Book memory book = _book(id, seriesId, qtyDelta);
        st.cash = cash;
        st.deficit = CHS.s().accounts[id].deficitTotal;

        // Fast path: nothing but cash and collateral, nothing owed.
        if (book.seriesIds.length == 0 && st.deficit == 0) {
            st.mtm = _collateralValue(d, id);
            st.equity = cash.toInt256() + st.mtm;
            st.healthy = true;
            return st;
        }

        Input memory inp = _input(d, id, book);
        (KMarginOut memory out,) = d.kernel.margin(inp.p, inp.us, inp.ps);
        st.mtm = out.mtm;
        st.settledValue = inp.settledValue;
        st.equity = cash.toInt256() + out.mtm + inp.settledValue - st.deficit.toInt256();
        st.im = out.lossIM;
        st.mm = F.mulWadUp(out.lossIM, inp.mmRatio);
        st.worstScenario = out.worstScenario;
        st.healthy = st.equity >= st.im.toInt256();
        st.liquidatable = st.equity < st.mm.toInt256();
    }

    /// @dev Stored positions with the what-if change applied; zero quantities are dropped.
    function _book(uint256 id, uint32 seriesId, int256 qtyDelta) private view returns (Book memory b) {
        CHStorage storage $ = CHS.s();
        Position[] storage ps = $.positions[id];
        uint256 n = ps.length;
        uint256 slot1 = qtyDelta == 0 ? 0 : $.posIndex[id][seriesId];
        bool virtualNew = qtyDelta != 0 && slot1 == 0;
        uint256 cap = virtualNew ? n + 1 : n;
        if (cap > MAX_POSITIONS) revert CHErrors.TooManyPositions();

        b.seriesIds = new uint32[](cap);
        b.qtys = new int256[](cap);
        uint256 m;
        for (uint256 i = 0; i < n; ++i) {
            Position memory p = ps[i];
            int256 q = p.qty;
            if (i + 1 == slot1) q += qtyDelta;
            if (q == 0) continue;
            b.seriesIds[m] = p.seriesId;
            b.qtys[m] = q;
            ++m;
        }
        if (virtualNew) {
            b.seriesIds[m] = seriesId;
            b.qtys[m] = qtyDelta;
            ++m;
        }
        uint32[] memory sids = b.seriesIds;
        int256[] memory qtys = b.qtys;
        assembly ("memory-safe") {
            mstore(sids, m)
            mstore(qtys, m)
        }
    }

    /// @dev Steps 1-4 of the procedure. Underlyings: collateral tokens first, then option
    /// underlyings in first-seen order over the book, deduplicated, at most MAX_UNDERLYINGS.
    /// Positions whose series expired and whose (underlying, expiry) is settled in the registry
    /// leave the kernel: their payoff goes to settledValue, rounded against the account (and
    /// their underlying is not needed, so its oracle can't block the account).
    function _input(Deps memory d, uint256 id, Book memory book) private view returns (Input memory inp) {
        CHStorage storage $ = CHS.s();
        GlobalParams memory g = d.params.globals();
        inp.p = KParams({
            nowTs: block.timestamp,
            rate: int256(g.rate),
            diversificationCredit: g.diversificationCredit,
            shortOptionMinPct: g.shortOptionMinPct
        });
        inp.mmRatio = g.mmRatio;

        address[] memory us = new address[](MAX_UNDERLYINGS);
        uint256 nu;
        address[] storage toks = $.collateralTokens[id];
        for (uint256 i = 0; i < toks.length; ++i) {
            if (nu == MAX_UNDERLYINGS) revert CHErrors.TooManyUnderlyings();
            us[nu++] = toks[i];
        }

        uint256 n = book.seriesIds.length;
        inp.ps = new KPosition[](n);
        uint256 np;
        for (uint256 i = 0; i < n; ++i) {
            Series memory s = d.registry.series(book.seriesIds[i]);
            int256 qty = book.qtys[i];
            if (s.expiry <= block.timestamp) {
                (uint256 price, bool settled) = d.registry.settlementPriceOf(s.underlying, s.expiry);
                if (settled) {
                    inp.settledValue += _settledPayoff(s, price, qty);
                    continue;
                }
            }
            uint256 ui;
            while (ui < nu && us[ui] != s.underlying) ++ui;
            if (ui == nu) {
                if (nu == MAX_UNDERLYINGS) revert CHErrors.TooManyUnderlyings();
                us[nu++] = s.underlying;
            }
            inp.ps[np++] = KPosition({u: ui, isCall: s.isCall, expiry: s.expiry, strike: s.strike, qty: qty});
        }
        KPosition[] memory kps = inp.ps;
        assembly ("memory-safe") {
            mstore(kps, np)
        }

        inp.us = new KUnderlying[](nu);
        for (uint256 i = 0; i < nu; ++i) {
            inp.us[i] = _underlying(d, us[i], $.collateral[id][us[i]]);
        }
    }

    /// @dev Step 2: spot, mark vol and the session-scaled shock range of one underlying.
    ///   base = max(minShock, shockK * vol * sqrt(horizonDays / 365))
    ///   shockRange = min(0.9, base * sessionMult)
    function _underlying(Deps memory d, address u, uint256 tokenQty) private view returns (KUnderlying memory k) {
        (uint256 spot, Session sess,) = d.hub.spot(u);
        uint256 vol = d.hub.markVol(u);
        UnderlyingParams memory p = d.params.underlying(u);
        uint256 mult = sess == Session.REGULAR
            ? WAD
            : sess == Session.EXTENDED
                ? p.multExtended
                : sess == Session.WEEKEND ? p.multWeekend : sess == Session.HOLIDAY ? p.multHoliday : p.multHalted;
        uint256 base = _mulWad(p.shockK, _mulWad(vol, F.sqrtWad(uint256(p.horizonDays) * WAD / 365)));
        if (base < p.minShock) base = p.minShock;
        uint256 range = _mulWad(base, mult);
        if (range > MAX_SHOCK_RANGE) range = MAX_SHOCK_RANGE;
        k = KUnderlying({
            spot: spot, vol: vol, shockRange: range, volUp: p.volUp, volDown: p.volDown, tokenQty: tokenQty.toInt256()
        });
    }

    /// @dev Fast-path mtm: collateral at spot, truncated exactly like the kernel's token value.
    function _collateralValue(Deps memory d, uint256 id) private view returns (int256 mtm) {
        CHStorage storage $ = CHS.s();
        address[] storage toks = $.collateralTokens[id];
        for (uint256 i = 0; i < toks.length; ++i) {
            (uint256 spot,,) = d.hub.spot(toks[i]);
            mtm += F.mulWad($.collateral[id][toks[i]].toInt256(), spot.toInt256());
        }
    }

    /// @dev Long: +floor(qty * payoff); short: -ceil(|qty| * payoff).
    function _settledPayoff(Series memory s, uint256 price, int256 qty) private pure returns (int256) {
        uint256 k = s.strike;
        uint256 payoff = s.isCall ? (price > k ? price - k : 0) : (k > price ? k - price : 0);
        if (qty > 0) return (uint256(qty) * payoff / WAD).toInt256();
        return -F.mulWadUp(uint256(-qty), payoff).toInt256();
    }

    function _mulWad(uint256 a, uint256 b) private pure returns (uint256) {
        return a * b / WAD;
    }
}
