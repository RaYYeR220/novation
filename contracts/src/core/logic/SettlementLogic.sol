// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {CHS, CHStorage, CHErrors, Deps, PriceOutage} from "../ClearinghouseStorage.sol";
import {MarginLogic} from "./MarginLogic.sol";
import {Payoff} from "./Payoff.sol";
import {IClearinghouse} from "../../interfaces/IClearinghouse.sol";
import {IAuctionHouse} from "../../interfaces/IAuctionHouse.sol";
import {Position, Series, WAD} from "../../types/Types.sol";

/// @notice Expiry settlement through one pool per expiry, and the default waterfall behind it.
/// Linked into the Clearinghouse and run against its storage.
///
/// Net payers pay into pool[E] from their cash; whatever they can't pay is bridged by the
/// InsuranceFund (defBridged, owed to the fund), and the rest is pending[E] (defPending, owed to
/// the pool) until a deficit sale, the account's own later cash or a socialization fills it.
/// Net receivers get a claim on pool[E], payable once no short of E is left unsettled and nothing
/// is pending. Longs round down and shorts round up, per position (Payoff), so the pool always
/// covers every claim and nobody is ever paid with someone else's cash.
///
/// An account's deficit (Account.deficitTotal) is the sum of its per-expiry parts plus its
/// socializedDebt: what it still owes after a socialization. A socialization takes the pool's
/// part out of everyone's cash, but the defaulter keeps owing it (and the fund's written-off
/// bridge) until its own cash repays the InsuranceFund. While anything is owed the account can't
/// withdraw or open positions, and the debt counts against its equity.
///
/// Solvency: USDG held >= floor(totalCashNorm * cashIndex / 1e18) + sum of pools. Every path
/// below moves value between cash, a pool and the InsuranceFund in the direction that keeps this
/// true.
library SettlementLogic {
    using SafeERC20 for IERC20;

    /// @notice An impaired pool paid `paidWad` for a claim of `claimWad`: the difference is the
    /// claimant's realized loss.
    event ClaimHaircut(uint256 indexed id, uint64 indexed expiry, uint256 claimWad, uint256 paidWad);

    /// @notice `token` was seen without a price at `since` with its feed at `round` (since 0: it
    /// has a price again and the record is cleared).
    event PriceOutageMarked(address indexed token, uint256 since, uint80 round);

    /// @notice Closes every position of `id` that expires at `expiry` and settles the net payoff
    /// through pool[expiry]. Permissionless; each (underlying, expiry) involved must be settled in
    /// the registry.
    function settleAccount(Deps memory d, uint256 id, uint64 expiry) external {
        CHStorage storage $ = CHS.s();

        // 1-2. positions of this expiry and their payoffs, rounded against the account
        Position[] storage ps = $.positions[id];
        uint256 n = ps.length;
        uint32[] memory sids = new uint32[](n);
        int256[] memory qtys = new int256[](n);
        Series[] memory series = new Series[](n);
        address[] memory us = new address[](n); // settlement prices seen so far, per underlying
        uint256[] memory prices = new uint256[](n);
        uint256 nu;
        uint256 m;
        int256 net;
        for (uint256 i = 0; i < n; ++i) {
            Position memory p = ps[i];
            Series memory s = d.registry.series(p.seriesId);
            if (s.expiry != expiry) continue;
            uint256 k;
            while (k < nu && us[k] != s.underlying) ++k;
            if (k == nu) {
                (uint256 price, bool settled) = d.registry.settlementPriceOf(s.underlying, expiry);
                if (!settled) revert CHErrors.ExpiryNotSettled();
                us[nu] = s.underlying;
                prices[nu++] = price;
            }
            net += Payoff.settled(s, prices[k], p.qty);
            sids[m] = p.seriesId;
            qtys[m] = p.qty;
            series[m++] = s;
        }
        if (m == 0) revert CHErrors.NothingToSettle();

        // 3. close them (keeps longOI and unsettledShortQty[expiry] in step)
        for (uint256 i = 0; i < m; ++i) {
            CHS.movePosition(id, sids[i], -qtys[i], series[i]);
        }

        // 4. net receiver: a claim on the pool
        if (net >= 0) {
            uint256 amt = uint256(net);
            $.claimable[id][expiry] += amt;
            $.totalClaimable[expiry] += amt;
            $.claimableTotal[id] += amt; // keeps counting in the account's equity until claimed
            emit IClearinghouse.AccountSettled(id, expiry, net, 0, 0, 0);
            return;
        }

        // 5. net payer: cash first, then the InsuranceFund, then pending
        uint256 debt = uint256(-net);
        uint256 cash = CHS.cashOf(id);
        uint256 paid = debt < cash ? debt : cash;
        CHS.debit(id, paid);
        $.pool[expiry] += paid;
        uint256 short = debt - paid;
        uint256 bridged;
        uint256 unfunded;
        if (short != 0) {
            // The fund pays whole USDG units: ask for the shortfall rounded up to one, so a
            // well-funded fund leaves nothing pending. The account owes the fund what it bridged.
            bridged = d.insurance.cover(_ceilToUnit(short, d.usdgScale));
            unfunded = bridged >= short ? 0 : short - bridged;
            if ($.defPending[id][expiry] + $.defBridged[id][expiry] == 0) $.deficitExpiries[id].push(expiry);
            $.pool[expiry] += bridged;
            $.pending[expiry] += unfunded;
            $.defBridged[id][expiry] += bridged;
            $.defPending[id][expiry] += unfunded;
            $.accounts[id].deficitTotal += bridged + unfunded;
        }

        // 6.
        emit IClearinghouse.AccountSettled(id, expiry, net, paid, bridged, unfunded);
        if (short != 0) IAuctionHouse(d.auctionHouse).startDeficitSale(id, expiry);
    }

    /// @notice Moves the claim of `id` on pool[expiry] into its cash. Only once every short of the
    /// expiry is settled and nothing is pending; a pool marked impaired pays pro rata (never more
    /// than the claim) and the shortfall is the claimant's realized loss (ClaimHaircut). Nothing
    /// to claim is a no-op.
    function claim(uint256 id, uint64 expiry) external {
        CHStorage storage $ = CHS.s();
        uint256 amt = $.claimable[id][expiry];
        if (amt == 0) return;
        if ($.unsettledShortQty[expiry] != 0 || $.pending[expiry] != 0) revert CHErrors.PoolNotReady();

        uint256 poolWad = $.pool[expiry];
        uint256 pay = amt;
        if ($.impaired[expiry]) {
            uint256 share = amt * poolWad / $.totalClaimable[expiry];
            if (share < pay) pay = share;
        } else if (poolWad < amt) {
            revert CHErrors.PoolShortfall();
        }

        // the claim leaves the account's equity at face; only `pay` comes back as cash, so an
        // impaired payout realizes the difference as a loss
        $.claimable[id][expiry] = 0;
        $.totalClaimable[expiry] -= amt;
        $.claimableTotal[id] -= amt;
        $.pool[expiry] = poolWad - pay;
        CHS.credit(id, pay);
        if (pay < amt) emit ClaimHaircut(id, expiry, amt, pay);
        emit IClearinghouse.Claimed(id, expiry, pay);
    }

    /// @notice Applies the cash of `id` (the bidder's payment has just been credited to it) to
    /// its `expiry` deficit: the pool's pending part first, then the InsuranceFund's bridge.
    function applyDeficitProceeds(Deps memory d, uint256 id, uint64 expiry) external {
        (, uint256 toFund) = _applyCash(d, id, expiry);
        _payFund(d, toFund, toFund);
    }

    /// @notice Spends the account's own cash on everything it owes, in order: the pools' pending
    /// parts (every expiry it owes on), then the InsuranceFund's bridges, then its residual
    /// socialized debt (to the fund too; the cash index never goes back up). Permissionless and
    /// equity-neutral: cash and debt fall by the same amount (up to a wei of debit rounding per
    /// step below index 1e18). The fund is paid in whole USDG units; the sub-unit rest stays as
    /// cash. Emits DeficitReduced per expiry, and with expiry 0 for the socialized debt.
    ///
    /// The expiries come from a per-account list (deficitExpiries) that holds only expiries with
    /// something still owed. It stays short: an account in deficit can't open positions, so new
    /// per-expiry deficits only come from positions it already held (a handful of listed weeks).
    function repayDeficit(Deps memory d, uint256 id) external {
        CHStorage storage $ = CHS.s();
        uint64[] storage xs = $.deficitExpiries[id];
        uint256 n = xs.length;
        uint256 unit = d.usdgScale;

        uint256[] memory toPool = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) {
            toPool[i] = _toPool($, id, xs[i]);
        }
        uint256[] memory toFund = new uint256[](n);
        uint256 recovered;
        for (uint256 i = 0; i < n; ++i) {
            toFund[i] = _toFund($, id, xs[i], unit);
            recovered += toFund[i];
        }
        uint256 social = _toSocial($, id, unit);

        for (uint256 i = 0; i < n; ++i) {
            if (toPool[i] + toFund[i] != 0) {
                emit IClearinghouse.DeficitReduced(id, xs[i], toPool[i], toFund[i]);
            }
        }
        if (social != 0) emit IClearinghouse.DeficitReduced(id, 0, 0, social);
        // drop the expiries now fully repaid; walking backwards, the entry swapped in from the end
        // has already been checked
        for (uint256 i = n; i > 0; --i) {
            uint64 e = xs[i - 1];
            if ($.defPending[id][e] == 0 && $.defBridged[id][e] == 0) {
                xs[i - 1] = xs[xs.length - 1];
                xs.pop();
            }
        }

        _payFund(d, recovered + social, recovered);
    }

    /// @notice Spreads the pending deficit of an emptied account over all cash through the cash
    /// index. Permissionless. The account must hold no positions, and no collateral worth more
    /// than globals.dustEquity at spot (dust stays on the account). While any of its collateral
    /// can't be priced, the call reverts with the hub's error: a socialization can't be undone, so
    /// it waits for a price that may show the collateral covers the debt (the deficit sale sells
    /// it then). The wait is bounded: a token marked without a price for 72 hours, its feed
    /// printing nothing new, counts as 0 (markUnpriced). Any cash that reached the account repays
    /// the deficit first.
    ///
    /// The defaulter is not let off: the socialized amount and the fund's bridge (written off in
    /// the fund's books) become its socializedDebt, still part of its deficit, rounded up to a
    /// whole USDG unit: the fund is repaid in whole units, so a sub-unit rest could never be repaid
    /// and would keep the account in deficit for good (the deficit total grows by that rounding,
    /// less than one unit, against the defaulter). It keeps blocking
    /// withdrawals and opening and is repaid to the fund from any cash the account gets later, a
    /// pending claim included (repayDeficit).
    ///
    /// If all the cash in the system can't cover the remainder, the index drops to 1 (not 0, so
    /// credit keeps working), whatever cash there was goes to the pool and the pool is marked
    /// impaired: its claims are then paid pro rata. After that first impairment the index stays
    /// pinned at 1 and cash can't be cut any further, so a later shortfall impairs only its own
    /// pool. LossSocialized reports what actually reached the pool.
    function socializeRemainder(Deps memory d, uint256 id, uint64 expiry) external {
        CHStorage storage $ = CHS.s();
        if ($.defPending[id][expiry] == 0) revert CHErrors.NothingToSocialize();
        if ($.positions[id].length != 0) revert CHErrors.AccountNotEmpty(id);
        if (
            $.collateralTokens[id].length != 0
                && MarginLogic.collateralValue(d, id) > int256(uint256(d.params.globals().dustEquity))
        ) revert CHErrors.AccountNotEmpty(id);

        (, uint256 toFund) = _applyCash(d, id, expiry);
        uint256 rem = $.defPending[id][expiry];
        if (rem == 0) {
            _payFund(d, toFund, toFund);
            return;
        }
        // rem != 0 means all of the account's cash went to the pool, so toFund == 0 here

        uint256 index = $.cashIndex;
        uint256 norm = $.totalCashNorm;
        uint256 totalCash = norm * index / WAD;
        uint256 newIndex = totalCash > rem ? index * (totalCash - rem) / totalCash : 0;
        if (newIndex == 0) newIndex = 1;
        // what the index change actually takes out of cash; >= rem unless the index bottomed out
        uint256 moved = totalCash - norm * newIndex / WAD;
        uint256 toPool = rem;
        if (moved < rem) {
            toPool = moved;
            $.impaired[expiry] = true;
        }

        // the expiry's books are cleared; the account keeps owing it all, in whole USDG units
        uint256 bridged = $.defBridged[id][expiry];
        uint256 owed = _ceilToUnit(rem + bridged, d.usdgScale);
        $.cashIndex = newIndex;
        $.pool[expiry] += toPool;
        $.pending[expiry] -= rem;
        $.defPending[id][expiry] = 0;
        $.defBridged[id][expiry] = 0;
        $.socializedDebt[id] += owed;
        $.accounts[id].deficitTotal += owed - rem - bridged;
        _untrack($, id, expiry);

        emit IClearinghouse.LossSocialized(expiry, toPool, newIndex);
        if (bridged != 0) d.insurance.notifyWrittenOff(bridged);
    }

    /// @notice Permissionless: records that `token` has no price now, with its feed's latest
    /// round. Once that record is MarginLogic.OUTAGE_WRITE_OFF (72 hours) old and the feed still
    /// shows the same round and no price, the socialization dust test counts the token as 0, so a
    /// feed that never comes back can't freeze an expiry's claims for good. A new round restarts
    /// the clock; a price clears the record. A call that changes nothing is a no-op.
    function markUnpriced(Deps memory d, address token) external {
        (bool priced, uint80 round) = MarginLogic.priceStatus(d, token);
        PriceOutage storage o = CHS.s().outages[token];
        if (priced) {
            if (o.since == 0) return;
            delete CHS.s().outages[token];
            emit PriceOutageMarked(token, 0, round);
            return;
        }
        if (o.since != 0 && o.round == round) return;
        o.since = uint64(block.timestamp);
        o.round = round;
        emit PriceOutageMarked(token, block.timestamp, round);
    }

    // ---------------------------------------------------------------- private

    /// @dev Cash of `id` to its `expiry` deficit: pending first, then the fund's bridge. Effects
    /// only; the caller pays the fund with _payFund.
    function _applyCash(Deps memory d, uint256 id, uint64 expiry) private returns (uint256 toPending, uint256 toFund) {
        CHStorage storage $ = CHS.s();
        toPending = _toPool($, id, expiry);
        toFund = _toFund($, id, expiry, d.usdgScale);
        if (toPending + toFund == 0) return (0, 0);
        emit IClearinghouse.DeficitReduced(id, expiry, toPending, toFund);
        if ($.defPending[id][expiry] == 0 && $.defBridged[id][expiry] == 0) _untrack($, id, expiry);
    }

    /// @dev Up to the account's cash to the pool's pending part of `expiry`.
    function _toPool(CHStorage storage $, uint256 id, uint64 expiry) private returns (uint256 amt) {
        uint256 owed = $.defPending[id][expiry];
        uint256 cash = CHS.cashOf(id);
        amt = cash < owed ? cash : owed;
        if (amt == 0) return 0;
        CHS.debit(id, amt);
        $.pool[expiry] += amt;
        $.pending[expiry] -= amt;
        $.defPending[id][expiry] = owed - amt;
        $.accounts[id].deficitTotal -= amt;
    }

    /// @dev Up to the account's cash, in whole USDG units, to the fund's bridge on `expiry`.
    function _toFund(CHStorage storage $, uint256 id, uint64 expiry, uint256 unit) private returns (uint256 amt) {
        uint256 owed = $.defBridged[id][expiry];
        uint256 cash = CHS.cashOf(id);
        amt = cash < owed ? cash : owed;
        amt -= amt % unit;
        if (amt == 0) return 0;
        CHS.debit(id, amt);
        $.defBridged[id][expiry] = owed - amt;
        $.accounts[id].deficitTotal -= amt;
    }

    /// @dev Up to the account's cash, in whole USDG units, to its residual socialized debt.
    function _toSocial(CHStorage storage $, uint256 id, uint256 unit) private returns (uint256 amt) {
        uint256 owed = $.socializedDebt[id];
        uint256 cash = CHS.cashOf(id);
        amt = cash < owed ? cash : owed;
        amt -= amt % unit;
        if (amt == 0) return 0;
        CHS.debit(id, amt);
        $.socializedDebt[id] = owed - amt;
        $.accounts[id].deficitTotal -= amt;
    }

    /// @dev Sends `amount` (whole units) to the InsuranceFund; `recovered` of it repays bridges
    /// the fund still carries as outstanding.
    function _payFund(Deps memory d, uint256 amount, uint256 recovered) private {
        if (amount == 0) return;
        IERC20(d.usdg).safeTransfer(address(d.insurance), amount / d.usdgScale);
        if (recovered != 0) d.insurance.notifyRecovered(recovered);
    }

    function _untrack(CHStorage storage $, uint256 id, uint64 expiry) private {
        uint64[] storage xs = $.deficitExpiries[id];
        uint256 n = xs.length;
        for (uint256 i = 0; i < n; ++i) {
            if (xs[i] == expiry) {
                xs[i] = xs[n - 1];
                xs.pop();
                return;
            }
        }
    }

    function _ceilToUnit(uint256 wad, uint256 unit) private pure returns (uint256) {
        uint256 r = wad % unit;
        return r == 0 ? wad : wad + (unit - r);
    }
}
