// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {VaultFixture, DeficitSaleRecorder} from "./VaultFixture.sol";
import {CHErrors} from "../../src/core/ClearinghouseStorage.sol";
import {AccountState} from "../../src/interfaces/IClearinghouse.sol";
import {OptionVaultBase, VaultConfig} from "../../src/venues/OptionVaultBase.sol";
import {CoveredCallVault} from "../../src/venues/CoveredCallVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BlackScholes} from "../../src/libraries/BlackScholes.sol";
import {FixedPointMath as F} from "../../src/libraries/FixedPointMath.sol";
import {Session} from "../../src/types/Types.sol";

contract CoveredCallVaultTest is VaultFixture {
    CoveredCallVault vault;
    uint256 vid;

    uint32 call190; // e, 5.6% OTM: inside the strategy
    uint32 call185; // e, 2.8% OTM: too close to spot
    uint32 call170; // e, in the money
    uint32 put170; // e, wrong type
    uint32 call190w2; // e2
    uint32 call190far; // eFar, beyond the tenor cap
    uint32 spyCall; // other underlying

    function setUp() public override {
        super.setUp();
        vault = _newCoveredCall(_config());
        vid = vault.vaultId();
        call190 = _list(address(nvda), e, 190e18, true);
        call185 = _list(address(nvda), e, 185e18, true);
        call170 = _list(address(nvda), e, 170e18, true);
        put170 = _list(address(nvda), e, 170e18, false);
        call190w2 = _list(address(nvda), e2, 190e18, true);
        call190far = _list(address(nvda), eFar, 190e18, true);
        spyCall = _list(address(spy), e, 650e18, true);
    }

    // ================================================================ construction

    function test_constructorWiring() public {
        assertEq(ch.ownerOf(vid), address(vault));
        assertTrue(ch.isVenue(address(vault)));
        assertEq(vault.asset(), address(nvda));
        assertEq(vault.underlying(), address(nvda));
        assertEq(vault.decimals(), 24); // 18 + the 6-decimal virtual-share offset
        assertEq(nvda.allowance(address(vault), address(ch)), type(uint256).max);
        assertEq(vault.totalAssets(), 0);
        assertTrue(vault.isLive());
        assertEq(vault.symbol(), "nccNVDA");

        VaultConfig memory c = vault.config();
        assertEq(c.minOtm, 0.05e18);
        assertEq(c.maxTenorDays, 35);
        assertEq(c.sessionVolAdd[2], WEEKEND_ADD);
        assertEq(c.maxTradeQty, 100e18);

        VaultConfig memory bad = _config();
        bad.minOtm = 1e18;
        vm.expectRevert(OptionVaultBase.BadConfig.selector);
        new CoveredCallVault(IERC20Metadata(address(nvda)), ch, registry, hub, params, bad);
        bad = _config();
        bad.spread = 1e18;
        vm.expectRevert(OptionVaultBase.BadConfig.selector);
        new CoveredCallVault(IERC20Metadata(address(nvda)), ch, registry, hub, params, bad);
        bad = _config();
        bad.maxTenorDays = 0;
        vm.expectRevert(OptionVaultBase.BadConfig.selector);
        new CoveredCallVault(IERC20Metadata(address(nvda)), ch, registry, hub, params, bad);
        bad = _config();
        bad.maxTradeQty = 0;
        vm.expectRevert(OptionVaultBase.BadConfig.selector);
        new CoveredCallVault(IERC20Metadata(address(nvda)), ch, registry, hub, params, bad);
        // the asset must be a listed underlying
        vm.expectRevert(OptionVaultBase.BadConfig.selector);
        new CoveredCallVault(IERC20Metadata(address(usdg)), ch, registry, hub, params, _config());
    }

    // ================================================================ NAV

    function test_depositPricedAtLiveNav() public {
        uint256 aShares = _vaultDeposit(vault, alice, 10e18);
        assertEq(aShares, 10e24);
        assertEq(vault.totalAssets(), 10e18);

        // a sale above the kernel mark lifts the account's MTM equity: NAV > 10 tokens
        _buy(vault, call190, 5e18);
        AccountState memory st = ch.accountState(vid);
        uint256 nav = vault.totalAssets();
        assertEq(nav, uint256(st.equity) * 1e18 / 180e18);
        assertGt(nav, 10e18);

        // the next depositor buys in at that NAV: fewer shares, no share of the earlier premium
        uint256 expected = Math.mulDiv(10e18, vault.totalSupply() + 1e6, nav + 1);
        uint256 bShares = _vaultDeposit(vault, bob, 10e18);
        assertEq(bShares, expected);
        assertLt(bShares, aShares);
        assertLe(vault.previewRedeem(bShares), 10e18);
        assertGt(vault.previewRedeem(aShares), 10e18);

        // a new price reprices NAV at once (no stale NAV to trade against)
        _setPrice(address(nvda), 170e18);
        st = ch.accountState(vid);
        assertEq(vault.totalAssets(), uint256(st.equity) * 1e18 / 170e18);
    }

    /// forge-config: default.fuzz.runs = 64
    function test_depositWithdrawSymmetryNoProfit(uint256 amount) public {
        amount = bound(amount, 1, 1_000_000e18);
        _vaultDeposit(vault, alice, 10e18);
        _buy(vault, call190, 5e18);

        uint256 shares = _vaultDeposit(vault, bob, amount);
        vm.prank(bob);
        uint256 out = vault.redeem(shares, bob, bob);
        assertLe(out, amount);
        assertEq(nvda.balanceOf(bob), out);
        assertEq(vault.balanceOf(bob), 0);
    }

    // ================================================================ strategy

    function test_buyWithinStrategy() public {
        _vaultDeposit(vault, alice, 10e18);
        uint256 q = vault.quote(call190, 5e18, true);
        uint256 takerCash = ch.cashOf(takerId);

        vm.expectEmit(true, true, true, true, address(vault));
        emit OptionVaultBase.Bought(taker, takerId, call190, 5e18, q);
        vm.prank(taker);
        assertEq(vault.buy(call190, 5e18, q, takerId), q); // maxPremium exactly at the quote passes

        assertEq(ch.cashOf(vid), q);
        assertEq(ch.cashOf(takerId), takerCash - q - _takerFee(5e18, 180e18, q));
        _assertPos(vid, call190, -5e18);
        _assertPos(takerId, call190, 5e18);
        assertEq(vault.lockedAssets(), 5e18);
        assertEq(vault.freeAssets(), 5e18);

        // slippage guard
        uint256 q2 = vault.quote(call190, 1e18, true);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(OptionVaultBase.PremiumAboveMax.selector, q2, q2 - 1));
        vault.buy(call190, 1e18, q2 - 1, takerId);

        // the caller must be allowed to act for the taker account
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CHErrors.NotAuthorized.selector, takerId, bob));
        vault.buy(call190, 1e18, type(uint256).max, takerId);

        // a later expiry within the tenor cap
        _buy(vault, call190w2, 1e18);
        _assertPos(vid, call190w2, -1e18);
        assertEq(vault.lockedAssets(), 6e18);
    }

    function test_buyRejectsItmStrike() public {
        _vaultDeposit(vault, alice, 10e18);
        // strike must be >= 180 * 1.05 = 189
        vm.prank(taker);
        vm.expectRevert(OptionVaultBase.StrikeNotOtm.selector);
        vault.buy(call185, 1e18, type(uint256).max, takerId);
        vm.prank(taker);
        vm.expectRevert(OptionVaultBase.StrikeNotOtm.selector);
        vault.buy(call170, 1e18, type(uint256).max, takerId);

        // the threshold follows the live spot: at 182 it is 191.1, so 190 no longer qualifies
        _setPrice(address(nvda), 182e18);
        vm.prank(taker);
        vm.expectRevert(OptionVaultBase.StrikeNotOtm.selector);
        vault.buy(call190, 1e18, type(uint256).max, takerId);
        _setPrice(address(nvda), 180e18);
        _buy(vault, call190, 1e18);
    }

    function test_buyRejectsOutsideStrategy() public {
        _vaultDeposit(vault, alice, 10e18);
        vm.startPrank(taker);
        vm.expectRevert(OptionVaultBase.WrongOptionType.selector);
        vault.buy(put170, 1e18, type(uint256).max, takerId);
        vm.expectRevert(OptionVaultBase.WrongUnderlying.selector);
        vault.buy(spyCall, 1e18, type(uint256).max, takerId);
        vm.expectRevert(OptionVaultBase.TenorTooLong.selector);
        vault.buy(call190far, 1e18, type(uint256).max, takerId);
        vm.expectRevert(OptionVaultBase.BadQty.selector);
        vault.buy(call190, 0, type(uint256).max, takerId);
        vm.expectRevert(OptionVaultBase.BadQty.selector);
        vault.buy(call190, 100e18 + 1, type(uint256).max, takerId);
        vm.stopPrank();

        vm.warp(e);
        _setPrice(address(nvda), 180e18); // keep the feed fresh so only the expiry fails
        vm.prank(taker);
        vm.expectRevert(OptionVaultBase.SeriesExpired.selector);
        vault.buy(call190, 1e18, type(uint256).max, takerId);
    }

    function test_buyRejectsUncovered() public {
        // an empty vault covers nothing
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(OptionVaultBase.ExceedsCapacity.selector, 1e18, 0));
        vault.buy(call190, 1e18, type(uint256).max, takerId);

        _vaultDeposit(vault, alice, 10e18);
        _buy(vault, call190, 6e18);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(OptionVaultBase.ExceedsCapacity.selector, 10e18 + 1, 10e18));
        vault.buy(call190w2, 4e18 + 1, type(uint256).max, takerId);

        _buy(vault, call190w2, 4e18); // exactly fully covered
        assertEq(vault.lockedAssets(), 10e18);
        assertEq(vault.freeAssets(), 0);
        // premium cash is USDG, not tokens: it adds no coverage
        assertGt(ch.cashOf(vid), 0);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(OptionVaultBase.ExceedsCapacity.selector, 10.01e18, 10e18));
        vault.buy(call190, 0.01e18, type(uint256).max, takerId);
    }

    // ================================================================ quoting

    function test_quoteMatchesKernelPrice() public {
        _vaultDeposit(vault, alice, 10e18);
        _buy(vault, call190w2, 4e18); // 4 of 10 tokens locked

        // ask for 3 more: utilization after the sale 7/10
        uint256 tau = e - block.timestamp;
        uint256 px = _kernelPx(tau, _volQ(0.7e18));
        assertEq(px, BlackScholes.price(180e18, 190e18, tau, _volQ(0.7e18), 0, true)); // bit-identical
        assertEq(vault.quote(call190, 3e18, true), F.mulWadUp(F.mulWadUp(3e18, px), 1.02e18));

        // bid for 3 of the 4 short: utilization after the buyback 1/10
        px = _kernelPx(e2 - block.timestamp, _volQ(0.1e18));
        assertEq(vault.quote(call190w2, 3e18, false), (3e18 * px / 1e18) * 0.98e18 / 1e18);
    }

    /// @dev Quoting vol for the 190 strike at spot 180 and utilization `util`, REGULAR session.
    function _volQ(uint256 util) internal view returns (uint256) {
        uint256 m = uint256(F.lnWad(F.divWad(int256(190e18), int256(180e18))));
        return hub.markVol(address(nvda)) * (1e18 + 0.5e18 * m / 1e18 + 0.3e18 * util / 1e18) / 1e18;
    }

    function _kernelPx(uint256 tau, uint256 vol) internal view returns (uint256 px) {
        (px,,,,) = kernel.bsQuote(180e18, 190e18, tau, vol, 0, true);
    }

    function test_roundTripNotProfitable() public {
        _vaultDeposit(vault, alice, 10e18);
        uint256 cash0 = ch.cashOf(takerId);
        // all at once
        _buy(vault, call190, 5e18);
        vm.prank(taker);
        vault.sellBack(call190, 5e18, 0, takerId);
        uint256 cash1 = ch.cashOf(takerId);
        assertLt(cash1, cash0);
        // in pieces: each buy prices the utilization it creates, each sell the one it leaves
        for (uint256 i = 0; i < 5; ++i) {
            _buy(vault, call190, 1e18);
        }
        for (uint256 i = 0; i < 5; ++i) {
            vm.prank(taker);
            vault.sellBack(call190, 1e18, 0, takerId);
        }
        assertLt(ch.cashOf(takerId), cash1);
        // the vault kept the difference: NAV above the 10 tokens deposited
        assertGt(vault.totalAssets(), 10e18);
    }

    function test_quoteIncreasesWithUtilization() public {
        _vaultDeposit(vault, alice, 10e18);
        uint256 ask0 = vault.quote(call190, 1e18, true);
        uint256 bid0 = vault.quote(call190, 1e18, false);
        assertLt(bid0, ask0);

        _buy(vault, call190w2, 5e18); // half the tokens locked
        assertEq(vault.lockedAssets(), 5e18);
        assertEq(vault.freeAssets(), 5e18);
        uint256 ask1 = vault.quote(call190, 1e18, true);
        uint256 bid1 = vault.quote(call190, 1e18, false);
        assertGt(ask1, ask0);
        assertGt(bid1, bid0);

        _buy(vault, call190w2, 5e18); // fully locked
        assertGt(vault.quote(call190, 1e18, true), ask1);
    }

    function test_weekendQuoteHigher() public {
        CoveredCallVault flat = _newCoveredCall(_flatConfig());
        _vaultDeposit(vault, alice, 10e18);
        _vaultDeposit(flat, alice, 10e18);
        // Wednesday, REGULAR session: no session add, identical quotes
        assertEq(vault.quote(call190w2, 1e18, true), flat.quote(call190w2, 1e18, true));

        vm.warp(SATURDAY);
        assertEq(uint8(hub.session(address(nvda))), uint8(Session.WEEKEND));
        assertTrue(vault.isLive());
        uint256 ask = vault.quote(call190w2, 1e18, true);
        uint256 askFlat = flat.quote(call190w2, 1e18, true);
        assertGt(ask, askFlat);
        assertGt(vault.quote(call190w2, 1e18, false), flat.quote(call190w2, 1e18, false));

        // exactly the WEEKEND vol add on top of the flat vault's vol (utilization after 1 of 10)
        uint256 volFlat = _volQ(0.1e18);
        uint256 tau = e2 - SATURDAY; // not block.timestamp: via-ir may reuse a pre-warp read
        (uint256 pxFlat,,,,) = kernel.bsQuote(180e18, 190e18, tau, volFlat, 0, true);
        (uint256 pxWk,,,,) = kernel.bsQuote(180e18, 190e18, tau, volFlat + WEEKEND_ADD, 0, true);
        assertEq(askFlat, F.mulWadUp(pxFlat, 1.02e18));
        assertEq(ask, F.mulWadUp(pxWk, 1.02e18));
    }

    // ================================================================ live gate

    function test_haltedVaultRejectsDeposit() public {
        uint256 shares = _vaultDeposit(vault, alice, 10e18);
        _buy(vault, call190, 2e18);
        assertGt(vault.maxWithdraw(alice), 0);
        nvda.mint(bob, 1e18);
        vm.prank(bob);
        nvda.approve(address(vault), 1e18);

        vm.warp(block.timestamp + STALE); // feed stale: the hub reports HALTED
        assertFalse(vault.isLive());
        assertEq(vault.maxDeposit(bob), 0);
        assertEq(vault.maxMint(bob), 0);
        assertEq(vault.maxWithdraw(alice), 0);
        assertEq(vault.maxRedeem(alice), 0);

        vm.startPrank(bob);
        vm.expectRevert(OptionVaultBase.VaultNotLive.selector);
        vault.deposit(1e18, bob);
        vm.expectRevert(OptionVaultBase.VaultNotLive.selector);
        vault.mint(1e24, bob);
        vm.stopPrank();
        vm.startPrank(alice);
        vm.expectRevert(OptionVaultBase.VaultNotLive.selector);
        vault.withdraw(1e18, alice, alice);
        vm.expectRevert(OptionVaultBase.VaultNotLive.selector);
        vault.redeem(1e24, alice, alice);
        vm.stopPrank();
        vm.startPrank(taker);
        vm.expectRevert(OptionVaultBase.VaultNotLive.selector);
        vault.buy(call190, 1e18, type(uint256).max, takerId);
        vm.expectRevert(OptionVaultBase.VaultNotLive.selector);
        vault.sellBack(call190, 1e18, 0, takerId);
        vm.stopPrank();
        vm.expectRevert(OptionVaultBase.VaultNotLive.selector);
        vault.quote(call190, 1e18, true);

        // redemption requests still queue while halted
        vm.prank(alice);
        vault.requestRedeem(shares / 10, alice);
        assertEq(vault.escrowedShares(), shares / 10);

        // a fresh round brings the vault back
        _setPrice(address(nvda), 180e18);
        assertTrue(vault.isLive());
        assertEq(vault.maxDeposit(bob), type(uint256).max);
        vm.prank(bob);
        vault.deposit(1e18, bob);

        // an implausible print (spot reverts) halts it as well
        _setPrice(address(nvda), 2500e18);
        assertFalse(vault.isLive());
        assertEq(vault.maxDeposit(bob), 0);
    }

    // ================================================================ exits

    function test_withdrawOnlyFreeAssets() public {
        _vaultDeposit(vault, alice, 10e18);
        _buy(vault, call190, 6e18);
        assertEq(vault.freeAssets(), 4e18);
        // alice owns every share and her NAV exceeds 10 tokens, but only the free 4 can leave now
        assertGt(vault.previewRedeem(vault.balanceOf(alice)), 10e18);
        assertEq(vault.maxWithdraw(alice), 4e18);
        uint256 maxR = vault.maxRedeem(alice);
        assertLt(maxR, vault.balanceOf(alice));
        assertLe(vault.previewRedeem(maxR), 4e18);

        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxWithdraw.selector, alice, 4e18 + 1, 4e18));
        vault.withdraw(4e18 + 1, alice, alice);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxRedeem.selector, alice, maxR + 1, maxR));
        vault.redeem(maxR + 1, alice, alice);
        vault.withdraw(4e18, alice, alice);
        vm.stopPrank();

        assertEq(nvda.balanceOf(alice), 4e18);
        assertEq(ch.collateralOf(vid, address(nvda)), 6e18);
        assertEq(vault.freeAssets(), 0);
        assertEq(vault.maxWithdraw(alice), 0);
        assertEq(vault.maxRedeem(alice), 0);
    }

    function test_sellBackReducesShort() public {
        _vaultDeposit(vault, alice, 10e18);
        _buy(vault, call190, 5e18);
        uint256 bid = vault.quote(call190, 2e18, false);
        assertLt(bid, vault.quote(call190, 2e18, true));
        uint256 vaultCash = ch.cashOf(vid);
        uint256 takerCash = ch.cashOf(takerId);

        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(OptionVaultBase.PremiumBelowMin.selector, bid, bid + 1));
        vault.sellBack(call190, 2e18, bid + 1, takerId);

        vm.expectEmit(true, true, true, true, address(vault));
        emit OptionVaultBase.SoldBack(taker, takerId, call190, 2e18, bid);
        vm.prank(taker);
        assertEq(vault.sellBack(call190, 2e18, bid, takerId), bid);
        _assertPos(vid, call190, -3e18);
        _assertPos(takerId, call190, 3e18);
        assertEq(ch.cashOf(vid), vaultCash - bid);
        assertEq(ch.cashOf(takerId), takerCash + bid - _takerFee(2e18, 180e18, bid));
        assertEq(vault.lockedAssets(), 3e18);

        // the vault never goes net long
        vm.startPrank(taker);
        vm.expectRevert(abi.encodeWithSelector(OptionVaultBase.ExceedsShort.selector, 3e18 + 1, 3e18));
        vault.sellBack(call190, 3e18 + 1, 0, takerId);
        vm.expectRevert(abi.encodeWithSelector(OptionVaultBase.ExceedsShort.selector, 1e18, 0));
        vault.sellBack(call190w2, 1e18, 0, takerId);
        vm.expectRevert(OptionVaultBase.BadQty.selector);
        vault.sellBack(call190, 0, 0, takerId);
        vault.sellBack(call190, 3e18, 0, takerId);
        vm.stopPrank();
        assertEq(ch.positionsOf(vid).length, 0);
        assertEq(vault.lockedAssets(), 0);
        assertEq(vault.freeAssets(), 10e18);
    }

    function test_inflationAttackMitigated() public {
        address attacker = _user("attacker");
        uint256 aShares = _vaultDeposit(vault, attacker, 1);
        assertEq(aShares, 1e6);
        // stock can't be donated into the vault's clearinghouse account (owner-only deposits)
        nvda.mint(attacker, 100e18);
        vm.startPrank(attacker);
        nvda.approve(address(ch), 100e18);
        vm.expectRevert(CHErrors.DepositNotAllowed.selector);
        ch.deposit(vid, address(nvda), 100e18);
        vm.stopPrank();
        // a transfer to the vault contract itself is not NAV at all
        nvda.mint(address(vault), 50e18);
        assertEq(vault.totalAssets(), 1);

        uint256 vShares = _vaultDeposit(vault, alice, 10e18);
        assertGt(vShares, 0);
        assertGe(vault.previewRedeem(vShares), 10e18 * 9999 / 10_000); // the victim loses < 0.01%
        assertLt(vault.previewRedeem(aShares), 100e18); // the attacker forfeits most of the donation
    }

    // ================================================================ async redemption

    function test_requestRedeemProcessedWhenFlat() public {
        _vaultDeposit(vault, alice, 10e18);
        _vaultDeposit(vault, bob, 10e18);

        vm.expectEmit(true, true, true, true, address(vault));
        emit OptionVaultBase.RedeemRequested(0, 0, alice, carol, 4e24);
        vm.prank(alice);
        assertEq(vault.requestRedeem(4e24, carol), 0);
        vm.prank(bob);
        assertEq(vault.requestRedeem(2e24, bob), 1);
        vm.prank(alice);
        vault.requestRedeem(1e24, carol); // adds to carol's request in the same epoch
        assertEq(vault.balanceOf(address(vault)), 7e24);
        assertEq(vault.escrowedShares(), 7e24);
        assertEq(vault.pendingRedeem(carol), 5e24);
        assertEq(vault.balanceOf(alice), 5e24);

        // no positions, no deficit: the roll pays out at the current NAV
        uint256 assets = vault.convertToAssets(7e24);
        assertEq(assets, 7e18);
        vm.expectEmit(true, true, true, true, address(vault));
        emit OptionVaultBase.Rolled(0, 7e18);
        vault.roll(new uint64[](0));

        assertEq(vault.epoch(), 1);
        assertEq(vault.escrowedShares(), 0);
        assertEq(vault.totalSupply(), 13e24);
        assertEq(vault.totalAssets(), 13e18); // the reserved tokens left the clearinghouse account
        assertEq(nvda.balanceOf(address(vault)), 7e18);
        assertEq(vault.reservedAssets(), 7e18);
        assertEq(vault.redeemable(carol), 5e18);
        assertEq(vault.redeemable(bob), 2e18);
        assertEq(vault.pendingRedeem(carol), 0);

        // anyone may push a claim to its receiver
        vm.expectEmit(true, true, true, true, address(vault));
        emit OptionVaultBase.RedeemClaimed(carol, 5e18);
        vm.prank(alice);
        assertEq(vault.claimRedeemed(carol), 5e18);
        assertEq(nvda.balanceOf(carol), 5e18);
        vm.expectRevert(OptionVaultBase.NothingToClaim.selector);
        vault.claimRedeemed(carol);

        // a later request lands in epoch 1; bob's epoch-0 payout is folded in, not lost
        vm.prank(bob);
        vault.requestRedeem(1e24, bob);
        assertEq(vault.redeemable(bob), 2e18);
        vault.roll(new uint64[](0));
        assertEq(vault.epoch(), 2);
        assertEq(vault.redeemable(bob), 3e18);
        vault.claimRedeemed(bob);
        assertEq(nvda.balanceOf(bob), 3e18);
        assertEq(vault.reservedAssets(), 0);

        // a roll with nothing queued changes nothing
        vault.roll(new uint64[](0));
        assertEq(vault.epoch(), 2);
    }

    function test_requestRedeemValidation() public {
        _vaultDeposit(vault, alice, 1e18);
        vm.startPrank(alice);
        vm.expectRevert(OptionVaultBase.ZeroShares.selector);
        vault.requestRedeem(0, alice);
        vm.expectRevert(OptionVaultBase.ZeroAddress.selector);
        vault.requestRedeem(1, address(0));
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, 1e24, 1e24 + 1));
        vault.requestRedeem(1e24 + 1, alice);
        vm.stopPrank();
        vm.expectRevert(OptionVaultBase.NothingToClaim.selector);
        vault.claimRedeemed(alice);
        // escrowed shares can't be pulled out through the ERC-4626 exits
        vm.prank(alice);
        vault.requestRedeem(1e24, alice);
        vm.prank(bob);
        vm.expectRevert();
        vault.redeem(1, bob, address(vault));
    }

    function test_rollWaitsUntilFreeAssetsCover() public {
        _vaultDeposit(vault, alice, 10e18);
        _buy(vault, call190, 8e18); // 2 tokens free
        vm.prank(alice);
        vault.requestRedeem(5e24, alice); // about 5 tokens

        // an expiry the vault doesn't hold is not settled
        vm.expectCall(address(ch), abi.encodeCall(ch.settleAccount, (vid, e2)), 0);
        vault.roll(_one(e2));
        vault.roll(_one(e));
        assertEq(vault.epoch(), 0);
        assertEq(vault.escrowedShares(), 5e24);

        // buying back the shorts releases the lock: the next roll pays out
        vm.prank(taker);
        vault.sellBack(call190, 8e18, 0, takerId);
        uint256 expected = vault.convertToAssets(5e24);
        vm.expectEmit(true, true, true, true, address(vault));
        emit OptionVaultBase.Rolled(0, expected);
        vault.roll(new uint64[](0));
        assertEq(vault.redeemable(alice), expected);
    }

    function test_rollPaysFromFreeWhileShortsOpen() public {
        _vaultDeposit(vault, alice, 10e18);
        _buy(vault, call190w2, 5e18);
        vm.prank(alice);
        vault.requestRedeem(2e24, alice);

        // the open short doesn't hold the epoch back: 2 tokens fit in the 5 free, at live MTM NAV
        uint256 expected = vault.convertToAssets(2e24);
        assertGt(expected, 2e18); // the premium edge is in NAV
        vm.expectEmit(true, true, true, true, address(vault));
        emit OptionVaultBase.Rolled(0, expected);
        vault.roll(new uint64[](0));
        assertEq(vault.redeemable(alice), expected);
        _assertPos(vid, call190w2, -5e18);
        assertEq(vault.lockedAssets(), 5e18);
        assertEq(ch.collateralOf(vid, address(nvda)), 10e18 - expected);
        assertTrue(ch.accountState(vid).healthy);
    }

    function test_rollWaitsWhileNotLive() public {
        _vaultDeposit(vault, alice, 10e18);
        vm.prank(alice);
        vault.requestRedeem(2e24, alice);
        vm.warp(block.timestamp + STALE);
        vault.roll(new uint64[](0)); // no payout at a stale NAV
        assertEq(vault.epoch(), 0);
        _setPrice(address(nvda), 180e18);
        vault.roll(new uint64[](0));
        assertEq(vault.epoch(), 1);
        assertEq(vault.redeemable(alice), 2e18);
    }

    function test_deficitBlocksExitsAndRoll() public {
        _vaultDeposit(vault, alice, 10e18);
        vm.prank(alice);
        vault.requestRedeem(2e24, alice);
        _cheatDeficitTotal(vid, 1e18); // as if an expiry had left 1 USDG unpaid

        assertEq(vault.totalAssets(), uint256(1799e18) * 1e18 / 180e18); // NAV nets the deficit
        assertEq(vault.maxWithdraw(alice), 0);
        assertEq(vault.maxRedeem(alice), 0);
        vault.roll(new uint64[](0));
        assertEq(vault.epoch(), 0);

        _cheatDeficitTotal(vid, 0); // repaid
        assertGt(vault.maxWithdraw(alice), 0);
        vault.roll(new uint64[](0));
        assertEq(vault.epoch(), 1);
    }

    function test_rollAfterExpiryAttemptsSettlement() public {
        _vaultDeposit(vault, alice, 10e18);
        _buy(vault, call190, 5e18);
        vm.prank(alice);
        vault.requestRedeem(8e24, alice); // more than the 5 free

        vm.warp(e + 1);
        _settleExpiry(address(nvda), e, 180e18);
        vm.expectCall(address(ch), abi.encodeCall(ch.settleAccount, (vid, e)));
        vault.roll(_one(e)); // never reverts on a clearinghouse that can't settle yet
        if (_settlementAvailable()) {
            assertEq(ch.positionsOf(vid).length, 0);
            assertEq(vault.epoch(), 1);
        } else {
            assertEq(ch.positionsOf(vid).length, 1);
            assertEq(vault.epoch(), 0);
        }
    }

    // ================================================================ expiry cycles (need settlement)

    function test_requestRedeemFulfilledAfterRoll() public {
        _skipWithoutSettlement();
        uint256 aShares = _vaultDeposit(vault, alice, 10e18);
        _vaultDeposit(vault, bob, 10e18);
        _buy(vault, call190, 15e18); // 5 tokens free
        vm.prank(alice);
        vault.requestRedeem(aShares, alice); // over 10 tokens

        vault.roll(_one(e)); // the lock hasn't been released yet
        assertEq(vault.epoch(), 0);

        // expires out of the money
        vm.warp(e + 1);
        _settleExpiry(address(nvda), e, 180e18);
        uint256 expected = vault.convertToAssets(aShares);
        vm.expectEmit(true, true, true, true, address(vault));
        emit OptionVaultBase.Rolled(0, expected);
        vault.roll(_one(e));

        assertEq(ch.positionsOf(vid).length, 0);
        assertEq(vault.epoch(), 1);
        assertEq(vault.redeemable(alice), expected);
        vault.claimRedeemed(alice);
        assertEq(nvda.balanceOf(alice), expected);
        assertGt(expected, 10e18); // her 10 tokens plus her half of the kept premium
    }

    function test_itmExpiryDeficitPath() public {
        _skipWithoutSettlement();
        DeficitSaleRecorder ah = new DeficitSaleRecorder();
        ch.bindAuctionHouse(address(ah));
        usdg.mint(address(insurance), 10_000 * USDG);

        _vaultDeposit(vault, alice, 10e18);
        _buy(vault, call190, 5e18);
        vm.prank(alice);
        vault.requestRedeem(2e24, alice);

        // settles at 220: the 5 calls owe 150, far more than the premium cash
        vm.warp(e + 1);
        _settleExpiry(address(nvda), e, 220e18);
        uint256 cash = ch.cashOf(vid);
        uint256 nav = vault.totalAssets();
        assertEq(nav, (cash + 10 * 220e18 - 150e18) * 1e18 / 220e18); // the loss is in NAV already

        vault.roll(_one(e)); // settles; the shortfall is bridged by insurance -> deficit
        (uint256 deficit,,) = ch.deficitOf(vid, e);
        // the fund bridges whole USDG units: the shortfall rounded up to one
        assertEq(deficit, (150e18 - cash + 1e12 - 1) / 1e12 * 1e12);
        assertEq(ah.calls(), 1);
        assertEq(ch.positionsOf(vid).length, 0);
        assertEq(vault.epoch(), 0); // waits for the deficit
        // NAV unchanged by settling, less that sub-unit rounding (< 1e12 wei USD at 220)
        assertLe(vault.totalAssets(), nav);
        assertApproxEqAbs(vault.totalAssets(), nav, 1e10);
        assertEq(vault.maxWithdraw(alice), 0);

        // auction proceeds repay the bridge (a bidder's payment credited to the vault account)
        address bidder = _user("bidder");
        _deposit(bidder, vid, address(usdg), deficit / 1e12 + 1);
        vm.prank(address(ah));
        ch.applyDeficitProceeds(vid, e);
        (deficit,,) = ch.deficitOf(vid, e);
        assertEq(deficit, 0);

        vault.roll(_one(e));
        assertEq(vault.epoch(), 1);
        assertGt(vault.redeemable(alice), 0);
    }
}
