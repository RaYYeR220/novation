// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {CHS, CHStorage, CHErrors, Deps, PriceOutage} from "../ClearinghouseStorage.sol";
import {IAggregatorV3} from "../../interfaces/IAggregatorV3.sol";
import {MarketDataHub} from "../MarketDataHub.sol";
import {Payoff} from "./Payoff.sol";
import {AccountState} from "../../interfaces/IClearinghouse.sol";
import {UnderlyingParams, GlobalParams} from "../../interfaces/IRiskParams.sol";
import {FixedPointMath as F} from "../../libraries/FixedPointMath.sol";
import {NyseCalendar} from "../../libraries/NyseCalendar.sol";
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
///
/// Unpriceable underlyings. When the hub can't price an underlying (spot reverts NoPrice or
/// ImplausiblePrice):
///  - collateral-only (no live option position on it): the collateral is valued at 0 and the
///    underlying is left out of the kernel input, so a broken feed on a token someone parked in
///    the account can neither freeze withdrawals nor hide the account from liquidation;
///  - with a live option position on it: the procedure reverts with the hub's error. The
///    options can't be valued without a price, so the account (its withdrawals, margin checks
///    and liquidation) waits for the feed to recover. This is a known limit: opening a position
///    needs a price, but a feed can break while positions are open.
/// Any other failure of the price call (including empty revert data, e.g. out of gas) always
/// reverts, so a caller can't starve the call to make collateral disappear.
///
/// Settled value. Expired positions whose (underlying, expiry) the registry has settled are worth
/// their payoff, rounded against the account. Once settleAccount turns a net payoff into a claim
/// on the expiry pool, the unpaid claim (claimableTotal, at face) takes its place, so settling an
/// account (anyone may) never moves its equity; claim then moves the value into cash. A claim on
/// an impaired pool is still carried at face: impairment needs every unit of cash in the system
/// to be wiped out first, the pro-rata payout is only known per expiry, and the claim (also
/// permissionless) realizes the haircut.
library MarginLogic {
    using SafeCast for uint256;

    uint256 private constant MAX_SHOCK_RANGE = 0.9e18;
    /// @notice How long a collateral token must have been seen without a price, its feed printing
    /// no new round meanwhile, before the socialization dust test counts it as 0: 72 hours of
    /// market time (the NYSE 24/5 window, as the auction clock counts it). Closed hours don't
    /// count: a feed prints nothing over a weekend or holiday and a token is routinely HALTED at
    /// the reopen until its first print, so a mark taken before a long closure must not complete
    /// across it.
    uint256 internal constant OUTAGE_WRITE_OFF = 72 hours;
    /// @notice A feed that can't be read at all has no round to tell one outage from the next, so
    /// its outage counts as continuous only while markUnpriced sees it at least this often.
    uint256 internal constant OUTAGE_OBSERVE = 1 days;

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
        uint256 live; // positions whose series hasn't expired
        uint256 awaiting; // expired positions whose (underlying, expiry) the registry hasn't settled
        address volBehind; // checked runs only: a priced underlying whose vol isn't current
    }

    function accountState(Deps memory d, uint256 id) external view returns (AccountState memory st) {
        (st,,,) = _state(d, id, 0, 0, 0, false);
    }

    /// @notice accountState that also names an underlying the margin prices whose vol estimate
    /// hasn't folded the feed's latest round (address(0) if there is none). For the checks that let
    /// an account take something out on its margin (a withdrawal, a trade's equity >= IM, a
    /// bidder's health), run after syncing the account's underlyings (CHS.syncVols): an estimate
    /// that is still behind, say the first print after a weekend gap not folded in, must not price
    /// them, so the caller refuses or takes the stricter path.
    function accountStateChecked(Deps memory d, uint256 id)
        external
        view
        returns (AccountState memory st, address volBehind)
    {
        (st,,, volBehind) = _state(d, id, 0, 0, 0, true);
    }

    /// @notice accountState plus, from the same pass over the book, the positions that are live
    /// (series not expired) and the expired ones whose (underlying, expiry) the registry hasn't
    /// settled yet (valued on spot until it does). What a liquidation checks.
    function liquidationState(Deps memory d, uint256 id)
        external
        view
        returns (AccountState memory st, uint256 live, uint256 awaiting)
    {
        (st, live, awaiting,) = _state(d, id, 0, 0, 0, false);
    }

    /// @notice accountState as if `qtyDelta` were added to `seriesId` (a virtual position if the
    /// account has none) and `cashDelta` to the cash. `seriesId` is ignored when `qtyDelta == 0`.
    /// Reverts InsufficientCash if the cash would go negative. Never writes storage.
    function accountStateWith(Deps memory d, uint256 id, uint32 seriesId, int256 qtyDelta, int256 cashDelta)
        external
        view
        returns (AccountState memory st)
    {
        (st,,,) = _state(d, id, seriesId, qtyDelta, cashDelta, false);
    }

    /// @notice The account's collateral at spot, for the socialization dust test. Unlike the margin
    /// procedure, a token the hub can't price doesn't count as 0 here: the call reverts with the
    /// hub's NoPrice / ImplausiblePrice. A socialization can't be undone (the cash index never
    /// rises), so it waits for the price rather than write off a loss that collateral the account
    /// still holds might cover. It waits a bounded time, though: once the token has been marked
    /// without a usable price (markUnpriced: no price, or HALTED, e.g. a feed that stopped
    /// printing) for OUTAGE_WRITE_OFF and its feed has printed no round since, a feed that may
    /// never come back, it counts as 0 while it still has no usable price. An unreadable feed has
    /// no round to compare, so its mark must also have been seen within OUTAGE_OBSERVE.
    function collateralValue(Deps memory d, uint256 id) external view returns (int256 mtm) {
        CHStorage storage $ = CHS.s();
        address[] storage toks = $.collateralTokens[id];
        for (uint256 i = 0; i < toks.length; ++i) {
            address t = toks[i];
            PriceOutage memory o = $.outages[t];
            uint80 round = _feedRound(d, t);
            bool writtenOff = o.since != 0 && o.round == round
                && (round != 0 || block.timestamp <= o.seen + OUTAGE_OBSERVE)
                && NyseCalendar.tradableSeconds(o.since, block.timestamp, OUTAGE_WRITE_OFF) >= OUTAGE_WRITE_OFF;
            (bool priced, uint256 spot, Session s) = _spot(d, t, writtenOff);
            if (priced && !(writtenOff && s == Session.HALTED)) {
                mtm += F.mulWad($.collateral[id][t].toInt256(), spot.toInt256());
            }
        }
    }

    /// @notice Whether the hub gives `token` a usable price now: priced (only its NoPrice /
    /// ImplausiblePrice count as no price; any other failure reverts) and not HALTED. Also its
    /// feed's latest round id (0 if unreadable).
    function priceStatus(Deps memory d, address token) external view returns (bool usable, uint80 round) {
        (bool priced,, Session s) = _spot(d, token, true);
        usable = priced && s != Session.HALTED;
        round = _feedRound(d, token);
    }

    /// @notice Correlated portfolio PnL per scenario (39 values) of the account's live risk.
    function scenarioGrid(Deps memory d, uint256 id) external view returns (int256[] memory) {
        Input memory inp = _input(d, id, _book(id, 0, 0), false);
        return d.kernel.scenarioGrid(inp.p, inp.us, inp.ps);
    }

    // ---------------------------------------------------------------- procedure

    function _state(Deps memory d, uint256 id, uint32 seriesId, int256 qtyDelta, int256 cashDelta, bool checkVol)
        private
        view
        returns (AccountState memory st, uint256 live, uint256 awaiting, address volBehind)
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
        int256 claims = CHS.s().claimableTotal[id].toInt256();

        // Fast path: nothing but cash, collateral and claims, nothing owed.
        if (book.seriesIds.length == 0 && st.deficit == 0) {
            st.mtm = _collateralValue(d, id);
            st.settledValue = claims;
            st.equity = cash.toInt256() + st.mtm + claims;
            st.healthy = true;
            return (st, 0, 0, address(0));
        }

        Input memory inp = _input(d, id, book, checkVol);
        (KMarginOut memory out,) = d.kernel.margin(inp.p, inp.us, inp.ps);
        st.mtm = out.mtm;
        st.settledValue = inp.settledValue + claims;
        st.equity = cash.toInt256() + out.mtm + st.settledValue - st.deficit.toInt256();
        st.im = out.lossIM;
        st.mm = F.mulWadUp(out.lossIM, inp.mmRatio);
        st.worstScenario = out.worstScenario;
        st.healthy = st.equity >= st.im.toInt256();
        st.liquidatable = st.equity < st.mm.toInt256();
        live = inp.live;
        awaiting = inp.awaiting;
        volBehind = inp.volBehind;
    }

    /// @dev Stored positions with the what-if change applied; zero quantities are dropped.
    function _book(uint256 id, uint32 seriesId, int256 qtyDelta) private view returns (Book memory b) {
        CHStorage storage $ = CHS.s();
        uint32[] memory sids = $.positionSeries[id];
        mapping(uint32 => uint256) storage pos = $.position[id];
        uint256 n = sids.length;
        bool virtualNew = qtyDelta != 0 && pos[seriesId] == 0;
        uint256 cap = virtualNew ? n + 1 : n;
        if (cap > MAX_POSITIONS) revert CHErrors.TooManyPositions();

        b.seriesIds = new uint32[](cap);
        b.qtys = new int256[](cap);
        uint256 m;
        for (uint256 i = 0; i < n; ++i) {
            uint32 sid = sids[i];
            int256 q = CHS.qtyIn(pos[sid]);
            if (sid == seriesId) q += qtyDelta;
            if (q == 0) continue;
            b.seriesIds[m] = sid;
            b.qtys[m] = q;
            ++m;
        }
        if (virtualNew) {
            b.seriesIds[m] = seriesId;
            b.qtys[m] = qtyDelta;
            ++m;
        }
        uint32[] memory ids = b.seriesIds;
        int256[] memory qtys = b.qtys;
        assembly ("memory-safe") {
            mstore(ids, m)
            mstore(qtys, m)
        }
    }

    /// @dev Steps 1-4 of the procedure. Underlyings: collateral tokens first, then option
    /// underlyings in first-seen order over the book, deduplicated, at most MAX_UNDERLYINGS.
    /// Positions whose series expired and whose (underlying, expiry) is settled in the registry
    /// leave the kernel: their payoff goes to settledValue, rounded against the account (and
    /// their underlying is not needed, so its oracle can't block the account). Collateral-only
    /// underlyings the hub can't price are dropped (see the library notes); the kept ones keep
    /// their relative order and the position indices are remapped onto them.
    function _input(Deps memory d, uint256 id, Book memory book, bool checkVol)
        private
        view
        returns (Input memory inp)
    {
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
        bool[] memory hasPosition = new bool[](MAX_UNDERLYINGS);
        uint256 nu;
        address[] storage toks = $.collateralTokens[id];
        for (uint256 i = 0; i < toks.length; ++i) {
            if (nu == MAX_UNDERLYINGS) revert CHErrors.TooManyUnderlyings();
            us[nu++] = toks[i];
        }

        uint256 n = book.seriesIds.length;
        KPosition[] memory kps = new KPosition[](n);
        uint256 np;
        for (uint256 i = 0; i < n; ++i) {
            Series memory s = d.registry.series(book.seriesIds[i]);
            int256 qty = book.qtys[i];
            if (s.expiry <= block.timestamp) {
                (uint256 price, bool settled) = d.registry.settlementPriceOf(s.underlying, s.expiry);
                if (settled) {
                    inp.settledValue += Payoff.settled(s, price, qty);
                    continue;
                }
                ++inp.awaiting;
            } else {
                ++inp.live;
            }
            uint256 ui;
            while (ui < nu && us[ui] != s.underlying) ++ui;
            if (ui == nu) {
                if (nu == MAX_UNDERLYINGS) revert CHErrors.TooManyUnderlyings();
                us[nu++] = s.underlying;
            }
            hasPosition[ui] = true;
            kps[np++] = KPosition({u: ui, isCall: s.isCall, expiry: s.expiry, strike: s.strike, qty: qty});
        }
        assembly ("memory-safe") {
            mstore(kps, np)
        }

        KUnderlying[] memory kus = new KUnderlying[](nu);
        uint256[] memory newIndex = new uint256[](nu);
        uint256 kept;
        for (uint256 i = 0; i < nu; ++i) {
            (bool priced, KUnderlying memory k) = _underlying(d, us[i], $.collateral[id][us[i]], hasPosition[i]);
            if (!priced) continue;
            if (checkVol && inp.volBehind == address(0) && !d.hub.volCurrent(us[i])) inp.volBehind = us[i];
            newIndex[i] = kept;
            kus[kept++] = k;
        }
        if (kept != nu) {
            assembly ("memory-safe") {
                mstore(kus, kept)
            }
            for (uint256 i = 0; i < np; ++i) {
                kps[i].u = newIndex[kps[i].u];
            }
        }
        inp.us = kus;
        inp.ps = kps;
    }

    /// @dev Step 2: spot, mark vol and the session-scaled shock range of one underlying.
    ///   base = max(minShock, shockK * vol * sqrt(horizonDays / 365))
    ///   shockRange = min(0.9, base * sessionMult)
    /// `priced` is false only for a collateral-only underlying the hub can't price.
    function _underlying(Deps memory d, address u, uint256 tokenQty, bool hasPosition)
        private
        view
        returns (bool priced, KUnderlying memory k)
    {
        uint256 spot;
        Session sess;
        (priced, spot, sess) = _spot(d, u, !hasPosition);
        if (!priced) return (false, k);
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

    /// @dev Fast-path mtm: collateral at spot, truncated exactly like the kernel's token value;
    /// collateral the hub can't price counts as 0.
    function _collateralValue(Deps memory d, uint256 id) private view returns (int256 mtm) {
        CHStorage storage $ = CHS.s();
        address[] storage toks = $.collateralTokens[id];
        for (uint256 i = 0; i < toks.length; ++i) {
            (bool priced, uint256 spot,) = _spot(d, toks[i], true);
            if (priced) mtm += F.mulWad($.collateral[id][toks[i]].toInt256(), spot.toInt256());
        }
    }

    /// @dev The feed's latest round id, read raw: 0 if the call fails or the word isn't a uint80.
    function _feedRound(Deps memory d, address token) private view returns (uint80 id) {
        (bool ok, bytes memory r) =
            d.params.underlying(token).feed.staticcall(abi.encodeWithSelector(IAggregatorV3.latestRoundData.selector));
        if (ok && r.length >= 160 && uint256(bytes32(r)) <= type(uint80).max) id = uint80(uint256(bytes32(r)));
    }

    /// @dev hub.spot. With `mayDrop`, the hub's NoPrice / ImplausiblePrice come back as
    /// priced == false; every other failure (and any failure without `mayDrop`) is re-raised
    /// with its original revert data.
    function _spot(Deps memory d, address u, bool mayDrop)
        private
        view
        returns (bool priced, uint256 spot, Session sess)
    {
        try d.hub.spot(u) returns (uint256 price, Session s, bool) {
            return (true, price, s);
        } catch (bytes memory reason) {
            if (mayDrop && reason.length == 4) {
                bytes4 sel = bytes4(reason);
                if (sel == MarketDataHub.NoPrice.selector || sel == MarketDataHub.ImplausiblePrice.selector) {
                    return (false, 0, Session.HALTED);
                }
            }
            assembly ("memory-safe") {
                revert(add(reason, 0x20), mload(reason))
            }
        }
    }

    function _mulWad(uint256 a, uint256 b) private pure returns (uint256) {
        return a * b / WAD;
    }
}
