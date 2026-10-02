// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {VaultFixture} from "./VaultFixture.sol";
import {CHErrors} from "../../src/core/ClearinghouseStorage.sol";
import {OptionVaultBase} from "../../src/venues/OptionVaultBase.sol";
import {PutWriteVault} from "../../src/venues/PutWriteVault.sol";
import {CoveredCallVault} from "../../src/venues/CoveredCallVault.sol";
import {NyseCalendar} from "../../src/libraries/NyseCalendar.sol";

/// @notice Closed round trips against a vault must never pay the taker out of depositors' NAV:
/// not across series, not through a deposit that lifts the backing for the buy and leaves before
/// the buyback, and not across a session change.
contract VaultDrainTest is VaultFixture {
    function _buyAs(OptionVaultBase v, uint32 sid, uint256 qty) internal returns (uint256 p) {
        vm.prank(taker);
        p = v.buy(sid, qty, type(uint256).max, takerId);
    }

    function _sellAs(OptionVaultBase v, uint32 sid, uint256 qty) internal returns (uint256 p) {
        vm.prank(taker);
        p = v.sellBack(sid, qty, 0, takerId);
    }

    /// @dev Buy a high-vega series at low utilization, fill the vault with a cheap one (utilization
    /// jumps), then sell both back. The original near-worthless filler is now outside the offer
    /// band, so the cheapest series the vault still sells stands in.
    function test_crossSeriesRoundTripLosesPutWrite() public {
        PutWriteVault v = _newPutWrite(_config());
        uint32 a = _list(address(nvda), e2, 170e18, false);
        uint32 b = _list(address(nvda), e, 155e18, false);
        _vaultDeposit(v, alice, 2000 * USDG);
        uint256 nav0 = v.totalAssets();
        uint256 cash0 = ch.cashOf(takerId);

        uint32 worthless = _list(address(nvda), e, 95e18, false);
        vm.prank(taker);
        vm.expectPartialRevert(OptionVaultBase.OutsideOfferBand.selector);
        v.buy(worthless, 1e18, type(uint256).max, takerId);

        _buyAs(v, a, 1e18);
        uint256 room = ch.cashOf(v.vaultId()) - 170e18;
        uint256 qb = room * 1e18 / 155e18 / 1e16 * 1e16;
        _buyAs(v, b, qb);
        _sellAs(v, a, 1e18);
        _sellAs(v, b, qb);

        assertEq(ch.positionsOf(takerId).length, 0);
        assertLt(ch.cashOf(takerId), cash0, "closed round trip must lose");
        assertGe(v.totalAssets(), nav0, "depositors must not lose");
    }

    function test_crossSeriesRoundTripLosesCoveredCall() public {
        CoveredCallVault v = _newCoveredCall(_config());
        uint32 a = _list(address(nvda), e2, 190e18, true);
        uint32 b = _list(address(nvda), e, 210e18, true);
        _vaultDeposit(v, alice, 10e18);
        _deposit(bob, v.vaultId(), address(usdg), 100 * USDG); // premium cash earned earlier
        uint256 nav0 = v.totalAssets();
        uint256 cash0 = ch.cashOf(takerId);

        uint32 worthless = _list(address(nvda), e, 270e18, true);
        vm.prank(taker);
        vm.expectPartialRevert(OptionVaultBase.OutsideOfferBand.selector);
        v.buy(worthless, 9e18, type(uint256).max, takerId);

        _buyAs(v, a, 1e18);
        _buyAs(v, b, 9e18);
        _sellAs(v, a, 1e18);
        _sellAs(v, b, 9e18);

        assertLt(ch.cashOf(takerId), cash0, "closed round trip must lose");
        assertGe(v.totalAssets(), nav0, "depositors must not lose");
    }

    /// @dev The taker's owner deposits 1M to lift the backing, buys at low utilization, takes the
    /// deposit back out (utilization jumps) and sells back.
    function test_backingLeverLoses() public {
        PutWriteVault v = _newPutWrite(_config());
        uint32 a = _list(address(nvda), e2, 170e18, false);
        _vaultDeposit(v, alice, 2000 * USDG);
        uint256 nav0 = v.totalAssets();
        uint256 cash0 = ch.cashOf(takerId);

        uint256 sh = _vaultDeposit(v, taker, 1_000_000 * USDG);
        _buyAs(v, a, 10e18);
        // the deposit can't leave in the same block it lifted the backing for the sale
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(OptionVaultBase.ExitCooldown.selector, taker, _now() + 1 hours));
        v.redeem(sh, taker, taker);
        // and an hour later the buyback pays no more than the mark
        vm.warp(_now() + 1 hours);
        vm.prank(taker);
        uint256 out = v.redeem(sh, taker, taker);
        for (uint256 i = 0; i < 10; ++i) {
            _sellAs(v, a, 1e18);
        }

        int256 pnl = int256(ch.cashOf(takerId)) - int256(cash0) + (int256(out) - int256(1_000_000 * USDG)) * 1e12;
        assertEq(ch.positionsOf(takerId).length, 0);
        assertLt(pnl, 0, "closed round trip must lose");
        assertGe(v.totalAssets(), nav0, "depositors must not lose");
    }

    function test_backingLeverLoopDoesNotDrain() public {
        PutWriteVault v = _newPutWrite(_config());
        uint32 a = _list(address(nvda), e2, 170e18, false);
        _vaultDeposit(v, alice, 2000 * USDG);
        uint256 nav0 = v.totalAssets();
        uint256 cash0 = ch.cashOf(takerId);
        int256 walletPnl;
        uint256 t = block.timestamp;
        for (uint256 k = 0; k < 10; ++k) {
            uint256 sh = _vaultDeposit(v, taker, 1_000_000 * USDG);
            uint256 room = (ch.cashOf(v.vaultId()) - 1_000_000e18) * 95 / 100;
            uint256 q = room * 1e18 / 170e18 / 1e16 * 1e16;
            _buyAs(v, a, q);
            t += 1 hours;
            vm.warp(t);
            vm.prank(taker);
            uint256 out = v.redeem(sh, taker, taker);
            walletPnl += (int256(out) - int256(1_000_000 * USDG)) * 1e12;
            uint256 step = q / 10 / 1e16 * 1e16;
            uint256 left = q;
            while (left > 0) {
                uint256 x = left < 2 * step ? left : step;
                _sellAs(v, a, x);
                left -= x;
            }
        }
        int256 pnl = int256(ch.cashOf(takerId)) - int256(cash0) + walletPnl;
        assertEq(ch.positionsOf(takerId).length, 0);
        assertLt(pnl, 0, "closed round trips must lose");
        assertGe(v.totalAssets(), nav0, "depositors must not lose");
    }

    /// @dev Buy one minute before Friday's close, sell back at Sunday's reopen with the extended
    /// vol add; on Saturday the vault doesn't buy back at all.
    function test_sessionStepRoundTripLoses() public {
        PutWriteVault v = _newPutWrite(_config());
        uint32 a = _list(address(nvda), e2, 170e18, false);
        _vaultDeposit(v, alice, 20_000 * USDG);
        vm.warp(uint256(e) - 60);
        _refresh(180e18);
        uint256 cash0 = ch.cashOf(takerId);
        _buyAs(v, a, 10e18);
        vm.warp(uint256(e) + 4 hours + 1); // Saturday 00:00 UTC, WEEKEND
        vm.prank(taker);
        vm.expectRevert(OptionVaultBase.VaultNotLive.selector);
        v.sellBack(a, 10e18, 0, takerId);
        vm.warp(uint256(e) + 2 days + 4 hours + 60); // Sunday 20:01 EDT, EXTENDED
        _refresh(180e18);
        _sellAs(v, a, 10e18);
        assertLt(ch.cashOf(takerId), cash0, "closed round trip must lose");
    }

    /// @dev A buyback that would leave the vault 0.005 short (below minTradeQty) is refused up
    /// front, by the quote as well as by the trade.
    function test_dustResidualRejected() public {
        PutWriteVault v = _newPutWrite(_config());
        uint32 a = _list(address(nvda), e2, 170e18, false);
        _vaultDeposit(v, alice, 2000 * USDG);
        _buyAs(v, a, 1e18);
        uint256 vid = v.vaultId();
        bytes memory dust = abi.encodeWithSelector(CHErrors.DustPosition.selector, vid, int256(-0.005e18));
        vm.expectRevert(dust);
        v.quote(a, 0.995e18, false);
        vm.prank(taker);
        vm.expectRevert(dust);
        v.sellBack(a, 0.995e18, 0, takerId);
    }

    // ---------------------------------------------------------------- the mark moves inside a tx

    /// @dev Two months of quiet daily prints (low realized vol), then two big moves the hub's vol
    /// state hasn't folded in yet. Returns the expiries two and four weeks out.
    function _calmThenUnfoldedMoves() internal returns (uint64 x2, uint64 x4) {
        for (uint256 i = 1; i <= 62; ++i) {
            vm.warp(T0 + i * 1 days);
            _refresh(i % 2 == 0 ? 180.5e18 : 179.5e18);
        }
        vm.warp(T0 + 62 days + 6 hours);
        _refresh(180e18);
        uint64 x1 = uint64(NyseCalendar.nextWeeklyExpiry(_now()));
        x2 = uint64(NyseCalendar.nextWeeklyExpiry(x1));
        x4 = uint64(NyseCalendar.nextWeeklyExpiry(NyseCalendar.nextWeeklyExpiry(x2)));
    }

    /// @dev Buy at the stale (low) mark vol, fold the pending rounds in with the permissionless
    /// pokeVol (mark vol jumps), sell back at the new mark: all in one transaction's worth of calls.
    function _volSandwich(bool far, uint256 qty) internal {
        (uint64 x2, uint64 x4) = _calmThenUnfoldedMoves();
        PutWriteVault v = _newPutWrite(_config());
        uint32 a = _list(address(nvda), far ? x4 : x2, 170e18, false);
        _vaultDeposit(v, alice, 20_000 * USDG);
        vm.warp(_now() + 1 hours);
        _setPrice(address(nvda), 207e18);
        vm.warp(_now() + 1 hours);
        _setPrice(address(nvda), 180e18);

        uint256 cash0 = ch.cashOf(takerId);
        _buyAs(v, a, qty);
        _pokeVol(address(nvda));
        _sellAs(v, a, qty);
        assertLt(ch.cashOf(takerId), cash0, "closed round trip must lose");
    }

    function test_volSandwichNearLoses() public {
        _volSandwich(false, 10e18);
    }

    function test_volSandwichFarLoses() public {
        _volSandwich(true, 10e18);
    }

    function test_volSandwichFarLargeLoses() public {
        _volSandwich(true, 30e18);
    }

    /// @dev Deposit-side twin: an aged stake deposits, folds a quiet day into the vol (marks fall,
    /// NAV steps up) and redeems in the same block.
    function test_depositCannotCaptureVolStep() public {
        PutWriteVault v = _newPutWrite(_config());
        uint32 a = _list(address(nvda), e2, 170e18, false);
        _vaultDeposit(v, alice, 20_000 * USDG);
        _vaultDeposit(v, carol, 1_000 * USDG); // aged stake
        _buyAs(v, a, 100e18);
        vm.warp(_now() + 26 hours);
        _refresh(180e18);
        vm.warp(_now() + 23 hours);
        _setPrice(address(nvda), 180.2e18);
        vm.warp(_now() + 2 hours); // still Friday: the vault is closed over the weekend
        _setPrice(address(nvda), 179.9e18);

        uint256 dep = 30_000 * USDG;
        uint256 sh = _vaultDeposit(v, carol, dep);
        _pokeVol(address(nvda));
        uint256 maxR = v.maxRedeem(carol);
        uint256 burn = sh < maxR ? sh : maxR;
        vm.prank(carol);
        uint256 out = v.redeem(burn, carol, carol);
        assertLe(out * sh, dep * burn, "redeemed more than the deposit was worth");
    }

    /// @dev Filling every series slot with minimum-size far-OTM options must not shut the vault
    /// out of selling a normal series.
    function test_seriesSlotSquatBlocked() public {
        CoveredCallVault v = _newCoveredCall(_config());
        _vaultDeposit(v, alice, 100e18);
        uint64 x = e2;
        uint256 n;
        for (uint256 w = 0; w < 5 && n < 24; ++w) {
            for (uint128 k = 270e18; k >= 215e18 && n < 24; k -= 5e18) {
                uint32 sid = _list(address(nvda), x, k, true);
                vm.prank(taker);
                vm.expectRevert(); // below minNewSeriesQty, and mostly outside the offer band too
                v.buy(sid, 0.01e18, type(uint256).max, takerId);
                ++n;
            }
            x = uint64(NyseCalendar.nextWeeklyExpiry(x));
        }
        uint32 legit = _list(address(nvda), e2, 190e18, true);
        _buyAs(v, legit, 10e18);
    }
}
