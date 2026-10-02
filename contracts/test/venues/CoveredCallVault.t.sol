// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {VaultFixture, DeficitSaleRecorder} from "./VaultFixture.sol";
import {CHErrors} from "../../src/core/ClearinghouseStorage.sol";
import {AccountState} from "../../src/interfaces/IClearinghouse.sol";
import {GlobalParams} from "../../src/interfaces/IRiskParams.sol";
import {MarketDataHub} from "../../src/core/MarketDataHub.sol";
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
import {NyseCalendar} from "../../src/libraries/NyseCalendar.sol";

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
        bad.minDelta = 0.6e18; // above maxDelta
        vm.expectRevert(OptionVaultBase.BadConfig.selector);
        this.deployCoveredCall(address(nvda), bad);
        bad = _config();
        bad.maxDelta = 1e18 + 1;
        vm.expectRevert(OptionVaultBase.BadConfig.selector);
        this.deployCoveredCall(address(nvda), bad);
        bad = _config();
        bad.minNewSeriesQty = 0.01e18 - 1; // below minTradeQty
        vm.expectRevert(OptionVaultBase.BadConfig.selector);
        this.deployCoveredCall(address(nvda), bad);
        bad = _config();
        bad.minNewSeriesQty = 100e18 + 1; // above maxTradeQty: no series could ever open
        vm.expectRevert(OptionVaultBase.BadConfig.selector);
        this.deployCoveredCall(address(nvda), bad);
        bad = _config();
        bad.minOtm = 1e18;
        vm.expectRevert(OptionVaultBase.BadConfig.selector);
        this.deployCoveredCall(address(nvda), bad);
        bad = _config();
        bad.spread = 1e18;
        vm.expectRevert(OptionVaultBase.BadConfig.selector);
        this.deployCoveredCall(address(nvda), bad);
        bad = _config();
        bad.maxTenorDays = 0;
        vm.expectRevert(OptionVaultBase.BadConfig.selector);
        this.deployCoveredCall(address(nvda), bad);
        bad = _config();
        bad.maxTradeQty = 0.01e18 - 1; // below the clearinghouse's minTradeQty
        vm.expectRevert(OptionVaultBase.BadConfig.selector);
        this.deployCoveredCall(address(nvda), bad);
        bad = _config();
        bad.maxOpenSeries = 0;
        vm.expectRevert(OptionVaultBase.BadConfig.selector);
        this.deployCoveredCall(address(nvda), bad);
        assertEq(c.maxOpenSeries, 24);
        // the asset must be a listed underlying
        vm.expectRevert(OptionVaultBase.BadConfig.selector);
        this.deployCoveredCall(address(usdg), _config());
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
        assertLe(vault.convertToAssets(bShares), 10e18);
        assertGt(vault.convertToAssets(aShares), 10e18); // in value; previewRedeem is the token part

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
        assertLe(vault.convertToAssets(shares), amount); // straight back out at the same NAV: no gain
        assertEq(vault.maxRedeem(bob), 0); // and not at once: the exit cooldown runs first
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(OptionVaultBase.ExitCooldown.selector, bob, _now() + 1 hours));
        vault.redeem(shares, bob, bob);

        _cooldown();
        uint256 preview = vault.previewRedeem(shares);
        uint256 value = vault.convertToAssets(shares);
        (uint256 t, uint256 c) = vault.previewRedeemInKind(shares);
        vm.prank(bob);
        uint256 out = vault.redeem(shares, bob, bob);
        assertEq(out, preview);
        assertEq(out, t);
        // paid in kind: stock plus bob's share of the premium cash, never more than the value
        assertEq(nvda.balanceOf(bob), t);
        assertEq(usdg.balanceOf(bob), c);
        assertLe(t * 180 + c * 1e12, value * 180);
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
        // a new series opens with at least minNewSeriesQty
        vm.expectRevert(OptionVaultBase.BelowMinNewSeries.selector);
        vault.buy(call190, 1e18 - 1, type(uint256).max, takerId);
        vm.stopPrank();
        _buy(vault, call190, 1e18);
        _buy(vault, call190, 0.01e18); // adding to an open series has no such floor

        // the offer band: |delta| at mark vol within [0.05, 0.5]
        uint32 call250 = _list(address(nvda), e, 250e18, true); // a lottery ticket
        uint64 x4 = uint64(NyseCalendar.nextWeeklyExpiry(NyseCalendar.nextWeeklyExpiry(e2)));
        x4 = uint64(NyseCalendar.nextWeeklyExpiry(x4)); // four weeks after e: near-the-money at this vol
        uint32 call190x4 = _list(address(nvda), x4, 190e18, true);
        uint256 dLow = _absDelta(250e18, e);
        uint256 dHigh = _absDelta(190e18, x4);
        assertLt(dLow, 0.05e18);
        assertGt(dHigh, 0.5e18);
        vm.startPrank(taker);
        vm.expectRevert(abi.encodeWithSelector(OptionVaultBase.OutsideOfferBand.selector, dLow));
        vault.buy(call250, 1e18, type(uint256).max, takerId);
        vm.expectRevert(abi.encodeWithSelector(OptionVaultBase.OutsideOfferBand.selector, dHigh));
        vault.buy(call190x4, 1e18, type(uint256).max, takerId);
        vm.stopPrank();

        vm.warp(e);
        _refresh(180e18); // keep the feed and the vol fresh so only the expiry fails
        vm.prank(taker);
        vm.expectRevert(OptionVaultBase.SeriesExpired.selector);
        vault.buy(call190, 1e18, type(uint256).max, takerId);
    }

    function _absDelta(uint256 k, uint64 expiry) internal view returns (uint256) {
        (int256 d,,,) = BlackScholes.greeks(180e18, k, expiry - _now(), hub.markVol(address(nvda)), 0, true);
        return d < 0 ? uint256(-d) : uint256(d);
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
        uint256 tau = e - _now();
        uint256 px = _kernelPx(tau, _volQ(0.7e18));
        assertEq(px, BlackScholes.price(180e18, 190e18, tau, _volQ(0.7e18), 0, true)); // bit-identical
        assertEq(vault.quote(call190, 3e18, true), F.mulWadUp(F.mulWadUp(3e18, px), 1.02e18));

        // bid for 3 of the 4 short: never above the mark NAV carries the short at
        uint256 mark = _kernelPx(e2 - _now(), hub.markVol(address(nvda)));
        assertGt(_kernelPx(e2 - _now(), _volQ(0.1e18)), mark); // the formula alone would pay more
        assertEq(vault.quote(call190w2, 3e18, false), (3e18 * mark / 1e18) * 0.98e18 / 1e18);
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
        _buy(vault, call190, 1e18); // something to bid for
        uint256 ask0 = vault.quote(call190, 1e18, true);
        uint256 bid0 = vault.quote(call190, 1e18, false);
        assertLt(bid0, ask0);
        // the bid is the mark less the spread, whatever the utilization
        uint256 mark = _kernelPx(e - _now(), hub.markVol(address(nvda)));
        assertEq(bid0, (1e18 * mark / 1e18) * 0.98e18 / 1e18);

        _buy(vault, call190w2, 4e18); // half the tokens locked
        assertEq(vault.lockedAssets(), 5e18);
        assertEq(vault.freeAssets(), 5e18);
        uint256 ask1 = vault.quote(call190, 1e18, true);
        assertGt(ask1, ask0);
        assertEq(vault.quote(call190, 1e18, false), bid0);

        _buy(vault, call190w2, 4e18); // 9 of 10 locked
        assertGt(vault.quote(call190, 1e18, true), ask1);
        assertEq(vault.quote(call190, 1e18, false), bid0);
    }

    function test_weekendQuoteHigher() public {
        CoveredCallVault flat = _newCoveredCall(_flatConfig());
        _vaultDeposit(vault, alice, 10e18);
        _vaultDeposit(flat, alice, 10e18);
        // Wednesday, REGULAR session: no session add, identical quotes
        assertEq(vault.quote(call190w2, 1e18, true), flat.quote(call190w2, 1e18, true));

        vm.warp(SATURDAY);
        assertFalse(vault.isLive()); // the vol state is over two days old
        _refresh(180e18);
        assertEq(uint8(hub.session(address(nvda))), uint8(Session.WEEKEND));
        assertTrue(vault.isLive());
        uint256 ask = vault.quote(call190w2, 1e18, true);
        uint256 askFlat = flat.quote(call190w2, 1e18, true);
        assertGt(ask, askFlat);

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
        _cooldown();
        assertGt(vault.maxWithdraw(alice), 0);
        nvda.mint(bob, 1e18);
        vm.prank(bob);
        nvda.approve(address(vault), 1e18);

        vm.warp(_now() + STALE); // feed stale: the hub reports HALTED
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

        // a fresh round brings the vault back: the views wait for it to reach the vol state,
        // which any operation (or anyone) syncs
        _setPrice(address(nvda), 180e18);
        assertFalse(vault.isLive());
        assertEq(vault.maxDeposit(bob), 0);
        hub.syncVol(address(nvda));
        assertTrue(vault.isLive());
        assertEq(vault.maxDeposit(bob), type(uint256).max);
        vm.prank(bob);
        vault.deposit(1e18, bob);

        // an implausible print (spot reverts) halts it as well; the views still answer
        _setPrice(address(nvda), 2500e18);
        assertFalse(vault.isLive());
        assertEq(vault.maxDeposit(bob), 0);
        assertEq(vault.totalAssets(), 0); // the short can't be marked without a price
        assertEq(vault.previewRedeem(1e24), 0);
        vault.previewDeposit(1e18);
        vault.previewMint(1e24);
        vault.previewWithdraw(1e18);
        assertEq(vault.maxWithdraw(alice), 0);
        assertEq(vault.maxRedeem(alice), 0);
    }

    // ================================================================ exits

    function test_withdrawOnlyFreeAssets() public {
        _vaultDeposit(vault, alice, 10e18);
        _buy(vault, call190, 6e18);
        _cooldown();
        assertEq(vault.freeAssets(), 4e18);
        // alice owns every share and her NAV exceeds 10 tokens, but only the free 4 can leave now
        assertGt(vault.convertToAssets(vault.balanceOf(alice)), 10e18);
        assertEq(vault.maxWithdraw(alice), 4e18);
        uint256 maxR = vault.maxRedeem(alice);
        assertLt(maxR, vault.balanceOf(alice));
        assertLe(vault.previewRedeem(maxR), 4e18);

        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxWithdraw.selector, alice, 4e18 + 1, 4e18));
        vault.withdraw(4e18 + 1, alice, alice);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxRedeem.selector, alice, maxR + 1, maxR));
        vault.redeem(maxR + 1, alice, alice);
        uint256 burn = vault.previewWithdraw(4e18);
        (uint256 t, uint256 c) = vault.previewRedeemInKind(burn);
        assertGe(t, 4e18);
        vault.withdraw(4e18, alice, alice);
        vm.stopPrank();

        // exactly 4 tokens, as ERC-4626 withdraw promises, and the USDG part of the shares burned
        assertEq(nvda.balanceOf(alice), 4e18);
        assertEq(usdg.balanceOf(alice), c);
        assertGt(c, 0);
        assertEq(ch.collateralOf(vid, address(nvda)), 6e18);
        assertEq(vault.freeAssets(), 0);
        assertEq(vault.maxWithdraw(alice), 0);
        assertEq(vault.maxRedeem(alice), 0);
    }

    /// Redeeming returns the tokens that actually move, never the exit's value: a router that
    /// forwards the return value can't overpay from someone else's tokens. redeemInKind returns and
    /// bounds both parts.
    function test_inKindExitReturnValues() public {
        uint256 aShares = _vaultDeposit(vault, alice, 10e18);
        _buy(vault, call190w2, 2e18);
        _cooldown();
        assertGt(ch.cashOf(vid), 0);
        uint256 half = aShares / 2;

        // redeem returns the tokens sent; the value is higher by the USDG part
        (uint256 t, uint256 c) = vault.previewRedeemInKind(half);
        assertEq(vault.previewRedeem(half), t);
        assertGt(c, 0);
        uint256 value = vault.convertToAssets(half);
        assertLe(t * 180 + c * 1e12, value * 180);
        assertGt(value, t);
        vm.expectEmit(true, true, true, true, address(vault));
        emit OptionVaultBase.CashLegPaid(alice, c);
        vm.prank(alice);
        assertEq(vault.redeem(half, alice, alice), t);
        assertEq(nvda.balanceOf(alice), t);
        assertEq(usdg.balanceOf(alice), c);

        // both parts, with a minimum on each
        (t, c) = vault.previewRedeemInKind(half / 2);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(OptionVaultBase.BelowMinOut.selector, t, c));
        vault.redeemInKind(half / 2, bob, alice, t + 1, 0);
        vm.expectRevert(abi.encodeWithSelector(OptionVaultBase.BelowMinOut.selector, t, c));
        vault.redeemInKind(half / 2, bob, alice, 0, c + 1);
        (uint256 t2, uint256 c2) = vault.redeemInKind(half / 2, bob, alice, t, c);
        vm.stopPrank();
        assertEq(t2, t);
        assertEq(c2, c);
        assertEq(nvda.balanceOf(bob), t);
        assertEq(usdg.balanceOf(bob), c);
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

    /// The vault never holds a dust short, and one left below minTradeQty by a later increase of
    /// it can still be bought back in full.
    function test_shortBelowRaisedMinimumCanBeBoughtBack() public {
        _vaultDeposit(vault, alice, 10e18);
        _buy(vault, call190, 1e18);
        vm.startPrank(taker);
        // a buyback leaving the vault 0.005 short is refused up front
        vm.expectRevert(abi.encodeWithSelector(CHErrors.DustPosition.selector, vid, -int256(0.005e18)));
        vault.sellBack(call190, 0.995e18, 0, takerId);
        vault.sellBack(call190, 0.95e18, 0, takerId); // the vault keeps 0.05 short
        vm.stopPrank();

        GlobalParams memory g = params.globals();
        g.minTradeQty = 0.1e18;
        params.setGlobals(g);
        _assertPos(vid, call190, -0.05e18);

        vm.prank(taker);
        vault.sellBack(call190, 0.05e18, 0, takerId); // below the new minimum, but it closes both out
        assertEq(ch.positionsOf(vid).length, 0);
        assertEq(ch.positionsOf(takerId).length, 0);
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

    // ================================================================ fix round: exits, liveness, queue, caps

    function test_exitCooldown() public {
        uint256 aShares = _vaultDeposit(vault, alice, 10e18);
        uint256 until = _now() + 1 hours;
        assertEq(vault.lastReceive(alice), _now());
        assertEq(vault.maxWithdraw(alice), 0);
        assertEq(vault.maxRedeem(alice), 0);
        bytes memory cooling = abi.encodeWithSelector(OptionVaultBase.ExitCooldown.selector, alice, until);
        vm.startPrank(alice);
        vm.expectRevert(cooling);
        vault.withdraw(1e18, alice, alice);
        vm.expectRevert(cooling);
        vault.redeem(1e24, alice, alice);
        vm.expectRevert(cooling);
        vault.requestRedeem(1e24, alice);
        vm.stopPrank();

        // one second short, then through
        vm.warp(until - 1);
        assertEq(vault.maxRedeem(alice), 0);
        vm.warp(until);
        assertEq(vault.maxRedeem(alice), aShares);

        // shares moved to a fresh address start a fresh clock there
        vm.prank(alice);
        vault.transfer(bob, 1e24);
        assertEq(vault.lastReceive(bob), until);
        assertEq(vault.maxRedeem(bob), 0);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(OptionVaultBase.ExitCooldown.selector, bob, until + 1 hours));
        vault.redeem(1e24, bob, bob);

        // a dust transfer or a tiny deposit made for alice can't keep her locked
        address griefer = _user("griefer");
        _vaultDeposit(vault, griefer, 1e18);
        vm.prank(griefer);
        vault.transfer(alice, 1);
        nvda.mint(griefer, 1);
        vm.startPrank(griefer);
        nvda.approve(address(vault), 1);
        vault.deposit(1, alice);
        vm.stopPrank();
        assertLt(vault.lastReceive(alice), until - 1 hours + 1);
        assertGt(vault.maxRedeem(alice), 0);
        vm.prank(alice);
        vault.redeem(1e24, alice, alice);
    }

    function test_volMustBeCurrentAndFresh() public {
        _vaultDeposit(vault, alice, 10e18);
        _buy(vault, call190w2, 1e18);
        _cooldown();

        // a new round the vol state hasn't folded in: the views say not live, the operations
        // sync it themselves and go ahead
        _setPrice(address(nvda), 179e18);
        assertFalse(vault.isLive());
        assertEq(vault.maxDeposit(bob), 0);
        assertEq(vault.maxWithdraw(alice), 0);
        vm.expectRevert(OptionVaultBase.VaultNotLive.selector);
        vault.quote(call190w2, 1e18, true);
        (,, uint80 before,,,) = hub.volState(address(nvda));
        _buy(vault, call190w2, 1e18);
        (,, uint80 synced,,,) = hub.volState(address(nvda));
        assertGt(synced, before);
        assertTrue(vault.isLive());

        // more rounds than one sync folds in (64): the operation can't make it current
        for (uint256 i = 1; i <= 65; ++i) {
            vm.warp(_now() + 1);
            _setPrice(address(nvda), 180e18);
        }
        vm.prank(taker);
        vm.expectRevert(OptionVaultBase.VolNotCurrent.selector);
        vault.buy(call190w2, 1e18, type(uint256).max, takerId);
        vm.prank(alice);
        vm.expectRevert(OptionVaultBase.VolNotCurrent.selector);
        vault.withdraw(1e18, alice, alice);
        vm.prank(alice);
        vault.requestRedeem(1e24, alice); // queuing an exit prices nothing: it always works
        assertEq(vault.pendingRedeem(alice), 1e24);
        hub.syncVol(address(nvda)); // anyone can catch it up
        _buy(vault, call190w2, 1e18);

        // no new round for over two days (a weekend): the vol is stale and nothing can refresh it
        vm.warp(uint256(e) - 60); // Friday, a minute before the close
        _refresh(180e18);
        vm.warp(uint256(e) + 2 days + 1); // Sunday afternoon: the price is still usable (WEEKEND)
        assertTrue(hub.session(address(nvda)) != Session.HALTED);
        assertFalse(vault.isLive());
        vm.prank(taker);
        vm.expectRevert(OptionVaultBase.VaultNotLive.selector);
        vault.sellBack(call190w2, 1e18, 0, takerId);
        _setPrice(address(nvda), 180e18); // the next print revives it on the next operation
        vm.prank(taker);
        vault.sellBack(call190w2, 1e18, 0, takerId);
    }

    /// Feed data the hub tolerates but that wouldn't decode as typed (a round id beyond uint80)
    /// reads as "not live" in the vault's views instead of reverting them.
    function test_undecodableRoundIdReadsNotLive() public {
        _vaultDeposit(vault, alice, 10e18);
        uint256 big = uint256(1) << 81;
        vm.mockCall(
            address(feedOf[address(nvda)]),
            abi.encodeWithSelector(feedOf[address(nvda)].latestRoundData.selector),
            abi.encode(big, int256(180e8), _now(), _now(), big)
        );
        (uint256 spot,, bool ok) = hub.spot(address(nvda));
        assertEq(spot, 180e18);
        assertTrue(ok);
        assertFalse(vault.isLive());
        assertEq(vault.maxDeposit(bob), 0);
        assertEq(vault.maxWithdraw(alice), 0);
    }

    /// A feed round the vol can't fold in (here a zero answer) stops every priced vault operation,
    /// but holders can still queue their exit.
    function test_requestRedeemNotBlockedByBadRound() public {
        _vaultDeposit(vault, alice, 10e18);
        _cooldown();
        _setPrice(address(nvda), 0);
        vm.expectRevert(MarketDataHub.InvalidRound.selector);
        hub.syncVol(address(nvda));
        vm.prank(alice);
        vm.expectRevert(MarketDataHub.InvalidRound.selector);
        vault.withdraw(1e18, alice, alice);

        vm.prank(alice);
        vault.requestRedeem(4e24, alice);
        assertEq(vault.pendingRedeem(alice), 4e24);
        assertEq(vault.escrowedShares(), 4e24);
    }

    function test_queueReservedFromCapacityAndFreeAssets() public {
        _vaultDeposit(vault, alice, 10e18);
        _cooldown();
        vm.prank(alice);
        vault.requestRedeem(6e24, alice); // owed 6 tokens
        assertEq(vault.freeAssets(), 4e18);
        assertEq(vault.maxWithdraw(alice), 4e18);

        // a sale can't use the reserved tokens
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(OptionVaultBase.ExceedsCapacity.selector, 10e18 + 1, 10e18));
        vault.buy(call190, 4e18 + 1, type(uint256).max, takerId);
        _buy(vault, call190, 3e18);
        assertLt(vault.freeAssets(), 1e18);

        // nor an instant withdrawal
        uint256 free = vault.freeAssets();
        assertEq(vault.maxWithdraw(alice), free);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxWithdraw.selector, alice, free + 1, free));
        vault.withdraw(free + 1, alice, alice);

        // the roll pays the queue out of what it reserved, in kind
        (uint256 t, uint256 c) = _split(vault.convertToAssets(6e24));
        vault.roll(new uint64[](0));
        assertEq(vault.redeemable(alice), t);
        assertEq(vault.redeemableCash(alice), c);
        assertEq(vault.freeAssets(), 10e18 - 3e18 - t);
    }

    function test_maxOpenSeries() public {
        VaultConfig memory c = _config();
        c.maxOpenSeries = 2;
        CoveredCallVault v = _newCoveredCall(c);
        _vaultDeposit(v, alice, 10e18);
        uint32 call195 = _list(address(nvda), e, 195e18, true);
        _buy(v, call190, 1e18);
        _buy(v, call190w2, 1e18);
        vm.prank(taker);
        vm.expectRevert(OptionVaultBase.TooManySeries.selector);
        v.buy(call195, 1e18, type(uint256).max, takerId);
        _buy(v, call190, 1e18); // more of an open series is fine

        vm.prank(taker);
        v.sellBack(call190w2, 1e18, 0, takerId); // closing one frees a slot
        _buy(v, call195, 1e18);
    }

    function test_sellBackAndDepositBlockedInDeficit() public {
        _vaultDeposit(vault, alice, 10e18);
        _buy(vault, call190, 2e18);
        _cheatDeficitTotal(vid, 1e18);
        vm.prank(taker);
        vm.expectRevert(OptionVaultBase.VaultInDeficit.selector);
        vault.sellBack(call190, 1e18, 0, takerId);
        assertEq(vault.maxDeposit(bob), 0);
        assertEq(vault.maxMint(bob), 0);
        nvda.mint(bob, 1e18);
        vm.startPrank(bob);
        nvda.approve(address(vault), 1e18);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxDeposit.selector, bob, 1e18, 0));
        vault.deposit(1e18, bob);
        vm.stopPrank();
    }

    // ================================================================ async redemption

    function test_requestRedeemProcessedWhenFlat() public {
        _vaultDeposit(vault, alice, 10e18);
        _vaultDeposit(vault, bob, 10e18);
        _cooldown();

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
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OptionVaultBase.ExitCooldown.selector, alice, _now() + 1 hours));
        vault.requestRedeem(1, alice);
        _cooldown();
        vm.startPrank(alice);
        vm.expectRevert(OptionVaultBase.BadReceiver.selector);
        vault.requestRedeem(1, address(vault));
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
        _cooldown();
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
        (uint256 t, uint256 c) = _split(vault.convertToAssets(5e24));
        vm.expectEmit(true, true, true, true, address(vault));
        emit OptionVaultBase.Rolled(0, t);
        vault.roll(new uint64[](0));
        assertEq(vault.redeemable(alice), t);
        assertEq(vault.redeemableCash(alice), c);
    }

    function test_rollPaysFromFreeWhileShortsOpen() public {
        _vaultDeposit(vault, alice, 10e18);
        _buy(vault, call190w2, 5e18);
        _cooldown();
        vm.prank(alice);
        vault.requestRedeem(2e24, alice);

        // the open short doesn't hold the epoch back: 2 tokens fit in the 5 free, at live MTM NAV
        uint256 expected = vault.convertToAssets(2e24);
        assertGt(expected, 2e18); // the premium edge is in NAV
        (uint256 t, uint256 c) = _split(expected);
        vm.expectEmit(true, true, true, true, address(vault));
        emit OptionVaultBase.Rolled(0, t);
        vault.roll(new uint64[](0));
        assertEq(vault.redeemable(alice), t);
        assertEq(vault.redeemableCash(alice), c);
        assertEq(vault.reservedCash(), c);
        assertEq(usdg.balanceOf(address(vault)), c);
        _assertPos(vid, call190w2, -5e18);
        assertEq(vault.lockedAssets(), 5e18);
        assertEq(ch.collateralOf(vid, address(nvda)), 10e18 - t);
        assertTrue(ch.accountState(vid).healthy);
    }

    function test_rollWaitsWhileNotLive() public {
        _vaultDeposit(vault, alice, 10e18);
        _cooldown();
        vm.prank(alice);
        vault.requestRedeem(2e24, alice);
        vm.warp(_now() + STALE);
        vault.roll(new uint64[](0)); // no payout at a stale NAV
        assertEq(vault.epoch(), 0);
        _setPrice(address(nvda), 180e18);
        vault.roll(new uint64[](0));
        assertEq(vault.epoch(), 1);
        assertEq(vault.redeemable(alice), 2e18);
    }

    function test_deficitBlocksExitsAndRoll() public {
        _vaultDeposit(vault, alice, 10e18);
        _cooldown();
        vm.prank(alice);
        vault.requestRedeem(2e24, alice);
        _cheatDeficitTotal(vid, 1e18); // as if an expiry had left 1 USDG unpaid

        assertEq(vault.totalAssets(), uint256(1799e18) * 1e18 / 180e18); // NAV nets the deficit
        assertEq(vault.maxWithdraw(alice), 0);
        assertEq(vault.maxRedeem(alice), 0);
        assertEq(vault.maxDeposit(bob), 0); // no new money into an account that owes
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
        _cooldown();
        vm.prank(alice);
        vault.requestRedeem(8e24, alice); // more than the 5 free

        vm.warp(e + 1);
        _settleExpiry(address(nvda), e, 180e18);
        _pokeVol(address(nvda));
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
        _cooldown();
        vm.prank(alice);
        vault.requestRedeem(aShares, alice); // over 10 tokens

        vault.roll(_one(e)); // the lock hasn't been released yet
        assertEq(vault.epoch(), 0);

        // expires out of the money
        vm.warp(e + 1);
        _settleExpiry(address(nvda), e, 180e18);
        _pokeVol(address(nvda));
        uint256 expected = vault.convertToAssets(aShares);
        assertGt(expected, 10e18); // her 10 tokens plus her half of the kept premium
        uint256 premium = ch.cashOf(vid);
        (uint256 t, uint256 c) = _split(expected);
        vm.expectEmit(true, true, true, true, address(vault));
        emit OptionVaultBase.Rolled(0, t);
        vault.roll(_one(e));

        assertEq(ch.positionsOf(vid).length, 0);
        assertEq(vault.epoch(), 1);
        assertEq(vault.redeemable(alice), t);
        assertEq(vault.redeemableCash(alice), c);
        assertEq(vault.claimRedeemed(alice), t);
        vm.expectEmit(true, true, true, true, address(vault));
        emit OptionVaultBase.CashLegPaid(alice, c);
        assertEq(vault.claimRedeemedCash(alice), c);
        // in kind: her 10 tokens and her half of the premium cash, each rounded down
        assertEq(nvda.balanceOf(alice), t);
        assertEq(usdg.balanceOf(alice), c);
        assertApproxEqAbs(t, 10e18, 2);
        assertLe(t, 10e18);
        assertApproxEqAbs(c, premium / 2 / 1e12, 1);
        assertEq(vault.reservedAssets(), 0);
        assertEq(vault.reservedCash(), 0);
    }

    /// Exits are paid in kind: stock plus the holder's share of the premium cash, so the cash per
    /// share stays put and the last holder takes the last of both (not a pile of USDG it could
    /// never withdraw, as when exits paid stock only).
    function test_exitsPaidInKindUntilTheLastHolder() public {
        _skipWithoutSettlement();
        uint256 aShares = _vaultDeposit(vault, alice, 10e18);
        uint256 bShares = _vaultDeposit(vault, bob, 10e18);
        _buy(vault, call190, 10e18);
        uint256 premium = ch.cashOf(vid);
        assertGt(premium, 0);
        vm.warp(e + 1);
        _settleExpiry(address(nvda), e, 180e18); // out of the money: the premium is kept
        _pokeVol(address(nvda));
        vault.roll(_one(e));
        assertEq(ch.positionsOf(vid).length, 0);
        uint256 supply = vault.totalSupply();
        uint256 cashPerShare = ch.cashOf(vid) * 1e18 / supply;

        // alice leaves first: half the stock, half the cash
        uint256 aValue = vault.convertToAssets(aShares);
        vm.prank(alice);
        uint256 aOut = vault.redeem(aShares, alice, alice);
        assertEq(aOut, nvda.balanceOf(alice));
        assertLe(nvda.balanceOf(alice) * 180 + usdg.balanceOf(alice) * 1e12, aValue * 180);
        assertApproxEqAbs(nvda.balanceOf(alice), 10e18, 2);
        assertApproxEqAbs(usdg.balanceOf(alice), premium / 2 / 1e12, 1);
        // cash per share stays put (a hair up: her legs are rounded down)
        uint256 after_ = ch.cashOf(vid) * 1e18 / vault.totalSupply();
        assertGe(after_, cashPerShare);
        assertApproxEqRel(after_, cashPerShare, 1e12);

        // bob, the last holder, gets the rest of the stock and the rest of the cash
        vm.prank(bob);
        vault.redeem(bShares, bob, bob);
        assertApproxEqAbs(nvda.balanceOf(bob), 10e18, 2);
        assertApproxEqAbs(usdg.balanceOf(bob), premium / 2 / 1e12, 1);
        assertEq(vault.totalSupply(), 0);
        assertLt(ch.collateralOf(vid, address(nvda)), 10); // a few wei of rounding stay behind
        assertLt(ch.cashOf(vid), 2e12); // and less than two USDG units
        assertEq(nvda.balanceOf(alice) + nvda.balanceOf(bob) + ch.collateralOf(vid, address(nvda)), 20e18);
    }

    /// The same for the last holder going through the redemption queue.
    function test_lastHolderQueueGetsTheCash() public {
        _skipWithoutSettlement();
        uint256 aShares = _vaultDeposit(vault, alice, 10e18);
        _buy(vault, call190, 10e18);
        uint256 premium = ch.cashOf(vid);
        _cooldown();
        vm.prank(alice);
        vault.requestRedeem(aShares, alice);
        vault.roll(new uint64[](0)); // every token is locked behind the calls
        assertEq(vault.epoch(), 0);

        vm.warp(e + 1);
        _settleExpiry(address(nvda), e, 180e18);
        _pokeVol(address(nvda));
        vault.roll(_one(e));
        assertEq(vault.epoch(), 1);
        vault.claimRedeemed(alice);
        vault.claimRedeemedCash(alice);
        assertApproxEqAbs(nvda.balanceOf(alice), 10e18, 2);
        assertLe(nvda.balanceOf(alice), 10e18);
        assertApproxEqAbs(usdg.balanceOf(alice), premium / 1e12, 1);
        assertLt(ch.cashOf(vid), 2e12);
        assertEq(vault.reservedCash(), 0);
    }

    /// Between an expiry and the vault's settlement of it, exits wait: an exit then would take
    /// cash an in-the-money call owes its buyer and grow the deficit the holders who stay pay for.
    function test_exitsWaitForExpiredPositionsToSettle() public {
        _skipWithoutSettlement();
        DeficitSaleRecorder ah = new DeficitSaleRecorder();
        ch.bindAuctionHouse(address(ah));
        usdg.mint(address(insurance), 10_000 * USDG);
        _vaultDeposit(vault, alice, 10e18);
        _vaultDeposit(vault, bob, 10e18);
        _buy(vault, call190, 5e18);
        _cooldown();
        vm.prank(alice);
        vault.requestRedeem(5e24, alice);
        assertGt(vault.maxRedeem(bob), 0);

        vm.warp(e + 1);
        _settleExpiry(address(nvda), e, 220e18); // in the money
        _pokeVol(address(nvda));
        assertTrue(vault.isLive());
        assertEq(vault.maxRedeem(bob), 0);
        assertEq(vault.maxWithdraw(bob), 0);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxRedeem.selector, bob, 1e24, 0));
        vault.redeem(1e24, bob, bob);
        vault.roll(new uint64[](0)); // not told to settle e: the queue waits too
        assertEq(vault.epoch(), 0);

        // the roll settles the calls: the vault pays what it can, the fund bridges the rest, and
        // once that is repaid exits and the queue go ahead
        vault.roll(_one(e));
        assertEq(ch.positionsOf(vid).length, 0);
        (uint256 deficit,,) = ch.deficitOf(vid, e);
        _deposit(_user("friend"), vid, address(usdg), deficit / 1e12 + 1);
        vault.roll(new uint64[](0));
        assertEq(vault.epoch(), 1);
        assertGt(vault.maxRedeem(bob), 0);
    }

    /// Entries wait too while the vault holds an expired position not yet settled: NAV marks it at
    /// the current spot, not at the settlement print, so a deposit then (and a settleExpiry in the
    /// same transaction) could take value from the holders.
    function test_depositsWaitForExpiredPositionsToSettle() public {
        _skipWithoutSettlement();
        _vaultDeposit(vault, alice, 10e18);
        _buy(vault, call190, 5e18);
        vm.warp(e + 1);
        _settleExpiry(address(nvda), e, 180e18);
        _pokeVol(address(nvda));
        assertTrue(vault.isLive());
        assertEq(vault.maxDeposit(bob), 0);
        assertEq(vault.maxMint(bob), 0);
        nvda.mint(bob, 10e18);
        vm.startPrank(bob);
        nvda.approve(address(vault), 10e18);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxDeposit.selector, bob, 10e18, 0));
        vault.deposit(10e18, bob);
        vm.stopPrank();

        vault.roll(_one(e)); // settled: entries reopen
        assertEq(vault.maxDeposit(bob), type(uint256).max);
        vm.prank(bob);
        vault.deposit(10e18, bob);
    }

    /// The two parts of a queued exit are claimed on their own: a USDG transfer that fails for the
    /// receiver doesn't hold up its tokens, and the other way round.
    function test_claimLegsAreIndependent() public {
        uint256 aShares = _vaultDeposit(vault, alice, 10e18);
        _buy(vault, call190w2, 2e18);
        _cooldown();
        vm.prank(alice);
        vault.requestRedeem(aShares / 2, alice);
        vault.roll(new uint64[](0));
        uint256 t = vault.redeemable(alice);
        uint256 c = vault.redeemableCash(alice);
        assertGt(t, 0);
        assertGt(c, 0);

        // USDG refuses the receiver: the tokens still go out, the USDG stays claimable
        vm.mockCallRevert(address(usdg), abi.encodeCall(usdg.transfer, (alice, c)), "blocked");
        vm.expectRevert("blocked");
        vault.claimRedeemedCash(alice);
        assertEq(vault.claimRedeemed(alice), t);
        assertEq(nvda.balanceOf(alice), t);
        assertEq(vault.redeemable(alice), 0);
        assertEq(vault.redeemableCash(alice), c);
        assertEq(vault.reservedCash(), c);
        vm.expectRevert(OptionVaultBase.NothingToClaim.selector);
        vault.claimRedeemed(alice);
        vm.clearMockedCalls();
        assertEq(vault.claimRedeemedCash(alice), c);
        assertEq(usdg.balanceOf(alice), c);
        assertEq(vault.reservedAssets(), 0);
        assertEq(vault.reservedCash(), 0);
        vm.expectRevert(OptionVaultBase.NothingToClaim.selector);
        vault.claimRedeemedCash(alice);

        // the stock refuses: the USDG goes out on its own
        vm.prank(alice);
        vault.requestRedeem(aShares / 4, bob);
        vault.roll(new uint64[](0));
        uint256 tb = vault.redeemable(bob);
        uint256 cb = vault.redeemableCash(bob);
        vm.mockCallRevert(address(nvda), abi.encodeCall(nvda.transfer, (bob, tb)), "paused");
        vm.expectRevert("paused");
        vault.claimRedeemed(bob);
        assertEq(vault.claimRedeemedCash(bob), cb);
        assertEq(usdg.balanceOf(bob), cb);
        assertEq(vault.redeemable(bob), tb);
    }

    /// @dev The token and USDG parts of an exit worth `assets` now, as the vault splits it.
    function _split(uint256 assets) internal view returns (uint256 tokens, uint256 cash) {
        uint256 c = ch.cashOf(vid);
        uint256 ta = vault.totalAssets();
        if (c == 0) return (assets, 0);
        (uint256 spot,,) = hub.spot(address(nvda));
        uint256 cashA = Math.mulDiv(c, 1e18, spot, Math.Rounding.Ceil);
        tokens = Math.mulDiv(assets, ta - cashA, ta);
        cash = Math.mulDiv(c, assets, ta) / 1e12;
    }

    function test_itmExpiryDeficitPath() public {
        _skipWithoutSettlement();
        DeficitSaleRecorder ah = new DeficitSaleRecorder();
        ch.bindAuctionHouse(address(ah));
        usdg.mint(address(insurance), 10_000 * USDG);

        _vaultDeposit(vault, alice, 10e18);
        _buy(vault, call190, 5e18);
        _cooldown();
        vm.prank(alice);
        vault.requestRedeem(2e24, alice);

        // settles at 220: the 5 calls owe 150, far more than the premium cash
        vm.warp(e + 1);
        _settleExpiry(address(nvda), e, 220e18);
        _pokeVol(address(nvda));
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

    /// A roll spends the account's cash on its deficit before it decides on the epoch: cash that
    /// reaches a vault in deficit heals it without anyone calling the clearinghouse.
    function test_rollRepaysDeficitFromCash() public {
        _skipWithoutSettlement();
        DeficitSaleRecorder ah = new DeficitSaleRecorder();
        ch.bindAuctionHouse(address(ah));
        usdg.mint(address(insurance), 10_000 * USDG);

        _vaultDeposit(vault, alice, 10e18);
        _buy(vault, call190, 5e18);
        _cooldown();
        vm.prank(alice);
        vault.requestRedeem(2e24, alice);
        vm.warp(e + 1);
        _settleExpiry(address(nvda), e, 220e18);
        _pokeVol(address(nvda));
        vault.roll(_one(e)); // settles: the fund bridges the shortfall, the vault owes it
        (uint256 deficit,,) = ch.deficitOf(vid, e);
        assertGt(deficit, 0);
        assertEq(vault.epoch(), 0);

        // USDG reaches the account (anyone may pay in); the next roll repays the fund and pays out
        _deposit(_user("friend"), vid, address(usdg), deficit / 1e12 + 3 * USDG);
        uint256 fund0 = insurance.balanceWad();
        vault.roll(new uint64[](0));
        (deficit,,) = ch.deficitOf(vid, e);
        assertEq(deficit, 0);
        assertGt(insurance.balanceWad(), fund0);
        assertEq(vault.epoch(), 1);
        assertGt(vault.redeemable(alice), 0);
    }
}
