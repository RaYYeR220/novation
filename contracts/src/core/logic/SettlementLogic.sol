// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {CHS, CHStorage, CHErrors, Deps} from "../ClearinghouseStorage.sol";
import {IClearinghouse} from "../../interfaces/IClearinghouse.sol";
import {IAuctionHouse} from "../../interfaces/IAuctionHouse.sol";
import {FixedPointMath as F} from "../../libraries/FixedPointMath.sol";
import {Position, Series, WAD} from "../../types/Types.sol";

/// @notice Expiry settlement through one pool per expiry, and the default waterfall behind it.
/// Linked into the Clearinghouse and run against its storage.
///
/// Net payers pay into pool[E] from their cash; whatever they can't pay is bridged by the
/// InsuranceFund, and the rest is pending[E] until the deficit sale (or socialization) fills it.
/// Net receivers get a claim on pool[E], payable once no short of E is left unsettled and nothing
/// is pending. Longs round down and shorts round up, per position, so the pool always covers every
/// claim and nobody is ever paid with someone else's cash.
///
/// Solvency: USDG held >= floor(totalCashNorm * cashIndex / 1e18) + sum of pools. Every path
/// below moves value between cash and a pool in the direction that keeps this true.
library SettlementLogic {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /// @notice An impaired pool paid `paidWad` for a claim of `claimWad`: the difference is the
    /// claimant's realized loss.
    event ClaimHaircut(uint256 indexed id, uint64 indexed expiry, uint256 claimWad, uint256 paidWad);

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
            net += _payoff(s, prices[k], p.qty);
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
    function claim(Deps memory, uint256 id, uint64 expiry) external {
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
        (, uint256 toIns) = _applyCash(d, id, expiry);
        _repayInsurance(d, toIns);
    }

    /// @notice Spreads the pending deficit of an emptied account over all cash through the cash
    /// index. Permissionless. The account must hold no positions and no collateral; any cash that
    /// reached it repays the deficit first (so dust sent to it can't block this).
    /// If all the cash in the system can't cover it, the index drops to 1 (not 0, so credit keeps
    /// working), whatever cash there was goes to the pool and the pool is marked impaired: its
    /// claims are then paid pro rata. The InsuranceFund's bridge to this account is written off.
    function socializeRemainder(Deps memory d, uint256 id, uint64 expiry) external {
        CHStorage storage $ = CHS.s();
        if ($.defPending[id][expiry] == 0) revert CHErrors.NothingToSocialize();
        if ($.positions[id].length != 0 || $.collateralTokens[id].length != 0) {
            revert CHErrors.AccountNotEmpty(id);
        }

        (, uint256 toIns) = _applyCash(d, id, expiry);
        uint256 rem = $.defPending[id][expiry];
        if (rem == 0) {
            _repayInsurance(d, toIns);
            return;
        }
        // rem != 0 means all of the account's cash went to the pool, so toIns == 0 here

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

        uint256 bridged = $.defBridged[id][expiry];
        $.cashIndex = newIndex;
        $.pool[expiry] += toPool;
        $.pending[expiry] -= rem;
        $.defPending[id][expiry] = 0;
        $.defBridged[id][expiry] = 0;
        $.accounts[id].deficitTotal -= rem + bridged;

        emit IClearinghouse.LossSocialized(expiry, rem, newIndex);
        if (bridged != 0) d.insurance.notifyWrittenOff(bridged);
    }

    // ---------------------------------------------------------------- private

    /// @dev Cash of `id` to its `expiry` deficit: pending first, then the fund's bridge in whole
    /// USDG units (the sub-unit rest stays in the account). Effects only; the caller pays the
    /// fund with _repayInsurance.
    function _applyCash(Deps memory d, uint256 id, uint64 expiry) private returns (uint256 toPending, uint256 toIns) {
        CHStorage storage $ = CHS.s();
        uint256 cash = CHS.cashOf(id);
        uint256 owedPool = $.defPending[id][expiry];
        toPending = cash < owedPool ? cash : owedPool;
        if (toPending != 0) {
            CHS.debit(id, toPending);
            $.pool[expiry] += toPending;
            $.pending[expiry] -= toPending;
            $.defPending[id][expiry] = owedPool - toPending;
            cash = CHS.cashOf(id);
        }

        uint256 owedIns = $.defBridged[id][expiry];
        toIns = cash < owedIns ? cash : owedIns;
        toIns -= toIns % d.usdgScale;
        if (toIns != 0) {
            CHS.debit(id, toIns);
            $.defBridged[id][expiry] = owedIns - toIns;
        }

        if (toPending + toIns == 0) return (0, 0);
        $.accounts[id].deficitTotal -= toPending + toIns;
        emit IClearinghouse.DeficitReduced(id, expiry, toPending, toIns);
    }

    function _repayInsurance(Deps memory d, uint256 toIns) private {
        if (toIns == 0) return;
        IERC20(d.usdg).safeTransfer(address(d.insurance), toIns / d.usdgScale);
        d.insurance.notifyRecovered(toIns);
    }

    /// @dev Long: +floor(qty * payoff); short: -ceil(|qty| * payoff).
    function _payoff(Series memory s, uint256 price, int256 qty) private pure returns (int256) {
        uint256 k = s.strike;
        uint256 payoff = s.isCall ? (price > k ? price - k : 0) : (k > price ? k - price : 0);
        if (qty > 0) return (uint256(qty) * payoff / WAD).toInt256();
        return -F.mulWadUp(uint256(-qty), payoff).toInt256();
    }

    function _ceilToUnit(uint256 wad, uint256 unit) private pure returns (uint256) {
        uint256 r = wad % unit;
        return r == 0 ? wad : wad + (unit - r);
    }
}
