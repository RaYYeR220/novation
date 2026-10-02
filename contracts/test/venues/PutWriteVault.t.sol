// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {VaultFixture} from "./VaultFixture.sol";
import {AccountState} from "../../src/interfaces/IClearinghouse.sol";
import {OptionVaultBase, VaultConfig} from "../../src/venues/OptionVaultBase.sol";
import {PutWriteVault} from "../../src/venues/PutWriteVault.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BlackScholes} from "../../src/libraries/BlackScholes.sol";
import {FixedPointMath as F} from "../../src/libraries/FixedPointMath.sol";
import {Session} from "../../src/types/Types.sol";

contract PutWriteVaultTest is VaultFixture {
    PutWriteVault vault;
    uint256 vid;

    uint32 put170; // e, 5.6% OTM: inside the strategy (strike <= 180 * 0.95 = 171)
    uint32 put175; // e, 2.8% OTM: too close to spot
    uint32 put190; // e, in the money
    uint32 call190; // e, wrong type
    uint32 put170w2; // e2
    uint32 put170far; // eFar, beyond the tenor cap
    uint32 spyPut; // other underlying

    function setUp() public override {
        super.setUp();
        vault = _newPutWrite(_config());
        vid = vault.vaultId();
        put170 = _list(address(nvda), e, 170e18, false);
        put175 = _list(address(nvda), e, 175e18, false);
        put190 = _list(address(nvda), e, 190e18, false);
        call190 = _list(address(nvda), e, 190e18, true);
        put170w2 = _list(address(nvda), e2, 170e18, false);
        put170far = _list(address(nvda), eFar, 170e18, false);
        spyPut = _list(address(spy), e, 550e18, false);
    }

    // ================================================================ construction

    function test_constructorWiring() public {
        assertEq(ch.ownerOf(vid), address(vault));
        assertTrue(ch.isVenue(address(vault)));
        assertEq(vault.asset(), address(usdg));
        assertEq(vault.underlying(), address(nvda));
        assertEq(vault.decimals(), 12); // 6 + the 6-decimal virtual-share offset
        assertEq(usdg.allowance(address(vault), address(ch)), type(uint256).max);
        assertEq(vault.totalAssets(), 0);
        assertEq(vault.symbol(), "npwNVDA");

        // the asset must be the clearinghouse's USDG, the underlying a listed one
        vm.expectRevert(OptionVaultBase.BadConfig.selector);
        this.deployPutWrite(address(nvda), address(nvda), _config());
        vm.expectRevert(OptionVaultBase.BadConfig.selector);
        this.deployPutWrite(address(usdg), address(usdg), _config());
    }

    // ================================================================ NAV

    function test_depositPricedAtLiveNav() public {
        uint256 aShares = _vaultDeposit(vault, alice, 2000 * USDG);
        assertEq(aShares, 2000 * USDG * 1e6);
        assertEq(vault.totalAssets(), 2000 * USDG);

        _buy(vault, put170, 5e18);
        AccountState memory st = ch.accountState(vid);
        uint256 nav = vault.totalAssets();
        assertEq(nav, uint256(st.equity) / 1e12);
        assertGt(nav, 2000 * USDG);

        uint256 expected = Math.mulDiv(2000 * USDG, vault.totalSupply() + 1e6, nav + 1);
        uint256 bShares = _vaultDeposit(vault, bob, 2000 * USDG);
        assertEq(bShares, expected);
        assertLt(bShares, aShares);
        assertLe(vault.previewRedeem(bShares), 2000 * USDG);
        assertGt(vault.previewRedeem(aShares), 2000 * USDG);

        // a drop in spot raises the short puts' marks: NAV falls at once
        uint256 before = vault.totalAssets();
        _setPrice(address(nvda), 165e18);
        st = ch.accountState(vid);
        assertEq(vault.totalAssets(), uint256(st.equity) / 1e12);
        assertLt(vault.totalAssets(), before);
    }

    /// forge-config: default.fuzz.runs = 64
    function test_depositWithdrawSymmetryNoProfit(uint256 amount) public {
        amount = bound(amount, 1, 100_000_000 * USDG);
        _vaultDeposit(vault, alice, 2000 * USDG);
        _buy(vault, put170, 5e18);

        uint256 shares = _vaultDeposit(vault, bob, amount);
        assertLe(vault.previewRedeem(shares), amount); // straight back out at the same NAV: no gain
        assertEq(vault.maxRedeem(bob), 0); // and not at once: the exit cooldown runs first
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(OptionVaultBase.ExitCooldown.selector, bob, _now() + 1 hours));
        vault.redeem(shares, bob, bob);

        _cooldown();
        uint256 preview = vault.previewRedeem(shares);
        vm.prank(bob);
        uint256 out = vault.redeem(shares, bob, bob);
        assertEq(out, preview);
        assertEq(usdg.balanceOf(bob), out);
        assertEq(vault.balanceOf(bob), 0);
    }

    // ================================================================ strategy

    function test_buyWithinStrategy() public {
        _vaultDeposit(vault, alice, 2000 * USDG);
        uint256 q = vault.quote(put170, 5e18, true);
        uint256 takerCash = ch.cashOf(takerId);

        vm.expectEmit(true, true, true, true, address(vault));
        emit OptionVaultBase.Bought(taker, takerId, put170, 5e18, q);
        vm.prank(taker);
        assertEq(vault.buy(put170, 5e18, q, takerId), q);

        assertEq(ch.cashOf(vid), 2000e18 + q);
        assertEq(ch.cashOf(takerId), takerCash - q - _takerFee(5e18, 180e18, q));
        _assertPos(vid, put170, -5e18);
        _assertPos(takerId, put170, 5e18);
        assertEq(vault.lockedAssets(), 850 * USDG);
        assertEq(vault.freeAssets(), (2000e18 + q - 850e18) / 1e12);

        uint256 q2 = vault.quote(put170, 1e18, true);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(OptionVaultBase.PremiumAboveMax.selector, q2, q2 - 1));
        vault.buy(put170, 1e18, q2 - 1, takerId);

        _buy(vault, put170w2, 1e18);
        _assertPos(vid, put170w2, -1e18);
        assertEq(vault.lockedAssets(), 1020 * USDG);
    }

    function test_buyRejectsItmStrike() public {
        _vaultDeposit(vault, alice, 2000 * USDG);
        vm.startPrank(taker);
        vm.expectRevert(OptionVaultBase.StrikeNotOtm.selector);
        vault.buy(put175, 1e18, type(uint256).max, takerId);
        vm.expectRevert(OptionVaultBase.StrikeNotOtm.selector);
        vault.buy(put190, 1e18, type(uint256).max, takerId);
        vm.stopPrank();

        // at 178 the threshold is 169.1, so 170 no longer qualifies
        _setPrice(address(nvda), 178e18);
        vm.prank(taker);
        vm.expectRevert(OptionVaultBase.StrikeNotOtm.selector);
        vault.buy(put170, 1e18, type(uint256).max, takerId);
        _setPrice(address(nvda), 180e18);
        _buy(vault, put170, 1e18);
    }

    function test_buyRejectsOutsideStrategy() public {
        _vaultDeposit(vault, alice, 2000 * USDG);
        vm.startPrank(taker);
        vm.expectRevert(OptionVaultBase.WrongOptionType.selector);
        vault.buy(call190, 1e18, type(uint256).max, takerId);
        vm.expectRevert(OptionVaultBase.WrongUnderlying.selector);
        vault.buy(spyPut, 1e18, type(uint256).max, takerId);
        vm.expectRevert(OptionVaultBase.TenorTooLong.selector);
        vault.buy(put170far, 1e18, type(uint256).max, takerId);
        vm.expectRevert(OptionVaultBase.BadQty.selector);
        vault.buy(put170, 0, type(uint256).max, takerId);
        vm.expectRevert(OptionVaultBase.BadQty.selector);
        vault.buy(put170, 100e18 + 1, type(uint256).max, takerId);
        vm.expectRevert(OptionVaultBase.BelowMinNewSeries.selector);
        vault.buy(put170, 0.5e18, type(uint256).max, takerId);
        // a put this far out is outside the offer band
        uint32 put140 = _list(address(nvda), e, 140e18, false);
        (int256 d,,,) = BlackScholes.greeks(180e18, 140e18, e - _now(), hub.markVol(address(nvda)), 0, false);
        vm.expectRevert(abi.encodeWithSelector(OptionVaultBase.OutsideOfferBand.selector, uint256(-d)));
        vault.buy(put140, 1e18, type(uint256).max, takerId);
        vm.stopPrank();
    }

    function test_buyRejectsUnsecured() public {
        _vaultDeposit(vault, alice, 1000 * USDG);
        // 6 puts at 170 need 1020 USDG of cash
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(OptionVaultBase.ExceedsCapacity.selector, 1020e18, 1000e18));
        vault.buy(put170, 6e18, type(uint256).max, takerId);

        _buy(vault, put170, 5e18); // 850 secured
        // the premium received counts as cash; the boundary is exact to the wei
        uint256 cash = ch.cashOf(vid);
        uint256 room = cash - 850e18;
        uint256 qMax = room * 1e18 / 170e18;
        uint256 over = 850e18 + F.mulWadUp(qMax + 1, 170e18);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(OptionVaultBase.ExceedsCapacity.selector, over, cash));
        vault.buy(put170w2, qMax + 1, type(uint256).max, takerId);
        _buy(vault, put170w2, qMax);
        assertLe(vault.lockedAssets() * 1e12, ch.cashOf(vid));
    }

    // ================================================================ quoting

    function test_quoteMatchesKernelPrice() public {
        _vaultDeposit(vault, alice, 1700 * USDG);
        _buy(vault, put170w2, 4e18); // locks 680 of 1700 + premium
        uint256 cash = ch.cashOf(vid);

        // ask for 3 more: 1190 locked after the sale
        uint256 tau = e - _now();
        uint256 volQ = _volQ(_utilAfter(1190, cash));
        uint256 px = _kernelPx(tau, volQ);
        assertEq(px, BlackScholes.price(180e18, 170e18, tau, volQ, 0, false)); // bit-identical
        assertEq(vault.quote(put170, 3e18, true), F.mulWadUp(F.mulWadUp(3e18, px), 1.02e18));

        // bid for 3 of the 4 short: never above the mark NAV carries the short at
        uint256 mark = _kernelPx(e2 - _now(), hub.markVol(address(nvda)));
        assertGt(_kernelPx(e2 - _now(), _volQ(_utilAfter(170, cash))), mark); // formula alone pays more
        assertEq(vault.quote(put170w2, 3e18, false), (3e18 * mark / 1e18) * 0.98e18 / 1e18);
    }

    /// @dev locked / (locked + free) in USDG units with `lockedUsd` whole dollars locked.
    function _utilAfter(uint256 lockedUsd, uint256 cashWad) internal pure returns (uint256) {
        uint256 locked = lockedUsd * USDG;
        uint256 free = (cashWad - lockedUsd * 1e18) / 1e12;
        return locked * 1e18 / (locked + free);
    }

    /// @dev Quoting vol for the 170 strike at spot 180, REGULAR session.
    function _volQ(uint256 util) internal view returns (uint256) {
        uint256 m = uint256(-F.lnWad(F.divWad(int256(170e18), int256(180e18))));
        return hub.markVol(address(nvda)) * (1e18 + 0.5e18 * m / 1e18 + 0.3e18 * util / 1e18) / 1e18;
    }

    function _kernelPx(uint256 tau, uint256 vol) internal view returns (uint256 px) {
        (px,,,,) = kernel.bsQuote(180e18, 170e18, tau, vol, 0, false);
    }

    function test_roundTripNotProfitable() public {
        _vaultDeposit(vault, alice, 1700 * USDG);
        uint256 cash0 = ch.cashOf(takerId);
        _buy(vault, put170, 8e18);
        vm.prank(taker);
        vault.sellBack(put170, 8e18, 0, takerId);
        uint256 cash1 = ch.cashOf(takerId);
        assertLt(cash1, cash0);
        for (uint256 i = 0; i < 4; ++i) {
            _buy(vault, put170, 2e18);
        }
        for (uint256 i = 0; i < 4; ++i) {
            vm.prank(taker);
            vault.sellBack(put170, 2e18, 0, takerId);
        }
        assertLt(ch.cashOf(takerId), cash1);
        assertGt(vault.totalAssets(), 1700 * USDG);
    }

    function test_quoteIncreasesWithUtilization() public {
        _vaultDeposit(vault, alice, 1700 * USDG);
        _buy(vault, put170, 1e18); // something to bid for
        uint256 ask0 = vault.quote(put170, 1e18, true);
        uint256 bid0 = vault.quote(put170, 1e18, false);
        assertLt(bid0, ask0);
        // the bid is the mark less the spread, whatever the utilization
        uint256 mark = _kernelPx(e - _now(), hub.markVol(address(nvda)));
        assertEq(bid0, (1e18 * mark / 1e18) * 0.98e18 / 1e18);

        _buy(vault, put170w2, 4e18);
        uint256 ask1 = vault.quote(put170, 1e18, true);
        assertGt(ask1, ask0);
        assertEq(vault.quote(put170, 1e18, false), bid0);

        _buy(vault, put170w2, 4e18); // 1530 of 1700 locked
        assertGt(vault.quote(put170, 1e18, true), ask1);
        assertEq(vault.quote(put170, 1e18, false), bid0);
    }

    function test_weekendQuoteHigher() public {
        PutWriteVault flat = _newPutWrite(_flatConfig());
        _vaultDeposit(vault, alice, 1700 * USDG);
        _vaultDeposit(flat, alice, 1700 * USDG);
        assertEq(vault.quote(put170w2, 1e18, true), flat.quote(put170w2, 1e18, true));

        vm.warp(SATURDAY);
        assertFalse(vault.isLive()); // the vol state is over two days old
        _refresh(180e18);
        assertEq(uint8(hub.session(address(nvda))), uint8(Session.WEEKEND));
        assertTrue(vault.isLive());
        uint256 ask = vault.quote(put170w2, 1e18, true);
        uint256 askFlat = flat.quote(put170w2, 1e18, true);
        assertGt(ask, askFlat);

        uint256 volFlat = _volQ(0.1e18); // 170 of 1700 locked after the sale
        uint256 tau = e2 - SATURDAY; // not block.timestamp: via-ir may reuse a pre-warp read
        (uint256 pxWk,,,,) = kernel.bsQuote(180e18, 170e18, tau, volFlat + WEEKEND_ADD, 0, false);
        assertEq(ask, F.mulWadUp(pxWk, 1.02e18));
    }

    // ================================================================ live gate

    function test_haltedVaultRejectsDeposit() public {
        _vaultDeposit(vault, alice, 2000 * USDG);
        _buy(vault, put170, 2e18);
        _cooldown();
        assertGt(vault.maxWithdraw(alice), 0);
        usdg.mint(bob, 100 * USDG);
        vm.prank(bob);
        usdg.approve(address(vault), 100 * USDG);

        vm.warp(_now() + STALE);
        assertFalse(vault.isLive());
        assertEq(vault.maxDeposit(bob), 0);
        assertEq(vault.maxMint(bob), 0);
        assertEq(vault.maxWithdraw(alice), 0);
        assertEq(vault.maxRedeem(alice), 0);

        vm.startPrank(bob);
        vm.expectRevert(OptionVaultBase.VaultNotLive.selector);
        vault.deposit(100 * USDG, bob);
        vm.expectRevert(OptionVaultBase.VaultNotLive.selector);
        vault.mint(1e12, bob);
        vm.stopPrank();
        vm.startPrank(alice);
        vm.expectRevert(OptionVaultBase.VaultNotLive.selector);
        vault.withdraw(1 * USDG, alice, alice);
        vm.expectRevert(OptionVaultBase.VaultNotLive.selector);
        vault.redeem(1e12, alice, alice);
        vm.stopPrank();
        vm.startPrank(taker);
        vm.expectRevert(OptionVaultBase.VaultNotLive.selector);
        vault.buy(put170, 1e18, type(uint256).max, takerId);
        vm.expectRevert(OptionVaultBase.VaultNotLive.selector);
        vault.sellBack(put170, 1e18, 0, takerId);
        vm.stopPrank();

        _setPrice(address(nvda), 180e18);
        assertFalse(vault.isLive()); // until the new round reaches the vol state
        vm.prank(bob);
        vault.deposit(100 * USDG, bob); // which the deposit syncs itself
        assertTrue(vault.isLive());
    }

    // ================================================================ exits

    function test_withdrawOnlyFreeAssets() public {
        _vaultDeposit(vault, alice, 2000 * USDG);
        _buy(vault, put170, 10e18); // 1700 locked
        _cooldown();
        uint256 free = vault.freeAssets();
        assertEq(free, (ch.cashOf(vid) - 1700e18) / 1e12);
        assertEq(vault.maxWithdraw(alice), free);

        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxWithdraw.selector, alice, free + 1, free));
        vault.withdraw(free + 1, alice, alice);
        vault.withdraw(free, alice, alice);
        vm.stopPrank();

        assertEq(usdg.balanceOf(alice), free);
        assertGe(ch.cashOf(vid), 1700e18); // strike notional stays secured
        assertEq(vault.freeAssets(), 0);
        assertEq(vault.maxWithdraw(alice), 0);
    }

    function test_sellBackReducesShort() public {
        _vaultDeposit(vault, alice, 2000 * USDG);
        _buy(vault, put170, 5e18);
        uint256 bid = vault.quote(put170, 2e18, false);
        uint256 vaultCash = ch.cashOf(vid);
        uint256 takerCash = ch.cashOf(takerId);

        vm.expectEmit(true, true, true, true, address(vault));
        emit OptionVaultBase.SoldBack(taker, takerId, put170, 2e18, bid);
        vm.prank(taker);
        assertEq(vault.sellBack(put170, 2e18, bid, takerId), bid);
        _assertPos(vid, put170, -3e18);
        _assertPos(takerId, put170, 3e18);
        assertEq(ch.cashOf(vid), vaultCash - bid);
        assertEq(ch.cashOf(takerId), takerCash + bid - _takerFee(2e18, 180e18, bid));
        assertEq(vault.lockedAssets(), 510 * USDG);

        vm.startPrank(taker);
        vm.expectRevert(abi.encodeWithSelector(OptionVaultBase.ExceedsShort.selector, 3e18 + 1, 3e18));
        vault.sellBack(put170, 3e18 + 1, 0, takerId);
        vault.sellBack(put170, 3e18, 0, takerId);
        vm.stopPrank();
        assertEq(ch.positionsOf(vid).length, 0);
        assertEq(vault.lockedAssets(), 0);
    }

    function test_inflationAttackMitigated() public {
        address attacker = _user("attacker");
        uint256 aShares = _vaultDeposit(vault, attacker, 1);
        assertEq(aShares, 1e6);
        _deposit(attacker, vid, address(usdg), 1_000_000 * USDG);
        usdg.mint(address(vault), 500_000 * USDG); // not NAV
        assertEq(vault.totalAssets(), 1_000_000 * USDG + 1);

        uint256 vShares = _vaultDeposit(vault, alice, 10_000 * USDG);
        assertGt(vShares, 0);
        assertGe(vault.previewRedeem(vShares), 10_000 * USDG * 9999 / 10_000);
        assertLt(vault.previewRedeem(aShares), 1_000_000 * USDG);
    }

    // ================================================================ fix round: queue, worthless vault

    function test_queueReservedFromCashSecurity() public {
        _vaultDeposit(vault, alice, 1700 * USDG);
        _cooldown();
        uint256 half = vault.balanceOf(alice) / 2;
        vm.prank(alice);
        vault.requestRedeem(half, alice); // owed 850
        assertEq(vault.freeAssets(), 850 * USDG);
        // 6 puts at 170 need 1020 of cash, and only 850 isn't owed to the queue
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(OptionVaultBase.ExceedsCapacity.selector, 1870e18, 1700e18));
        vault.buy(put170, 6e18, type(uint256).max, takerId);
        _buy(vault, put170, 5e18);
        vault.roll(new uint64[](0)); // the queue is paid from what it reserved
        assertEq(vault.epoch(), 1);
        assertGe(ch.cashOf(vid), 850e18); // the puts stay cash-secured
    }

    function test_noDepositIntoWorthlessVault() public {
        _vaultDeposit(vault, alice, 1000 * USDG);
        _cheatCashIndex(1); // every account's cash socialized away
        assertEq(vault.totalAssets(), 0);
        assertGt(vault.totalSupply(), 0);
        assertEq(vault.maxDeposit(bob), 0);
        assertEq(vault.maxMint(bob), 0);
    }

    // ================================================================ async redemption

    function test_requestRedeemProcessedWhenFlat() public {
        uint256 aShares = _vaultDeposit(vault, alice, 1000 * USDG);
        _vaultDeposit(vault, bob, 3000 * USDG);
        _cooldown();
        vm.prank(alice);
        vault.requestRedeem(aShares, carol);
        vm.prank(bob);
        vault.requestRedeem(aShares, bob);

        vm.expectEmit(true, true, true, true, address(vault));
        emit OptionVaultBase.Rolled(0, 2000 * USDG);
        vault.roll(new uint64[](0));
        assertEq(vault.totalAssets(), 2000 * USDG);
        assertEq(usdg.balanceOf(address(vault)), 2000 * USDG);
        vault.claimRedeemed(carol);
        vault.claimRedeemed(bob);
        assertEq(usdg.balanceOf(carol), 1000 * USDG);
        assertEq(usdg.balanceOf(bob), 1000 * USDG);
    }

    function test_rollWaitsUntilFreeAssetsCover() public {
        uint256 aShares = _vaultDeposit(vault, alice, 2000 * USDG);
        _buy(vault, put170, 10e18); // 1700 locked, about 340 free
        _cooldown();
        vm.prank(alice);
        vault.requestRedeem(aShares / 4, alice); // about 500
        vault.roll(_one(e));
        assertEq(vault.epoch(), 0);

        vm.prank(taker);
        vault.sellBack(put170, 10e18, 0, takerId);
        uint256 expected = vault.convertToAssets(aShares / 4);
        vault.roll(_one(e));
        assertEq(vault.epoch(), 1);
        assertEq(vault.redeemable(alice), expected);
    }

    function test_rollPaysFromFreeWhileShortsOpen() public {
        uint256 aShares = _vaultDeposit(vault, alice, 2000 * USDG);
        _buy(vault, put170w2, 5e18); // 850 locked
        _cooldown();
        vm.prank(alice);
        vault.requestRedeem(aShares / 4, alice);
        uint256 expected = vault.convertToAssets(aShares / 4);
        vm.expectEmit(true, true, true, true, address(vault));
        emit OptionVaultBase.Rolled(0, expected);
        vault.roll(new uint64[](0));
        assertEq(vault.redeemable(alice), expected);
        _assertPos(vid, put170w2, -5e18);
        assertGe(ch.cashOf(vid), 850e18);
        assertTrue(ch.accountState(vid).healthy);
    }

    // ================================================================ expiry cycles (need settlement)

    function test_requestRedeemFulfilledAfterRoll() public {
        _skipWithoutSettlement();
        uint256 aShares = _vaultDeposit(vault, alice, 2000 * USDG);
        _vaultDeposit(vault, bob, 2000 * USDG);
        _buy(vault, put170, 20e18); // 3400 locked, about 700 free
        _cooldown();
        vm.prank(alice);
        vault.requestRedeem(aShares / 2, alice); // over 1000

        vault.roll(_one(e));
        assertEq(vault.epoch(), 0);

        vm.warp(e + 1);
        _settleExpiry(address(nvda), e, 180e18);
        _pokeVol(address(nvda));
        uint256 expected = vault.convertToAssets(aShares / 2);
        vm.expectEmit(true, true, true, true, address(vault));
        emit OptionVaultBase.Rolled(0, expected);
        vault.roll(_one(e));

        assertEq(ch.positionsOf(vid).length, 0);
        assertEq(vault.redeemable(alice), expected);
        vault.claimRedeemed(alice);
        assertEq(usdg.balanceOf(alice), expected);
        assertGt(expected, 1000 * USDG);
    }

    /// The covered-call vault's in-kind exits have no mirror here: the asset is USDG, premiums
    /// arrive as USDG and puts settle in USDG, so the account holds only the asset and every exit,
    /// the last one included, is paid in it alone.
    function test_lastHolderTakesEverything() public {
        _skipWithoutSettlement();
        uint256 aShares = _vaultDeposit(vault, alice, 2000 * USDG);
        uint256 bShares = _vaultDeposit(vault, bob, 2000 * USDG);
        _buy(vault, put170, 10e18);
        uint256 total = ch.cashOf(vid); // deposits plus the premium
        assertGt(total, 4000e18);
        vm.warp(e + 1);
        _settleExpiry(address(nvda), e, 180e18);
        _pokeVol(address(nvda));
        vault.roll(_one(e));
        assertEq(ch.collateralTokensOf(vid).length, 0);

        vm.prank(alice);
        vault.redeem(aShares, alice, alice);
        vm.prank(bob);
        vault.redeem(bShares, bob, bob);
        assertEq(vault.totalSupply(), 0);
        assertApproxEqAbs(usdg.balanceOf(alice), total / 2e12, 1);
        assertApproxEqAbs(usdg.balanceOf(bob), total / 2e12, 1);
        assertLt(ch.cashOf(vid), 2e12);
        assertEq(vault.redeemableCash(alice), 0);
        assertEq(vault.reservedCash(), 0);
    }

    /// @dev The put-write mirror of the covered-call deficit path: cash-secured puts pay an
    /// in-the-money expiry from cash, so no deficit arises and the roll proceeds at once.
    function test_itmExpiryDeficitPath() public {
        _skipWithoutSettlement();
        _vaultDeposit(vault, alice, 1700 * USDG);
        _buy(vault, put170, 10e18);
        _cooldown();
        uint256 half = vault.balanceOf(alice) / 2;
        vm.prank(alice);
        vault.requestRedeem(half, alice);

        vm.warp(e + 1);
        _settleExpiry(address(nvda), e, 150e18); // the 10 puts owe 200
        _pokeVol(address(nvda));
        uint256 cash = ch.cashOf(vid);
        assertEq(vault.totalAssets(), (cash - 200e18) / 1e12); // the loss is in NAV already

        vault.roll(_one(e));
        (uint256 deficit,,) = ch.deficitOf(vid, e);
        assertEq(deficit, 0);
        assertEq(ch.cashOf(vid), cash - 200e18 - vault.reservedAssets() * 1e12);
        assertEq(vault.epoch(), 1);
        assertGt(vault.redeemable(alice), 0);
    }
}
