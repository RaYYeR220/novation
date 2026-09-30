// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Fixture} from "../utils/Fixture.sol";
import {CHS, CHErrors} from "../../src/core/ClearinghouseStorage.sol";
import {Clearinghouse} from "../../src/core/Clearinghouse.sol";
import {IClearinghouse, AgentPolicy, AccountState, TradeParams} from "../../src/interfaces/IClearinghouse.sol";
import {IRiskKernel} from "../../src/interfaces/IRiskKernel.sol";
import {IRiskParams, UnderlyingParams, GlobalParams} from "../../src/interfaces/IRiskParams.sol";
import {IMarketDataHub} from "../../src/interfaces/IMarketDataHub.sol";
import {ISeriesRegistry} from "../../src/interfaces/ISeriesRegistry.sol";
import {IInsuranceFund} from "../../src/interfaces/IInsuranceFund.sol";
import {MockStockToken} from "../../src/mocks/MockStockToken.sol";
import {MarketDataHub} from "../../src/core/MarketDataHub.sol";
import {FixedPointMath as F} from "../../src/libraries/FixedPointMath.sol";
import {NyseCalendar} from "../../src/libraries/NyseCalendar.sol";
import {
    Position,
    Series,
    Session,
    KParams,
    KUnderlying,
    KPosition,
    KMarginOut,
    MAX_POSITIONS
} from "../../src/types/Types.sol";

/// @notice Test-only stock token that burns 1% of every transfer (fee-on-transfer).
contract FeeOnTransferToken is MockStockToken {
    constructor() MockStockToken("Fee Stock", "FEE") {}

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}

contract ClearinghouseAccountsTest is Fixture {
    // Golden shock ranges: an independent integer evaluation (Python) of
    //   min(0.9, max(minShock, shockK * vol * sqrt(horizonDays / 365)) * sessionMult)
    // with the fixture defaults (shockK 3, minShock 0.1, horizon 2 days). Mark vol right after
    // initVol is sqrt(r2 / dt) of the volCap prior: exactly 1.5 for NVDA, 0.79999999999999990 for
    // SPY (r2 truncation); once pokeVol is older than volStaleness it falls back to volCap exactly.
    uint256 constant SPY_FRESH_VOL = 799999999999999908;
    uint256 constant NVDA_SHOCK_REGULAR = 333104944588922349; // vol 1.5, x1
    uint256 constant NVDA_SHOCK_EXTENDED = 399725933506706818; // x1.2
    uint256 constant NVDA_SHOCK_WEEKEND = 582933653030614110; // x1.75
    uint256 constant NVDA_SHOCK_HALTED = 832762361472305872; // x2.5
    uint256 constant SPY_SHOCK_REGULAR = 177655970447425230; // fresh vol, x1
    uint256 constant SPY_SHOCK_EXTENDED = 213187164536910276; // fresh vol, x1.2
    uint256 constant SPY_SHOCK_WEEKEND = 310897948282994189; // stale vol -> volCap 0.8, x1.75 (also HOLIDAY)
    uint256 constant NVDA_SHOCK_HOLIDAY = 666209889177844698; // stale vol -> volCap 1.5, x2 (test override)

    uint256 constant SAT = T0 + 3 days; // 2026-09-26 Sat 14:00 UTC, WEEKEND
    uint256 constant WED_EVENING = T0 + 7 hours; // 2026-09-23 Wed 17:00 EDT, EXTENDED
    uint256 constant THANKSGIVING = 1_795_705_200; // 2026-11-26 Thu 15:00 UTC (10:00 EST), HOLIDAY

    address alice;
    address bob;

    function setUp() public override {
        super.setUp();
        alice = _user("alice");
        bob = _user("bob");
    }

    // ================================================================ accounts

    function test_createSubaccountIdsIncrement() public {
        vm.expectEmit(true, true, false, false, address(ch));
        emit IClearinghouse.SubaccountCreated(1, alice);
        uint256 a1 = _newAccount(alice);
        uint256 b1 = _newAccount(bob);
        uint256 a2 = _newAccount(alice);

        assertEq(a1, 1);
        assertEq(b1, 2);
        assertEq(a2, 3);
        assertEq(ch.ownerOf(a1), alice);
        assertEq(ch.ownerOf(b1), bob);
        assertEq(ch.ownerOf(a2), alice);
        assertEq(ch.ownerOf(4), address(0));

        uint256[] memory owned = ch.subaccountsOf(alice);
        assertEq(owned.length, 2);
        assertEq(owned[0], 1);
        assertEq(owned[1], 3);
        assertEq(ch.subaccountsOf(bob).length, 1);
        assertEq(ch.cashIndex(), 1e18);
    }

    // ================================================================ deposits

    function test_depositUsdgCreditsWad() public {
        uint256 id = _newAccount(alice);
        // anyone may deposit into any existing account
        usdg.mint(bob, 1_234_567);
        vm.startPrank(bob);
        usdg.approve(address(ch), 1_234_567);
        vm.expectEmit(true, true, false, true, address(ch));
        emit IClearinghouse.Deposited(id, address(usdg), 1_234_567e12);
        ch.deposit(id, address(usdg), 1_234_567);
        vm.stopPrank();

        assertEq(ch.cashOf(id), 1_234_567e12);
        assertEq(usdg.balanceOf(address(ch)), 1_234_567);
        assertEq(usdg.balanceOf(bob), 0);
        AccountState memory st = ch.accountState(id);
        assertEq(st.cash, 1_234_567e12);
        assertEq(st.equity, 1_234_567e12);
    }

    function test_depositStockCollateral() public {
        uint256 id = _newAccount(alice);
        nvda.mint(bob, 5e18);
        vm.startPrank(bob);
        nvda.approve(address(ch), 5e18);
        vm.expectEmit(true, true, false, true, address(ch));
        emit IClearinghouse.Deposited(id, address(nvda), 5e18);
        ch.deposit(id, address(nvda), 5e18);
        vm.stopPrank();

        assertEq(ch.collateralOf(id, address(nvda)), 5e18);
        assertEq(nvda.balanceOf(address(ch)), 5e18);
        assertEq(ch.cashOf(id), 0);

        vm.expectEmit(true, true, false, true, address(ch));
        emit IClearinghouse.Withdrawn(id, address(nvda), 2e18, alice);
        vm.prank(alice);
        ch.withdraw(id, address(nvda), 2e18, alice);
        assertEq(ch.collateralOf(id, address(nvda)), 3e18);
        assertEq(nvda.balanceOf(alice), 2e18);

        vm.expectRevert(abi.encodeWithSelector(CHErrors.InsufficientCollateral.selector, id, address(nvda), 3e18, 4e18));
        vm.prank(alice);
        ch.withdraw(id, address(nvda), 4e18, alice);
    }

    function test_depositRejectsUnknownToken() public {
        uint256 id = _newAccount(alice);
        MockStockToken rogue = new MockStockToken("Rogue", "RGE");
        rogue.mint(alice, 1e18);
        spy.mint(alice, 1e18);
        usdg.mint(alice, 1e6);

        vm.startPrank(alice);
        rogue.approve(address(ch), 1e18);
        spy.approve(address(ch), 1e18);
        usdg.approve(address(ch), 1e6);

        vm.expectRevert(abi.encodeWithSelector(CHErrors.TokenNotAllowed.selector, address(rogue)));
        ch.deposit(id, address(rogue), 1e18);

        vm.expectRevert(abi.encodeWithSelector(CHErrors.UnknownAccount.selector, 999));
        ch.deposit(999, address(usdg), 1e6);

        vm.expectRevert(CHErrors.ZeroAmount.selector);
        ch.deposit(id, address(usdg), 0);
        vm.stopPrank();

        // a disabled underlying is not accepted as collateral either
        UnderlyingParams memory p = params.underlying(address(spy));
        p.enabled = false;
        params.setUnderlying(address(spy), p);
        vm.expectRevert(abi.encodeWithSelector(CHErrors.TokenNotAllowed.selector, address(spy)));
        vm.prank(alice);
        ch.deposit(id, address(spy), 1e18);
    }

    // ================================================================ withdrawals

    function test_withdrawOnlyOwner() public {
        uint256 id = _fund(alice, 100 * USDG, 1e18);
        address agent = _user("agent");
        vm.prank(alice);
        ch.grantAgent(id, agent, _policy(1 days));

        vm.expectRevert(abi.encodeWithSelector(CHErrors.NotOwner.selector, id, bob));
        vm.prank(bob);
        ch.withdraw(id, address(usdg), 1, bob);

        // an authorised agent still can't withdraw
        vm.expectRevert(abi.encodeWithSelector(CHErrors.NotOwner.selector, id, agent));
        vm.prank(agent);
        ch.withdraw(id, address(nvda), 1, agent);

        // neither the zero address nor the clearinghouse itself (that would strand the funds)
        vm.startPrank(alice);
        vm.expectRevert(CHErrors.InvalidRecipient.selector);
        ch.withdraw(id, address(usdg), 1, address(0));
        vm.expectRevert(CHErrors.InvalidRecipient.selector);
        ch.withdraw(id, address(usdg), 10 * USDG, address(ch));
        vm.expectRevert(CHErrors.InvalidRecipient.selector);
        ch.withdraw(id, address(nvda), 1e18, address(ch));
        vm.stopPrank();
        assertEq(ch.cashOf(id), 100e18);
        assertEq(ch.collateralOf(id, address(nvda)), 1e18);

        vm.expectEmit(true, true, false, true, address(ch));
        emit IClearinghouse.Withdrawn(id, address(usdg), 40e18, bob);
        vm.prank(alice);
        ch.withdraw(id, address(usdg), 40 * USDG, bob);
        assertEq(usdg.balanceOf(bob), 40 * USDG);
        assertEq(ch.cashOf(id), 60e18);
    }

    /// A 6-decimal token plus dust withdrawals never pays out more than the WAD balance.
    function test_withdrawDustRoundsDown() public {
        uint256 id = _fund(alice, 1_000_001, 0);
        assertEq(ch.cashOf(id), 1_000_001e12);

        // 1_000_001 one-unit withdrawals (~76k gas each: this test needs the raised gas_limit)
        vm.startPrank(alice);
        for (uint256 i = 0; i < 1_000_001; ++i) {
            ch.withdraw(id, address(usdg), 1, alice);
        }
        assertEq(ch.cashOf(id), 0);
        assertEq(usdg.balanceOf(alice), 1_000_001);
        assertEq(usdg.balanceOf(address(ch)), 0);

        vm.expectRevert(abi.encodeWithSelector(CHErrors.InsufficientCash.selector, id, 0, 1e12));
        ch.withdraw(id, address(usdg), 1, alice);
        vm.stopPrank();
    }

    /// With a lowered cash index, credits round the account's share down and debits round it up,
    /// so a full withdrawal pays at most what was deposited and leaves < 1 unit of dust.
    function testFuzz_cashIndexRoundsAgainstAccount(uint256 index, uint256 units) public {
        index = bound(index, 1e15, 1e18);
        units = bound(units, 1, 1e13);
        _cheatCashIndex(index);
        uint256 id = _fund(alice, units, 0);

        uint256 wad = units * 1e12;
        uint256 norm = wad * 1e18 / index; // credit: floor
        uint256 cash = ch.cashOf(id);
        assertEq(cash, norm * index / 1e18);
        assertLe(cash, wad);
        assertGe(cash + 1, wad);

        uint256 out = cash / 1e12;
        if (out != 0) {
            vm.prank(alice);
            ch.withdraw(id, address(usdg), out, alice);
            uint256 debitNorm = (out * 1e12 * 1e18 + index - 1) / index; // debit: ceil
            norm -= debitNorm;
        }
        uint256 left = ch.cashOf(id);
        assertEq(left, norm * index / 1e18);
        assertLt(left, 1e12);
        vm.expectRevert(abi.encodeWithSelector(CHErrors.InsufficientCash.selector, id, left, 1e12));
        vm.prank(alice);
        ch.withdraw(id, address(usdg), 1, alice);

        assertLe(usdg.balanceOf(alice), units);
        assertGe(usdg.balanceOf(address(ch)) * 1e12, ch.cashOf(id));
    }

    /// Repeated 1-unit withdrawals at a lowered index can't extract more than was deposited.
    function testFuzz_tinyWithdrawalsNeverExceedDeposit(uint256 index, uint256 units) public {
        index = bound(index, 0.5e18, 1e18);
        units = bound(units, 1, 300);
        _cheatCashIndex(index);
        uint256 id = _fund(alice, units, 0);

        vm.startPrank(alice);
        uint256 steps;
        while (ch.cashOf(id) >= 1e12) {
            ch.withdraw(id, address(usdg), 1, alice);
            ++steps;
        }
        vm.stopPrank();
        assertLe(steps, units);
        assertEq(usdg.balanceOf(alice), steps);
        assertGe(usdg.balanceOf(address(ch)) * 1e12, ch.cashOf(id));
    }

    function test_withdrawBlockedWhenUnhealthy() public {
        uint64 e = _expiry();
        uint32 call180 = _list(address(nvda), e, 180e18, true);
        address dave = _user("dave");
        uint256 buyer = _fund(dave, 1000 * USDG, 0);

        // alice sells one call for 8 USDG (and pays the fee out of it)
        uint256 id = _fund(alice, 1000 * USDG, 0);
        venue.trade(_sale(id, alice, buyer, dave, call180, 8e18));
        AccountState memory st = ch.accountState(id);
        assertTrue(st.healthy);
        assertGt(st.im, 0);
        assertLt(st.mtm, 0);

        // withdrawing the original 1000 leaves only premium - fee against the short: below IM
        AccountState memory after_ = ch.marginAfter(id, 0, 0, -int256(1000e18));
        assertFalse(after_.healthy);
        vm.expectRevert(abi.encodeWithSelector(CHErrors.InsufficientMargin.selector, id, after_.equity, after_.im));
        vm.prank(alice);
        ch.withdraw(id, address(usdg), 1000 * USDG, alice);

        // a withdrawal that keeps equity >= IM goes through
        vm.prank(alice);
        ch.withdraw(id, address(usdg), 900 * USDG, alice);
        assertTrue(ch.accountState(id).healthy);

        // the stock backing a covered call can't be pulled out from under it either
        uint256 cov = _fund(bob, 0, 2e18);
        // dave buys one call from bob, who is the maker here and so pays no fee
        venue.trade(
            TradeParams({
                takerActor: dave,
                makerActor: bob,
                takerId: buyer,
                makerId: cov,
                seriesId: call180,
                qty: 1e18,
                premium: 8e18
            })
        );
        assertTrue(ch.accountState(cov).healthy);
        assertEq(ch.cashOf(cov), 8e18);
        // what `cov` would be after the withdrawal: same cash and short, no stock. A venue would
        // refuse to open that naked short, so the replica's position is seeded directly.
        uint256 naked = _fund(_user("carol"), 8 * USDG, 0);
        _cheatMovePosition(naked, call180, -1e18);
        AccountState memory bare = ch.accountState(naked);
        assertFalse(bare.healthy);
        vm.expectRevert(abi.encodeWithSelector(CHErrors.InsufficientMargin.selector, cov, bare.equity, bare.im));
        vm.prank(bob);
        ch.withdraw(cov, address(nvda), 2e18, bob);
        assertEq(ch.collateralOf(cov, address(nvda)), 2e18);
    }

    function test_withdrawNotBlockedByPause() public {
        uint64 e = _expiry();
        uint32 put170 = _list(address(nvda), e, 170e18, false);
        uint256 plain = _fund(alice, 100 * USDG, 1e18);
        uint256 withPos = _fund(bob, 1000 * USDG, 0);
        _cheatMovePosition(withPos, put170, 1e18);

        vm.prank(GUARDIAN);
        params.pauseOpening();
        assertTrue(params.openingPaused());

        vm.startPrank(alice);
        ch.withdraw(plain, address(usdg), 100 * USDG, alice);
        ch.withdraw(plain, address(nvda), 1e18, alice);
        vm.stopPrank();
        vm.prank(bob);
        ch.withdraw(withPos, address(usdg), 500 * USDG, bob);

        // a HALTED underlying doesn't block withdrawals either (margin uses the halted multiplier)
        nvda.setPaused(true);
        assertEq(uint256(hub.session(address(nvda))), uint256(Session.HALTED));
        vm.prank(bob);
        ch.withdraw(withPos, address(usdg), 400 * USDG, bob);
        assertEq(usdg.balanceOf(bob), 900 * USDG);
    }

    function test_withdrawBlockedInDeficit() public {
        uint256 id = _fund(alice, 100 * USDG, 1e18);
        _cheatDeficitTotal(id, 1);

        vm.startPrank(alice);
        vm.expectRevert(CHErrors.InDeficit.selector);
        ch.withdraw(id, address(usdg), 1, alice);
        vm.expectRevert(CHErrors.InDeficit.selector);
        ch.withdraw(id, address(nvda), 1, alice);
        vm.stopPrank();

        // deposits stay open while in deficit
        _deposit(bob, id, address(usdg), 5 * USDG);
        assertEq(ch.cashOf(id), 105e18);

        _cheatDeficitTotal(id, 0);
        vm.prank(alice);
        ch.withdraw(id, address(usdg), 105 * USDG, alice);
    }

    // ================================================================ agents

    function test_agentAuthorizeAndExpire() public {
        uint256 id = _fund(alice, 100 * USDG, 0);
        address agent = _user("agent");
        AgentPolicy memory p = _policy(1 days);

        assertTrue(ch.isAuthorized(id, alice));
        assertFalse(ch.isAuthorized(id, agent));
        assertFalse(ch.isAuthorized(id, bob));

        vm.expectEmit(true, true, false, true, address(ch));
        emit IClearinghouse.AgentGranted(id, agent, p);
        vm.prank(alice);
        ch.grantAgent(id, agent, p);
        assertTrue(ch.isAuthorized(id, agent));

        AgentPolicy memory got = ch.agentPolicy(id, agent);
        assertEq(got.maxWorstLoss, p.maxWorstLoss);
        assertEq(got.maxPremiumPerTrade, p.maxPremiumPerTrade);
        assertEq(got.allowedMask, p.allowedMask);
        assertEq(got.expiresAt, p.expiresAt);

        // agents may not grant agents
        vm.expectRevert(abi.encodeWithSelector(CHErrors.NotOwner.selector, id, agent));
        vm.prank(agent);
        ch.grantAgent(id, bob, p);

        // valid strictly before expiresAt
        vm.warp(p.expiresAt - 1);
        assertTrue(ch.isAuthorized(id, agent));
        vm.warp(p.expiresAt);
        assertFalse(ch.isAuthorized(id, agent));
        assertTrue(ch.isAuthorized(id, alice));

        // bad grants
        AgentPolicy memory q = _policy(1 hours);
        vm.startPrank(alice);
        vm.expectRevert(CHErrors.InvalidAgent.selector);
        ch.grantAgent(id, alice, q);
        vm.expectRevert(CHErrors.InvalidAgent.selector);
        ch.grantAgent(id, address(0), q);
        q.expiresAt = uint64(block.timestamp);
        vm.expectRevert(CHErrors.InvalidExpiry.selector);
        ch.grantAgent(id, agent, q);
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(CHErrors.NotOwner.selector, id, bob));
        vm.prank(bob);
        ch.grantAgent(id, agent, _policy(1 hours));

        // the zero address is never authorised, even on an account that doesn't exist
        assertFalse(ch.isAuthorized(id, address(0)));
        assertFalse(ch.isAuthorized(999, address(0)));
    }

    function test_revokeAgentImmediate() public {
        uint256 id = _fund(alice, 100 * USDG, 0);
        address agent = _user("agent");
        vm.prank(alice);
        ch.grantAgent(id, agent, _policy(7 days));
        assertTrue(ch.isAuthorized(id, agent));

        vm.expectRevert(abi.encodeWithSelector(CHErrors.NotOwner.selector, id, agent));
        vm.prank(agent);
        ch.revokeAgent(id, agent);

        vm.expectEmit(true, true, false, false, address(ch));
        emit IClearinghouse.AgentRevoked(id, agent);
        vm.prank(alice);
        ch.revokeAgent(id, agent);

        assertFalse(ch.isAuthorized(id, agent));
        assertEq(ch.agentPolicy(id, agent).expiresAt, 0);
        assertEq(ch.agentPolicy(id, agent).maxWorstLoss, 0);
    }

    // ================================================================ margin procedure

    function test_accountStateFastPath() public {
        uint256 id = _fund(alice, 1000 * USDG, 2e18);
        vm.expectCall(address(kernel), abi.encodeWithSelector(IRiskKernel.margin.selector), 0);
        AccountState memory st = ch.accountState(id);

        assertEq(st.cash, 1000e18);
        assertEq(st.mtm, 360e18); // 2 NVDA x 180
        assertEq(st.settledValue, 0);
        assertEq(st.deficit, 0);
        assertEq(st.equity, 1360e18);
        assertEq(st.im, 0);
        assertEq(st.mm, 0);
        assertTrue(st.healthy);
        assertFalse(st.liquidatable);

        AccountState memory empty = ch.accountState(_newAccount(bob));
        assertEq(empty.equity, 0);
        assertTrue(empty.healthy);
    }

    /// A deficit disables the fast path: the collateral's own downside then counts toward IM.
    function test_accountStateDeficitUsesKernel() public {
        uint256 id = _fund(alice, 1000 * USDG, 2e18);
        _cheatDeficitTotal(id, 100e18);
        AccountState memory st = _assertMatchesDirect(id, _addrs(address(nvda)), _nums(NVDA_SHOCK_REGULAR));
        assertEq(st.deficit, 100e18);
        assertEq(st.equity, 1260e18);
        assertGt(st.im, 0);
    }

    function test_accountStateMatchesKernelDirect() public {
        uint64 e1 = _expiry();
        uint64 e2 = uint64(NyseCalendar.nextWeeklyExpiry(e1));
        uint32 c180 = _list(address(nvda), e1, 180e18, true);
        uint32 p170 = _list(address(nvda), e2, 170e18, false);
        uint32 sc600 = _list(address(spy), e2, 600e18, true);
        uint32 sp590 = _list(address(spy), e1, 590e18, false);

        uint256 id = _fund(alice, 5000 * USDG, 3e18);
        _cheatMovePosition(id, sc600, -1.5e18); // SPY position first: NVDA still comes first (collateral)
        _cheatMovePosition(id, c180, 2e18);
        _cheatMovePosition(id, p170, -1e18);
        _cheatMovePosition(id, sp590, 0.5e18);

        assertEq(hub.markVol(address(nvda)), 1.5e18);
        assertEq(hub.markVol(address(spy)), SPY_FRESH_VOL);
        address[] memory order = _addrs(address(nvda), address(spy));
        uint256[] memory shocks = _nums(NVDA_SHOCK_REGULAR, SPY_SHOCK_REGULAR);
        AccountState memory st = _assertMatchesDirect(id, order, shocks);
        assertTrue(st.healthy);

        (KParams memory kp, KUnderlying[] memory ku, KPosition[] memory kpos,) = _directInput(id, order, shocks);
        assertEq(ch.scenarioGrid(id), kernel.scenarioGrid(kp, ku, kpos));
    }

    function test_accountStateSessionMultipliers() public {
        uint64 e2 = uint64(NyseCalendar.nextWeeklyExpiry(_expiry()));
        uint32 nc = _list(address(nvda), e2, 180e18, true);
        uint32 sc = _list(address(spy), e2, 600e18, true);
        uint256 id = _fund(alice, 5000 * USDG, 3e18);
        _cheatMovePosition(id, nc, 2e18);
        _cheatMovePosition(id, sc, -1.5e18);
        address[] memory order = _addrs(address(nvda), address(spy));

        uint256 imRegular = _assertMatchesDirect(id, order, _nums(NVDA_SHOCK_REGULAR, SPY_SHOCK_REGULAR)).im;

        vm.warp(WED_EVENING);
        assertEq(uint256(hub.session(address(nvda))), uint256(Session.EXTENDED));
        _assertMatchesDirect(id, order, _nums(NVDA_SHOCK_EXTENDED, SPY_SHOCK_EXTENDED));

        vm.warp(SAT);
        assertEq(uint256(hub.session(address(nvda))), uint256(Session.WEEKEND));
        assertEq(uint256(hub.session(address(spy))), uint256(Session.WEEKEND));
        uint256 imWeekend = _assertMatchesDirect(id, order, _nums(NVDA_SHOCK_WEEKEND, SPY_SHOCK_WEEKEND)).im;
        assertGt(imWeekend, imRegular);

        nvda.setPaused(true);
        assertEq(uint256(hub.session(address(nvda))), uint256(Session.HALTED));
        uint256 imHalted = _assertMatchesDirect(id, order, _nums(NVDA_SHOCK_HALTED, SPY_SHOCK_WEEKEND)).im;
        assertGt(imHalted, imWeekend);
    }

    function test_accountStateHolidayMultiplier() public {
        // Thanksgiving 2026-11-26, 10:00 EST. NVDA gets a holiday multiplier distinct from its
        // weekend one, so a WEEKEND/HOLIDAY mix-up can't pass.
        UnderlyingParams memory pn = params.underlying(address(nvda));
        pn.multHoliday = 2e18;
        params.setUnderlying(address(nvda), pn);
        vm.warp(THANKSGIVING);
        _setPrice(address(nvda), 180e18);
        _setPrice(address(spy), 600e18);
        assertEq(uint256(hub.session(address(nvda))), uint256(Session.HOLIDAY));
        assertEq(uint256(hub.session(address(spy))), uint256(Session.HOLIDAY));

        uint64 e = _expiry(); // Friday 2026-11-27, early close
        uint32 nc = _list(address(nvda), e, 180e18, true);
        uint32 sc = _list(address(spy), e, 600e18, false);
        uint256 id = _fund(alice, 5000 * USDG, 1e18);
        _cheatMovePosition(id, nc, -1e18);
        _cheatMovePosition(id, sc, 1e18);
        _assertMatchesDirect(id, _addrs(address(nvda), address(spy)), _nums(NVDA_SHOCK_HOLIDAY, SPY_SHOCK_WEEKEND));
    }

    function test_shockRangeFloorAndCap() public {
        UnderlyingParams memory pn = params.underlying(address(nvda));
        pn.multWeekend = 4e18; // 0.333 x 4 > 0.9 -> capped
        params.setUnderlying(address(nvda), pn);
        UnderlyingParams memory ps = params.underlying(address(spy));
        ps.volCap = 0.2e18; // 3 x 0.2 x 0.074 = 0.044 < minShock 0.1 -> floored
        params.setUnderlying(address(spy), ps);
        assertEq(hub.markVol(address(spy)), 0.2e18);

        uint64 e2 = uint64(NyseCalendar.nextWeeklyExpiry(_expiry()));
        uint32 nc = _list(address(nvda), e2, 180e18, false);
        uint32 sc = _list(address(spy), e2, 600e18, false);
        uint256 id = _fund(alice, 5000 * USDG, 0);
        _cheatMovePosition(id, nc, -1e18);
        _cheatMovePosition(id, sc, -1e18);
        address[] memory order = _addrs(address(nvda), address(spy));

        _assertMatchesDirect(id, order, _nums(NVDA_SHOCK_REGULAR, 0.1e18));
        vm.warp(SAT);
        _assertMatchesDirect(id, order, _nums(0.9e18, 0.175e18)); // floor applies before the multiplier
    }

    function test_settledValueRoundsAgainstShort() public {
        uint64 e = _expiry();
        uint32 call180 = _list(address(nvda), e, 180e18, true);
        uint32 put190 = _list(address(nvda), e, 190e18, false);
        uint32 put175 = _list(address(nvda), e, 175e18, false); // expires OTM
        uint256 a = _fund(alice, 1000 * USDG, 0);
        uint256 b = _fund(bob, 1000 * USDG, 0);
        _cheatMovePosition(a, call180, 1e18 + 1);
        _cheatMovePosition(b, call180, -(1e18 + 1));
        _cheatMovePosition(a, put190, 2e18 + 1);
        _cheatMovePosition(b, put190, -(2e18 + 1));
        _cheatMovePosition(a, put175, 1e18);
        _cheatMovePosition(b, put175, -1e18);

        vm.warp(e - 60);
        _setPrice(address(nvda), 185.5e18);
        vm.warp(e + 1 hours);

        // expired but not yet settled: still in the kernel, at intrinsic value on the live spot
        AccountState memory la = ch.accountState(a);
        assertEq(la.settledValue, 0);
        assertEq(la.mtm, 14.5e18 + 9); // kernel truncation: floor(5.5e18+5.5) + floor(9e18+4.5)

        _settleExpiry(address(nvda), e, 185.5e18);

        // call: payoff 5.5 x (1e18+1) = 5.5e18 + 5.5 ; put: 4.5 x (2e18+1) = 9e18 + 4.5
        la = ch.accountState(a);
        AccountState memory lb = ch.accountState(b);
        assertEq(la.settledValue, 5.5e18 + 5 + 9e18 + 4); // long: rounded down
        assertEq(lb.settledValue, -int256(5.5e18 + 6 + 9e18 + 5)); // short: rounded up
        assertEq(la.mtm, 0); // settled positions are out of the kernel
        assertEq(lb.mtm, 0);
        assertEq(la.im, 0);
        assertEq(lb.im, 0);
        assertEq(la.equity, 1000e18 + 14.5e18 + 9);
        assertEq(lb.equity, 1000e18 - 14.5e18 - 11);
        _assertMatchesDirect(a, new address[](0), new uint256[](0));
        _assertMatchesDirect(b, new address[](0), new uint256[](0));
    }

    function test_marginAfterMatchesAppliedState() public {
        uint64 e = _expiry();
        uint32 call180 = _list(address(nvda), e, 180e18, true);
        uint32 put170 = _list(address(nvda), e, 170e18, false);
        uint32 spyCall = _list(address(spy), e, 600e18, true);
        uint256 id = _fund(alice, 2000 * USDG, 1e18);
        _cheatMovePosition(id, call180, 1e18);

        // add a new series + move cash
        AccountState memory what = ch.marginAfter(id, spyCall, -1e18, -100e18);
        _cheatMovePosition(id, spyCall, -1e18);
        vm.prank(alice);
        ch.withdraw(id, address(usdg), 100 * USDG, alice);
        _assertStateEq(what, ch.accountState(id));

        // close an existing series entirely
        what = ch.marginAfter(id, call180, -1e18, 0);
        _cheatMovePosition(id, call180, -1e18);
        _assertStateEq(what, ch.accountState(id));

        // grow an existing series and credit cash
        what = ch.marginAfter(id, spyCall, -2e18, 50e18);
        _cheatMovePosition(id, spyCall, -2e18);
        _deposit(bob, id, address(usdg), 50 * USDG);
        _assertStateEq(what, ch.accountState(id));

        // a pure cash what-if ignores the series id; closing everything virtually is the fast path
        _assertStateEq(ch.marginAfter(id, put170, 0, 0), ch.accountState(id));
        AccountState memory flat = ch.marginAfter(id, spyCall, 3e18, 0);
        assertEq(flat.im, 0);
        assertEq(flat.mtm, 180e18);

        uint256 cash = ch.cashOf(id);
        vm.expectRevert(abi.encodeWithSelector(CHErrors.InsufficientCash.selector, id, cash, cash + 1));
        ch.marginAfter(id, 0, 0, -int256(cash + 1));
    }

    // ================================================================ unpriceable collateral

    function test_depositRejectsUnpriceableCollateral() public {
        uint256 id = _fund(alice, 100 * USDG, 0);
        spy.mint(bob, 3);
        vm.prank(bob);
        spy.approve(address(ch), 3);

        _setPrice(address(spy), 7000e18); // above maxPrice 6000
        vm.expectRevert(MarketDataHub.ImplausiblePrice.selector);
        vm.prank(bob);
        ch.deposit(id, address(spy), 1);

        _setPrice(address(spy), 0); // no usable answer
        vm.expectRevert(MarketDataHub.NoPrice.selector);
        vm.prank(bob);
        ch.deposit(id, address(spy), 1);
        assertEq(ch.collateralTokensOf(id).length, 0);

        // priced but HALTED is still accepted: a deposit only adds collateral
        _setPrice(address(spy), 600e18);
        spy.setPaused(true);
        (,, bool ok) = hub.spot(address(spy));
        assertFalse(ok);
        vm.prank(bob);
        ch.deposit(id, address(spy), 1);
        assertEq(ch.collateralOf(id, address(spy)), 1);
    }

    /// Collateral whose oracle breaks after it was deposited is valued at 0 and left out of the
    /// kernel, so nobody (the owner or a third party who topped it up) can freeze the account.
    function test_unpriceableCollateralValuedAtZero() public {
        uint64 e = _expiry();
        uint32 call180 = _list(address(nvda), e, 180e18, true);
        uint256 id = _fund(alice, 1000 * USDG, 0);
        _deposit(bob, id, address(spy), 1); // third-party dust, accepted while SPY is priced
        _deposit(alice, id, address(spy), 2e18);
        _cheatMovePosition(id, call180, 1e18);
        uint256 idle = _fund(bob, 5 * USDG, 0);
        _deposit(bob, idle, address(spy), 3e18);
        AccountState memory before = ch.accountState(id);

        _setPrice(address(spy), 7000e18);
        vm.expectRevert(MarketDataHub.ImplausiblePrice.selector);
        hub.spot(address(spy));

        // evaluated as if it held no SPY
        AccountState memory st = _assertMatchesDirect(id, _addrs(address(nvda)), _nums(NVDA_SHOCK_REGULAR));
        assertEq(st.mtm, before.mtm - int256(1200e18 + 600)); // SPY was (2e18 + 1) x 600
        (KParams memory kp, KUnderlying[] memory ku, KPosition[] memory kpos,) =
            _directInput(id, _addrs(address(nvda)), _nums(NVDA_SHOCK_REGULAR));
        assertEq(ch.scenarioGrid(id), kernel.scenarioGrid(kp, ku, kpos));

        // fast path: the broken token is worth 0
        AccountState memory idleSt = ch.accountState(idle);
        assertEq(idleSt.mtm, 0);
        assertEq(idleSt.equity, 5e18);
        assertTrue(idleSt.healthy);

        // withdrawals keep working, including of the broken token itself
        vm.startPrank(alice);
        ch.withdraw(id, address(usdg), 1 * USDG, alice);
        ch.withdraw(id, address(spy), 2e18 + 1, alice);
        vm.stopPrank();
        assertEq(ch.collateralTokensOf(id).length, 0);
    }

    /// An underwater account can't hide from liquidation behind a broken-oracle token.
    function test_unpriceableCollateralCannotHideLiquidation() public {
        uint64 e = _expiry();
        uint32 call180 = _list(address(nvda), e, 180e18, true);
        uint256 id = _fund(alice, 100 * USDG, 0);
        _deposit(alice, id, address(spy), 1); // parked while SPY is priced
        _cheatMovePosition(id, call180, -10e18); // naked short 10 calls
        _setPrice(address(nvda), 260e18);
        assertTrue(ch.accountState(id).liquidatable);

        _setPrice(address(spy), 7000e18);
        spy.mint(alice, 1);
        vm.startPrank(alice);
        spy.approve(address(ch), 1);
        vm.expectRevert(MarketDataHub.ImplausiblePrice.selector);
        ch.deposit(id, address(spy), 1);
        vm.stopPrank();

        AccountState memory st = _assertMatchesDirect(id, _addrs(address(nvda)), _nums(NVDA_SHOCK_REGULAR));
        assertTrue(st.liquidatable);
    }

    /// An underlying the account has live option positions on still needs a price.
    function test_unpriceableOptionUnderlyingStillReverts() public {
        uint64 e = _expiry();
        uint32 spyCall = _list(address(spy), e, 600e18, true);
        uint256 id = _fund(alice, 1000 * USDG, 0);
        _deposit(alice, id, address(spy), 1e18);
        _cheatMovePosition(id, spyCall, 1e18);

        _setPrice(address(spy), 7000e18);
        vm.expectRevert(MarketDataHub.ImplausiblePrice.selector);
        ch.accountState(id);
        vm.expectRevert(MarketDataHub.ImplausiblePrice.selector);
        vm.prank(alice);
        ch.withdraw(id, address(usdg), 1 * USDG, alice);
    }

    /// Only the hub's NoPrice / ImplausiblePrice are absorbed. Any other failure of the price
    /// call, including one with empty revert data such as running out of gas, still reverts, so
    /// a caller can't starve the call to make collateral disappear.
    function test_onlyPriceErrorsAreAbsorbed() public {
        uint64 e = _expiry();
        uint32 call180 = _list(address(nvda), e, 180e18, true);
        uint256 id = _fund(alice, 1000 * USDG, 0);
        _deposit(alice, id, address(spy), 1e18);
        _cheatMovePosition(id, call180, 1e18);
        bytes memory spotSpy = abi.encodeWithSelector(IMarketDataHub.spot.selector, address(spy));

        vm.mockCallRevert(address(hub), spotSpy, bytes("boom"));
        vm.expectRevert(bytes("boom"));
        ch.accountState(id);

        vm.mockCallRevert(address(hub), spotSpy, bytes(""));
        vm.expectRevert(bytes(""));
        ch.accountState(id);

        vm.mockCallRevert(address(hub), spotSpy, abi.encodeWithSelector(MarketDataHub.NoPrice.selector));
        _assertMatchesDirect(id, _addrs(address(nvda)), _nums(NVDA_SHOCK_REGULAR));
    }

    function test_depositCreditsBalanceDelta() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        _registerUnderlying(address(fot), "FEE", 100e18, 0.2e18, 1e18, 10e18, 1000e18);
        uint256 id = _newAccount(alice);
        fot.mint(alice, 100e18);

        vm.startPrank(alice);
        fot.approve(address(ch), 100e18);
        vm.expectEmit(true, true, false, true, address(ch));
        emit IClearinghouse.Deposited(id, address(fot), 99e18);
        ch.deposit(id, address(fot), 100e18);
        vm.stopPrank();
        assertEq(fot.balanceOf(address(ch)), 99e18);
        assertEq(ch.collateralOf(id, address(fot)), 99e18);

        // the credited amount is fully backed: withdrawing it empties the clearinghouse exactly
        vm.prank(alice);
        ch.withdraw(id, address(fot), 99e18, alice);
        assertEq(fot.balanceOf(address(ch)), 0);
        assertEq(fot.balanceOf(alice), 98.01e18);
        assertEq(ch.collateralOf(id, address(fot)), 0);
    }

    // ================================================================ ledger caps and bookkeeping

    function test_tooManyUnderlyingsReverts() public {
        uint256 id = _newAccount(alice);
        address[] memory toks = new address[](9);
        toks[0] = address(nvda);
        toks[1] = address(spy);
        for (uint256 i = 2; i < 9; ++i) {
            toks[i] = address(_addUnderlying(string.concat("X", vm.toString(i)), 100e18, 0.2e18, 1e18, 10e18, 1000e18));
        }
        for (uint256 i = 0; i < 8; ++i) {
            _deposit(alice, id, toks[i], 1e18);
        }

        nvda.mint(alice, 1e18); // for a top-up below
        MockStockToken(toks[8]).mint(alice, 1e18);
        vm.startPrank(alice);
        MockStockToken(toks[8]).approve(address(ch), 1e18);
        vm.expectRevert(CHErrors.TooManyUnderlyings.selector);
        ch.deposit(id, toks[8], 1e18);
        vm.stopPrank();

        // topping up a token already held is fine
        _deposit(alice, id, address(nvda), 1e18);
        // emptying a token frees its slot and drops it from the collateral list
        vm.prank(alice);
        ch.withdraw(id, toks[7], 1e18, alice);
        _assertTokens(id, _slice(toks, 0, 7));
        _deposit(alice, id, toks[8], 1e18);

        // option underlyings share the same cap: toks[7] would be a 9th underlying again
        uint64 e = _expiry();
        uint32 onHeld = _list(address(nvda), e, 180e18, true);
        uint32 onNew = _list(toks[7], e, 100e18, true);
        _cheatMovePositionReverts(id, onNew, 1e18, abi.encodeWithSelector(CHErrors.TooManyUnderlyings.selector));
        _cheatMovePosition(id, onHeld, 1e18);
        vm.expectRevert(CHErrors.TooManyUnderlyings.selector);
        ch.marginAfter(id, onNew, 1e18, 0);

        // withdrawing all of a token whose options are still open keeps it in the union
        vm.prank(alice);
        ch.withdraw(id, address(nvda), 2e18, alice);
        assertEq(ch.collateralOf(id, address(nvda)), 0);
        address[] memory left = _slice(toks, 0, 7); // swap-and-pop: the last token (toks[8]) takes slot 0
        left[0] = toks[8];
        _assertTokens(id, left);
        MockStockToken(toks[7]).mint(alice, 1e18);
        vm.startPrank(alice);
        MockStockToken(toks[7]).approve(address(ch), 1e18);
        vm.expectRevert(CHErrors.TooManyUnderlyings.selector);
        ch.deposit(id, toks[7], 1e18);
        vm.stopPrank();

        // closing the last NVDA option releases the slot
        _cheatMovePosition(id, onHeld, -1e18);
        _deposit(alice, id, toks[7], 1e18);
        assertEq(ch.collateralOf(id, toks[7]), 1e18);
    }

    function test_tooManyPositionsReverts() public {
        uint256 id = _newAccount(alice);
        uint32[] memory sids = new uint32[](MAX_POSITIONS + 1);
        uint256 n;
        uint64 e = _expiry();
        while (n <= MAX_POSITIONS) {
            for (uint128 k = 90e18; k <= 270e18 && n <= MAX_POSITIONS; k += 5e18) {
                sids[n++] = _list(address(nvda), e, k, true);
                if (n <= MAX_POSITIONS) sids[n++] = _list(address(nvda), e, k, false);
            }
            e = uint64(NyseCalendar.nextWeeklyExpiry(e));
        }
        for (uint256 i = 0; i < MAX_POSITIONS; ++i) {
            _cheatMovePosition(id, sids[i], 1e18);
        }
        assertEq(ch.positionsOf(id).length, MAX_POSITIONS);

        uint32 extra = sids[MAX_POSITIONS];
        _cheatMovePositionReverts(id, extra, 1e18, abi.encodeWithSelector(CHErrors.TooManyPositions.selector));
        vm.expectRevert(CHErrors.TooManyPositions.selector);
        ch.marginAfter(id, extra, 1e18, 0);

        // resizing an existing position is fine; closing one frees a slot
        _cheatMovePosition(id, sids[0], 1e18);
        _cheatMovePosition(id, sids[0], -2e18);
        _cheatMovePosition(id, extra, 1e18);
        assertEq(ch.positionsOf(id).length, MAX_POSITIONS);
    }

    function test_movePositionBookkeeping() public {
        uint64 e = _expiry();
        uint32 c = _list(address(nvda), e, 180e18, true);
        uint32 p = _list(address(nvda), e, 170e18, false);
        uint256 a = _newAccount(alice);
        uint256 b = _newAccount(bob);

        (int256 o, int256 nq) = _cheatMovePosition(a, c, 2e18);
        assertEq(o, 0);
        assertEq(nq, 2e18);
        _cheatMovePosition(b, c, -2e18);
        _cheatMovePosition(a, p, -1e18);
        _cheatMovePosition(b, p, 1e18);
        assertEq(ch.openInterest(c), 2e18);
        assertEq(ch.openInterest(p), 1e18);
        assertEq(_shortQty(e), 3e18);

        // flip a from long 2 to short 3
        (o, nq) = _cheatMovePosition(a, c, -5e18);
        assertEq(o, 2e18);
        assertEq(nq, -3e18);
        assertEq(ch.openInterest(c), 0);
        assertEq(_shortQty(e), 6e18); // b short 2 + a short 3 + a short put 1

        // b flips to long 3 so the series nets out again
        _cheatMovePosition(b, c, 5e18);
        assertEq(ch.openInterest(c), 3e18);
        assertEq(_shortQty(e), 4e18);

        // closing a's call removes it; the put moves into its slot
        (o, nq) = _cheatMovePosition(a, c, 3e18);
        assertEq(nq, 0);
        Position[] memory pa = ch.positionsOf(a);
        assertEq(pa.length, 1);
        assertEq(pa[0].seriesId, p);
        assertEq(pa[0].qty, -1e18);
        assertEq(_shortQty(e), 1e18);

        // re-opening appends and the moved entry still resolves correctly
        _cheatMovePosition(a, c, 1e18);
        _cheatMovePosition(a, p, 1e18); // closes the put
        pa = ch.positionsOf(a);
        assertEq(pa.length, 1);
        assertEq(pa[0].seriesId, c);
        assertEq(pa[0].qty, 1e18);
        assertEq(ch.openInterest(c), 4e18);
        assertEq(_shortQty(e), 0);
    }

    // ================================================================ setup phase, stubs, layout

    function test_setupPhase() public {
        address v = address(0xBEEF);
        address ah = address(0xA11);

        vm.expectRevert(CHErrors.NotSetupAdmin.selector);
        vm.prank(alice);
        ch.addVenue(v);
        vm.expectRevert(CHErrors.ZeroAddress.selector);
        ch.addVenue(address(0));

        ch.addVenue(v);
        assertTrue(ch.isVenue(v));
        assertTrue(ch.isVenue(address(venue)));
        assertFalse(ch.isVenue(alice));

        vm.expectRevert(CHErrors.AuctionHouseNotBound.selector);
        ch.finalizeSetup();

        vm.expectRevert(CHErrors.NotSetupAdmin.selector);
        vm.prank(alice);
        ch.bindAuctionHouse(ah);
        ch.bindAuctionHouse(ah);
        assertEq(ch.auctionHouse(), ah);
        vm.expectRevert(CHErrors.AlreadyBound.selector);
        ch.bindAuctionHouse(address(0xA12));

        vm.expectRevert(CHErrors.NotSetupAdmin.selector);
        vm.prank(alice);
        ch.finalizeSetup();
        ch.finalizeSetup();
        assertTrue(ch.setupFinalized());

        vm.expectRevert(CHErrors.SetupAlreadyFinalized.selector);
        ch.addVenue(address(0xCAFE));
        vm.expectRevert(CHErrors.SetupAlreadyFinalized.selector);
        ch.finalizeSetup();
    }

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(CHErrors.ZeroAddress.selector);
        new Clearinghouse(IRiskParams(address(0)), hub, registry, kernel, insurance, address(this));
        vm.expectRevert(CHErrors.ZeroAddress.selector);
        new Clearinghouse(params, IMarketDataHub(address(0)), registry, kernel, insurance, address(this));
        vm.expectRevert(CHErrors.ZeroAddress.selector);
        new Clearinghouse(params, hub, ISeriesRegistry(address(0)), kernel, insurance, address(this));
        vm.expectRevert(CHErrors.ZeroAddress.selector);
        new Clearinghouse(params, hub, registry, IRiskKernel(address(0)), insurance, address(this));
        vm.expectRevert(CHErrors.ZeroAddress.selector);
        new Clearinghouse(params, hub, registry, kernel, IInsuranceFund(address(0)), address(this));
        vm.expectRevert(CHErrors.ZeroAddress.selector);
        new Clearinghouse(params, hub, registry, kernel, insurance, address(0));
    }

    function test_hooksNotImplementedYet() public {
        vm.expectRevert(CHErrors.NotImplemented.selector);
        ch.settleAccount(1, 0);
        vm.expectRevert(CHErrors.NotImplemented.selector);
        ch.claim(1, 0);
        vm.expectRevert(CHErrors.NotImplemented.selector);
        ch.socializeRemainder(1, 0);
        vm.expectRevert(CHErrors.NotImplemented.selector);
        ch.transferFraction(1, 2, 0);
        vm.expectRevert(CHErrors.NotImplemented.selector);
        ch.transferCash(1, 2, 0);
        vm.expectRevert(CHErrors.NotImplemented.selector);
        ch.transferCollateral(1, 2, address(nvda), 0);
        vm.expectRevert(CHErrors.NotImplemented.selector);
        ch.chargePenalty(1, 0);
        vm.expectRevert(CHErrors.NotImplemented.selector);
        ch.insurancePay(1, 0);
        vm.expectRevert(CHErrors.NotImplemented.selector);
        ch.applyDeficitProceeds(1, 0);
    }

    function test_storageSlotIsErc7201() public pure {
        bytes32 expected =
            keccak256(abi.encode(uint256(keccak256("novation.storage.Clearinghouse")) - 1)) & ~bytes32(uint256(0xff));
        assertEq(CHS.SLOT, expected);
    }

    // ================================================================ helpers

    function _policy(uint256 ttl) internal view returns (AgentPolicy memory) {
        return AgentPolicy({
            maxWorstLoss: 500e18, maxPremiumPerTrade: 50e18, allowedMask: 1, expiresAt: uint64(block.timestamp + ttl)
        });
    }

    /// @dev The taker (seller) sells one contract of `sid` to the maker for `premium`.
    function _sale(uint256 sellerId, address seller, uint256 buyerId, address buyer_, uint32 sid, uint256 premium)
        internal
        pure
        returns (TradeParams memory)
    {
        return TradeParams({
            takerActor: seller,
            makerActor: buyer_,
            takerId: sellerId,
            makerId: buyerId,
            seriesId: sid,
            qty: -1e18,
            premium: premium
        });
    }

    function _assertTokens(uint256 id, address[] memory expected) internal view {
        address[] memory got = ch.collateralTokensOf(id);
        assertEq(got.length, expected.length, "collateral token count");
        for (uint256 i = 0; i < got.length; ++i) {
            assertEq(got[i], expected[i], "collateral token");
        }
    }

    function _slice(address[] memory a, uint256 from, uint256 to) internal pure returns (address[] memory r) {
        r = new address[](to - from);
        for (uint256 i = from; i < to; ++i) {
            r[i - from] = a[i];
        }
    }

    function _shortQty(uint64 e) internal view returns (uint256 q) {
        (,, q) = ch.pool(e);
    }

    /// @dev Builds the kernel input straight from public views, with the expected underlying order
    /// and golden shock ranges supplied by the test.
    function _directInput(uint256 id, address[] memory order, uint256[] memory shocks)
        internal
        view
        returns (KParams memory kp, KUnderlying[] memory ku, KPosition[] memory kpos, int256 settledValue)
    {
        GlobalParams memory g = params.globals();
        kp = KParams({
            nowTs: block.timestamp,
            rate: int256(g.rate),
            diversificationCredit: g.diversificationCredit,
            shortOptionMinPct: g.shortOptionMinPct
        });
        ku = new KUnderlying[](order.length);
        for (uint256 i = 0; i < order.length; ++i) {
            UnderlyingParams memory p = params.underlying(order[i]);
            (uint256 spot,,) = hub.spot(order[i]);
            ku[i] = KUnderlying({
                spot: spot,
                vol: hub.markVol(order[i]),
                shockRange: shocks[i],
                volUp: p.volUp,
                volDown: p.volDown,
                tokenQty: int256(ch.collateralOf(id, order[i]))
            });
        }
        Position[] memory ps = ch.positionsOf(id);
        kpos = new KPosition[](ps.length);
        uint256 n;
        for (uint256 i = 0; i < ps.length; ++i) {
            Series memory s = registry.series(ps[i].seriesId);
            (uint256 px, bool settled) = registry.settlementPriceOf(s.underlying, s.expiry);
            if (s.expiry <= block.timestamp && settled) {
                uint256 payoff = s.isCall ? (px > s.strike ? px - s.strike : 0) : (s.strike > px ? s.strike - px : 0);
                if (ps[i].qty > 0) {
                    settledValue += int256(uint256(int256(ps[i].qty)) * payoff / 1e18);
                } else {
                    uint256 debt = uint256(-int256(ps[i].qty)) * payoff;
                    settledValue -= int256(debt / 1e18 + (debt % 1e18 == 0 ? 0 : 1));
                }
                continue;
            }
            uint256 ui = type(uint256).max;
            for (uint256 j = 0; j < order.length; ++j) {
                if (order[j] == s.underlying) ui = j;
            }
            require(ui != type(uint256).max, "underlying missing from expected order");
            kpos[n++] = KPosition({u: ui, isCall: s.isCall, expiry: s.expiry, strike: s.strike, qty: ps[i].qty});
        }
        assembly ("memory-safe") {
            mstore(kpos, n)
        }
    }

    function _assertMatchesDirect(uint256 id, address[] memory order, uint256[] memory shocks)
        internal
        view
        returns (AccountState memory got)
    {
        (KParams memory kp, KUnderlying[] memory ku, KPosition[] memory kpos, int256 sv) =
            _directInput(id, order, shocks);
        (KMarginOut memory out,) = kernel.margin(kp, ku, kpos);
        (uint256 deficit,,) = ch.deficitOf(id, 0);

        AccountState memory exp;
        exp.cash = ch.cashOf(id);
        exp.mtm = out.mtm;
        exp.settledValue = sv;
        exp.deficit = deficit;
        exp.equity = int256(exp.cash) + out.mtm + sv - int256(deficit);
        exp.im = out.lossIM;
        exp.mm = F.mulWadUp(out.lossIM, params.globals().mmRatio);
        exp.worstScenario = out.worstScenario;
        exp.healthy = exp.equity >= int256(exp.im);
        exp.liquidatable = exp.equity < int256(exp.mm);

        got = ch.accountState(id);
        _assertStateEq(got, exp);
    }

    function _assertStateEq(AccountState memory a, AccountState memory b) internal pure {
        assertEq(a.cash, b.cash, "cash");
        assertEq(a.mtm, b.mtm, "mtm");
        assertEq(a.settledValue, b.settledValue, "settledValue");
        assertEq(a.deficit, b.deficit, "deficit");
        assertEq(a.equity, b.equity, "equity");
        assertEq(a.im, b.im, "im");
        assertEq(a.mm, b.mm, "mm");
        assertEq(a.worstScenario, b.worstScenario, "worstScenario");
        assertEq(a.healthy, b.healthy, "healthy");
        assertEq(a.liquidatable, b.liquidatable, "liquidatable");
    }

    function _addrs(address a) internal pure returns (address[] memory r) {
        r = new address[](1);
        r[0] = a;
    }

    function _addrs(address a, address b) internal pure returns (address[] memory r) {
        r = new address[](2);
        r[0] = a;
        r[1] = b;
    }

    function _nums(uint256 a) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = a;
    }

    function _nums(uint256 a, uint256 b) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        r[0] = a;
        r[1] = b;
    }
}
