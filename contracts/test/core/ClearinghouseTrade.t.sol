// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Fixture, TestVenue} from "../utils/Fixture.sol";
import {CHErrors} from "../../src/core/ClearinghouseStorage.sol";
import {IClearinghouse, TradeParams, AgentPolicy, AccountState} from "../../src/interfaces/IClearinghouse.sol";
import {UnderlyingParams, GlobalParams} from "../../src/interfaces/IRiskParams.sol";
import {NyseCalendar} from "../../src/libraries/NyseCalendar.sol";
import {Position, Series, Session, MAX_POSITIONS} from "../../src/types/Types.sol";

contract ClearinghouseTradeTest is Fixture {
    uint64 constant NVDA_MASK = 1; // RiskParams index 0
    uint64 constant SPY_MASK = 2; // RiskParams index 1
    uint256 constant STALE = 93_600 + 1; // maxStaleRegular + 1: the T0 round is too old to trade on

    address alice;
    address bob;
    address carol;
    address agent;
    uint64 e;
    uint32 call180;
    uint32 put170;

    function setUp() public override {
        super.setUp();
        alice = _user("alice");
        bob = _user("bob");
        carol = _user("carol");
        agent = _user("agent");
        e = _expiry();
        call180 = _list(address(nvda), e, 180e18, true);
        put170 = _list(address(nvda), e, 170e18, false);
    }

    // ================================================================ premium, fee, margin

    function test_buyCallMovesPremiumAndFee() public {
        uint256 a = _fund(alice, 1000 * USDG, 0);
        uint256 b = _fund(bob, 1000 * USDG, 0);
        int256 qty = 1.234567e18;
        uint256 premium = 10.5e18;
        // fee = min(ceil(0.0003 * 1.234567 * 180), ceil(0.125 * 10.5)) = min(0.066666618, 1.3125)
        uint256 fee = 66_666_618_000_000_000;

        vm.expectEmit(true, true, true, true, address(ch));
        emit IClearinghouse.Traded(a, b, call180, qty, premium, fee, alice, bob);
        assertEq(venue.trade(_tp(a, alice, b, bob, call180, qty, premium)), fee);

        // the buyer pays premium + fee, the seller receives the premium
        assertEq(ch.cashOf(a), 1000e18 - premium - fee);
        assertEq(ch.cashOf(b), 1000e18 + premium);
        // half the fee (0.033333309) to insurance, the rest to the treasury, each floored to 6 decimals
        assertEq(usdg.balanceOf(address(insurance)), 33_333);
        assertEq(usdg.balanceOf(TREASURY), 33_333);
        assertEq(insurance.balanceWad(), 33_333e12);
        // the sub-unit remainder stays in the clearinghouse on top of all cash
        uint256 held = usdg.balanceOf(address(ch)) * 1e12;
        assertEq(held, 2000e18 - 66_666e12);
        assertEq(held - ch.cashOf(a) - ch.cashOf(b), 618e9);

        _assertPos(a, call180, qty);
        _assertPos(b, call180, -qty);
        assertEq(ch.openInterest(call180), uint256(qty));
    }

    function test_sellFeeCappedByPremium() public {
        GlobalParams memory g = params.globals();
        g.insuranceShare = 0.3e18;
        params.setGlobals(g);
        uint256 a = _fund(alice, 1000 * USDG, 0);
        uint256 b = _fund(bob, 1000 * USDG, 0);
        uint32 put150 = _list(address(nvda), e, 150e18, false);
        uint256 premium = 0.2e18 + 1;
        // the notional fee 0.054 exceeds the cap ceil(0.125 * premium) = 0.025000000000000001
        uint256 fee = 25_000_000_000_000_001;

        vm.expectEmit(true, true, true, true, address(ch));
        emit IClearinghouse.Traded(a, b, put150, -1e18, premium, fee, alice, bob);
        assertEq(venue.trade(_tp(a, alice, b, bob, put150, -1e18, premium)), fee);

        // the taker sells: the maker pays the premium, the taker receives it and pays the fee
        assertEq(ch.cashOf(a), 1000e18 + premium - fee);
        assertEq(ch.cashOf(b), 1000e18 - premium);
        // insuranceShare 0.3: ins = floor(0.3 * fee) = 0.0075 -> 7_500 units to insurance;
        // the rest 0.017500000000000001 -> 17_500 units to the treasury
        assertEq(usdg.balanceOf(address(insurance)), 7_500);
        assertEq(usdg.balanceOf(TREASURY), 17_500);
        _assertPos(a, put150, -1e18);
        _assertPos(b, put150, 1e18);

        // a zero-premium trade pays no fee and moves no tokens
        assertEq(venue.trade(_tp(a, alice, b, bob, put150, 0.5e18, 0)), 0);
        assertEq(usdg.balanceOf(address(insurance)), 7_500);
        assertEq(usdg.balanceOf(TREASURY), 17_500);
        _assertPos(a, put150, -0.5e18);
    }

    function test_sellCallRequiresMargin() public {
        uint256 a = _newAccount(alice); // no cash
        uint256 b = _fund(bob, 1000 * USDG, 0);
        uint256 premium = 8e18;
        uint256 fee = _fee(address(nvda), -1e18, premium);

        // taker sells naked: the premium it receives doesn't cover the short's worst loss
        AccountState memory st = ch.marginAfter(a, call180, -1e18, int256(premium - fee));
        assertLt(st.equity, int256(st.im));
        _expectTradeRevert(
            _tp(a, alice, b, bob, call180, -1e18, premium),
            abi.encodeWithSelector(CHErrors.InsufficientMargin.selector, a, st.equity, st.im)
        );

        // the maker side is checked the same way
        uint256 c = _newAccount(carol);
        AccountState memory sc = ch.marginAfter(c, call180, -1e18, int256(premium));
        assertLt(sc.equity, int256(sc.im));
        _expectTradeRevert(
            _tp(b, bob, c, carol, call180, 1e18, premium),
            abi.encodeWithSelector(CHErrors.InsufficientMargin.selector, c, sc.equity, sc.im)
        );

        // with cash behind it the same short goes through
        _deposit(alice, a, address(usdg), 100 * USDG);
        venue.trade(_tp(a, alice, b, bob, call180, -1e18, premium));
        assertTrue(ch.accountState(a).healthy);
        _assertPos(a, call180, -1e18);
    }

    function test_coveredCallNeedsLessCash() public {
        uint256 cov = _fund(alice, 0, 10e18); // 10 NVDA, no cash
        uint256 naked = _fund(carol, 100 * USDG, 0); // cash, no stock
        uint256 b = _fund(bob, 10_000 * USDG, 0);
        uint256 premium = 80e18;
        uint256 fee = _fee(address(nvda), -10e18, premium);

        AccountState memory n = ch.marginAfter(naked, call180, -10e18, int256(premium - fee));
        _expectTradeRevert(
            _tp(naked, carol, b, bob, call180, -10e18, premium),
            abi.encodeWithSelector(CHErrors.InsufficientMargin.selector, naked, n.equity, n.im)
        );

        venue.trade(_tp(cov, alice, b, bob, call180, -10e18, premium));
        AccountState memory st = ch.accountState(cov);
        assertTrue(st.healthy);
        assertEq(ch.cashOf(cov), premium - fee); // the premium alone pays the fee
        _assertPos(cov, call180, -10e18);
    }

    function test_payerWithoutCashReverts() public {
        uint256 a = _fund(alice, 5 * USDG, 0);
        uint256 b = _fund(bob, 1000 * USDG, 0);
        uint256 fee = _fee(address(nvda), 1e18, 8e18);
        // no cash borrowing: the buyer must hold premium + fee
        _expectTradeRevert(
            _tp(a, alice, b, bob, call180, 1e18, 8e18),
            abi.encodeWithSelector(CHErrors.InsufficientCash.selector, a, 5e18, 8e18 + fee)
        );
        // a maker paying for a put it buys likewise
        _expectTradeRevert(
            _tp(b, bob, a, alice, put170, -1e18, 6e18),
            abi.encodeWithSelector(CHErrors.InsufficientCash.selector, a, 5e18, 6e18)
        );
    }

    // ================================================================ opening rules

    function test_closingTradeAllowedWhenHalted() public {
        uint256 a = _fund(alice, 1000 * USDG, 0);
        uint256 b = _fund(bob, 1000 * USDG, 0);
        uint256 c = _fund(carol, 1000 * USDG, 0);
        _trade(a, b, call180, 1e18, 8e18); // alice long 1, bob short 1

        vm.warp(block.timestamp + STALE); // no fresh round: the feed goes stale
        assertEq(uint256(hub.session(address(nvda))), uint256(Session.HALTED));

        // any opening side is refused
        _expectTradeRevert(
            _tp(c, carol, b, bob, call180, 1e18, 8e18), abi.encodeWithSelector(CHErrors.OpeningNotAllowed.selector, c)
        );
        _expectTradeRevert(
            _tp(a, alice, c, carol, call180, -1e18, 8e18),
            abi.encodeWithSelector(CHErrors.OpeningNotAllowed.selector, c)
        );
        _expectTradeRevert(
            _tp(a, alice, b, bob, call180, 0.5e18, 4e18), abi.encodeWithSelector(CHErrors.OpeningNotAllowed.selector, a)
        );

        // both sides closing goes through
        _trade(a, b, call180, -1e18, 7e18);
        assertEq(ch.positionsOf(a).length, 0);
        assertEq(ch.positionsOf(b).length, 0);
        assertEq(ch.openInterest(call180), 0);
    }

    function test_openingBlockedWhenPaused() public {
        uint256 a = _fund(alice, 1000 * USDG, 0);
        uint256 b = _fund(bob, 1000 * USDG, 0);
        uint256 c = _fund(carol, 1000 * USDG, 0);
        _trade(a, b, call180, 1e18, 8e18);

        vm.prank(GUARDIAN);
        params.pauseOpening();
        _expectTradeRevert(
            _tp(c, carol, b, bob, call180, 1e18, 8e18), abi.encodeWithSelector(CHErrors.OpeningNotAllowed.selector, c)
        );
        _expectTradeRevert(
            _tp(a, alice, c, carol, call180, -0.5e18, 4e18),
            abi.encodeWithSelector(CHErrors.OpeningNotAllowed.selector, c)
        );

        // reducing on both sides is fine while paused
        _trade(a, b, call180, -0.5e18, 4e18);
        _assertPos(a, call180, 0.5e18);
        _assertPos(b, call180, -0.5e18);

        vm.prank(GUARDIAN);
        params.unpauseOpening();
        _trade(c, b, call180, 1e18, 8e18);
        _assertPos(c, call180, 1e18);
    }

    function test_openingBlockedInDeficit() public {
        uint256 a = _fund(alice, 1000 * USDG, 0);
        uint256 b = _fund(bob, 1000 * USDG, 0);
        _trade(a, b, call180, 1e18, 8e18);
        _cheatDeficitTotal(a, 1);

        _expectTradeRevert(
            _tp(a, alice, b, bob, call180, 0.5e18, 4e18), abi.encodeWithSelector(CHErrors.OpeningNotAllowed.selector, a)
        );
        _expectTradeRevert(
            _tp(b, bob, a, alice, put170, 1e18, 3e18), abi.encodeWithSelector(CHErrors.OpeningNotAllowed.selector, a)
        );
        // an account in deficit may still reduce
        _trade(a, b, call180, -1e18, 8e18);
        assertEq(ch.positionsOf(a).length, 0);
    }

    function test_flipCountsAsOpening() public {
        uint256 a = _fund(alice, 1000 * USDG, 0);
        uint256 b = _fund(bob, 1000 * USDG, 0);
        uint256 c = _fund(carol, 1000 * USDG, 0);
        _trade(a, b, call180, 1e18, 8e18); // alice long 1
        _trade(c, b, call180, -2e18, 16e18); // carol short 2

        vm.prank(GUARDIAN);
        params.pauseOpening();
        // long 1 -> short 1 doesn't grow |qty| but opens a short: refused while paused
        // (carol, going from short 2 to flat, is closing)
        _expectTradeRevert(
            _tp(a, alice, c, carol, call180, -2e18, 16e18),
            abi.encodeWithSelector(CHErrors.OpeningNotAllowed.selector, a)
        );
        // long 1 -> short 0.5 likewise, here on the maker side (carol short 2 -> short 0.5 is closing)
        _expectTradeRevert(
            _tp(c, carol, a, alice, call180, 1.5e18, 12e18),
            abi.encodeWithSelector(CHErrors.OpeningNotAllowed.selector, a)
        );
        // a plain close is fine
        _trade(a, c, call180, -1e18, 8e18);
        assertEq(ch.positionsOf(a).length, 0);
        _assertPos(c, call180, -1e18);
    }

    function test_closingAtOffMarketPriceRejected() public {
        (uint256 a, uint256 b) = _underwaterShort();
        AccountState memory pre = ch.accountState(a);
        assertFalse(pre.healthy);

        // buying back 0.5 of the calls at 30 when the mark is ~20.2 hands value to the seller
        uint256 premium = 30e18;
        uint256 fee = _fee(address(nvda), 0.5e18, premium);
        AccountState memory post = ch.marginAfter(a, call180, 0.5e18, -int256(premium + fee));
        assertLt(post.equity, pre.equity);
        assertLt(post.equity, int256(post.im));
        _expectTradeRevert(
            _tp(a, alice, b, bob, call180, 0.5e18, premium),
            abi.encodeWithSelector(CHErrors.InsufficientMargin.selector, a, post.equity, post.im)
        );
        // the same off-market price is fine for an account that stays above IM
        _deposit(alice, a, address(usdg), 200 * USDG);
        venue.trade(_tp(a, alice, b, bob, call180, 0.5e18, premium));
        assertTrue(ch.accountState(a).healthy);
    }

    function test_closingAtMarkAllowedWhenUnderwater() public {
        (uint256 a, uint256 b) = _underwaterShort();
        AccountState memory pre = ch.accountState(a);
        assertFalse(pre.healthy);

        // the kernel's value of the 0.5 calls bought back
        int256 markValue = ch.marginAfter(a, call180, 0.5e18, 0).mtm - pre.mtm;
        assertGt(markValue, 0);
        uint256 premium = uint256(markValue);
        uint256 fee = _fee(address(nvda), 0.5e18, premium);

        // one wei above mark: equity (fee aside) falls below the pre-trade equity
        AccountState memory over = ch.marginAfter(a, call180, 0.5e18, -int256(premium + 1 + fee));
        assertEq(over.equity + int256(fee) + 1, pre.equity);
        assertLt(over.equity, int256(over.im));
        _expectTradeRevert(
            _tp(a, alice, b, bob, call180, 0.5e18, premium + 1),
            abi.encodeWithSelector(CHErrors.InsufficientMargin.selector, a, over.equity, over.im)
        );

        // at mark only the fee is lost: the underwater account may reduce
        venue.trade(_tp(a, alice, b, bob, call180, 0.5e18, premium));
        AccountState memory st = ch.accountState(a);
        assertFalse(st.healthy);
        assertEq(st.equity + int256(fee), pre.equity);
        assertLt(st.im, pre.im);
        _assertPos(a, call180, -4.5e18);
    }

    // ================================================================ agents

    function test_agentWithinBudgetSucceeds() public {
        uint256 a = _fund(alice, 1000 * USDG, 0);
        uint256 b = _fund(bob, 1000 * USDG, 0);
        uint256 c = _fund(carol, 1000 * USDG, 0);
        _grant(a, alice, 100e18, 50e18, NVDA_MASK);

        uint256 fee = _fee(address(nvda), -1e18, 8e18);
        vm.expectEmit(true, true, true, true, address(ch));
        emit IClearinghouse.Traded(a, b, call180, -1e18, 8e18, fee, agent, bob);
        venue.trade(_tp(a, agent, b, bob, call180, -1e18, 8e18));
        AccountState memory st = ch.accountState(a);
        assertGt(st.im, 0);
        assertLe(st.im, 100e18);
        _assertPos(a, call180, -1e18);

        // an agent may act for the maker side, and a premium right at the cap is fine
        _grant(c, carol, 100e18, 50e18, NVDA_MASK);
        venue.trade(_tp(b, bob, c, agent, put170, -1e18, 50e18)); // carol's agent buys a put
        _assertPos(c, put170, 1e18);
        assertEq(ch.cashOf(c), 1000e18 - 50e18);
    }

    function test_agentOverBudgetReverts() public {
        uint256 a = _fund(alice, 10_000 * USDG, 0);
        uint256 b = _fund(bob, 10_000 * USDG, 0);
        _grant(a, alice, 100e18, 50e18, NVDA_MASK);

        // one short call (worst loss ~54) fits the budget of 100
        venue.trade(_tp(a, agent, b, bob, call180, -1e18, 8e18));

        // a second one would take the account's worst-case loss to ~108: margin is fine, the budget is not
        uint256 fee = _fee(address(nvda), -1e18, 8e18);
        AccountState memory st = ch.marginAfter(a, call180, -1e18, int256(8e18 - fee));
        assertTrue(st.healthy);
        assertGt(st.im, 100e18);
        _expectTradeRevert(
            _tp(a, agent, b, bob, call180, -1e18, 8e18),
            abi.encodeWithSelector(CHErrors.AgentRiskBudgetExceeded.selector, a, st.im, 100e18)
        );
        // the budget covers the whole account: a different series counts too
        uint32 call175 = _list(address(nvda), e, 175e18, true);
        AccountState memory sp = ch.marginAfter(a, call175, -1e18, int256(10e18 - _fee(address(nvda), -1e18, 10e18)));
        assertGt(sp.im, 100e18);
        _expectTradeRevert(
            _tp(a, agent, b, bob, call175, -1e18, 10e18),
            abi.encodeWithSelector(CHErrors.AgentRiskBudgetExceeded.selector, a, sp.im, 100e18)
        );
        // and it binds the agent when it acts as maker
        _expectTradeRevert(
            _tp(b, bob, a, agent, call180, 1e18, 8e18),
            abi.encodeWithSelector(
                CHErrors.AgentRiskBudgetExceeded.selector, a, ch.marginAfter(a, call180, -1e18, 8e18).im, 100e18
            )
        );

        // the owner isn't bound by the agent's budget
        venue.trade(_tp(a, alice, b, bob, call180, -1e18, 8e18));
        _assertPos(a, call180, -2e18);

        // the premium cap: a small, cheap-to-margin trade above maxPremiumPerTrade
        uint256 d = _fund(carol, 1000 * USDG, 0);
        _grant(d, carol, 100e18, 50e18, NVDA_MASK);
        _expectTradeRevert(
            _tp(d, agent, b, bob, put170, 1e18, 50e18 + 1),
            abi.encodeWithSelector(CHErrors.AgentPremiumExceeded.selector)
        );
    }

    function test_agentCannotRemoveHedgeOverBudget() public {
        uint256 a = _fund(alice, 1000 * USDG, 10e18);
        uint256 b = _fund(bob, 10_000 * USDG, 0);
        // the owner builds a collar: 10 NVDA, short 10 calls, long 10 puts (worst loss ~75)
        _trade(a, b, call180, -10e18, 80e18);
        _trade(a, b, put170, 10e18, 40e18);
        _grant(a, alice, 400e18, 100e18, NVDA_MASK);

        // selling half the puts (worst loss ~304) is within budget
        venue.trade(_tp(a, agent, b, bob, put170, -5e18, 15e18));
        // selling the rest closes a position but lifts the worst loss to ~534: over budget
        uint256 fee = _fee(address(nvda), -5e18, 15e18);
        AccountState memory st = ch.marginAfter(a, put170, -5e18, int256(15e18 - fee));
        assertTrue(st.healthy);
        assertGt(st.im, 400e18);
        _expectTradeRevert(
            _tp(a, agent, b, bob, put170, -5e18, 15e18),
            abi.encodeWithSelector(CHErrors.AgentRiskBudgetExceeded.selector, a, st.im, 400e18)
        );
    }

    function test_agentMayReduceRiskWhileOverBudget() public {
        uint256 a = _fund(alice, 1000 * USDG, 0);
        uint256 b = _fund(bob, 1000 * USDG, 0);
        _trade(a, b, call180, -2e18, 16e18); // worst loss ~108
        _grant(a, alice, 50e18, 50e18, NVDA_MASK);
        assertGt(ch.accountState(a).im, 50e18);

        // buying one back leaves ~54, still above the budget of 50, but below where it was
        venue.trade(_tp(a, agent, b, bob, call180, 1e18, 8e18));
        AccountState memory st = ch.accountState(a);
        assertGt(st.im, 50e18);
        _assertPos(a, call180, -1e18);
        // the premium cap still applies to a reducing trade
        _expectTradeRevert(
            _tp(a, agent, b, bob, call180, 1e18, 50e18 + 1),
            abi.encodeWithSelector(CHErrors.AgentPremiumExceeded.selector)
        );
    }

    function test_agentWrongUnderlyingReverts() public {
        uint32 spyCall = _list(address(spy), e, 600e18, true);
        uint256 a = _fund(alice, 1000 * USDG, 0);
        uint256 b = _fund(bob, 1000 * USDG, 0);
        _grant(a, alice, 1000e18, 100e18, NVDA_MASK);

        _expectTradeRevert(
            _tp(a, agent, b, bob, spyCall, 1e18, 5e18),
            abi.encodeWithSelector(CHErrors.AgentUnderlyingNotAllowed.selector)
        );
        _expectTradeRevert(
            _tp(b, bob, a, agent, spyCall, -1e18, 5e18),
            abi.encodeWithSelector(CHErrors.AgentUnderlyingNotAllowed.selector)
        );
        // the owner is never restricted by a mask, and NVDA stays open to the agent
        _trade(a, b, spyCall, 1e18, 5e18);
        venue.trade(_tp(a, agent, b, bob, call180, 1e18, 8e18));

        // once SPY's bit is set the agent may trade it
        _grant(a, alice, 1000e18, 100e18, NVDA_MASK | SPY_MASK);
        venue.trade(_tp(a, agent, b, bob, spyCall, 1e18, 5e18));
        _assertPos(a, spyCall, 2e18);
    }

    function test_agentExpiredReverts() public {
        uint256 a = _fund(alice, 1000 * USDG, 0);
        uint256 b = _fund(bob, 1000 * USDG, 0);
        _grant(a, alice, 1000e18, 100e18, NVDA_MASK); // expires T0 + 1 day

        vm.warp(T0 + 1 days - 1);
        venue.trade(_tp(a, agent, b, bob, call180, 1e18, 8e18));
        vm.warp(T0 + 1 days);
        _expectTradeRevert(
            _tp(a, agent, b, bob, call180, -1e18, 8e18),
            abi.encodeWithSelector(CHErrors.NotAuthorized.selector, a, agent)
        );
        // the owner still trades
        _trade(a, b, call180, -1e18, 8e18);

        // a revoked agent is out immediately
        _grant(a, alice, 1000e18, 100e18, NVDA_MASK);
        vm.prank(alice);
        ch.revokeAgent(a, agent);
        _expectTradeRevert(
            _tp(b, bob, a, agent, call180, 1e18, 8e18),
            abi.encodeWithSelector(CHErrors.NotAuthorized.selector, a, agent)
        );
    }

    function test_actorMustBeOwnerOrAgent() public {
        uint256 a = _fund(alice, 1000 * USDG, 0);
        uint256 b = _fund(bob, 1000 * USDG, 0);
        _expectTradeRevert(
            _tp(a, bob, b, bob, call180, 1e18, 8e18), abi.encodeWithSelector(CHErrors.NotAuthorized.selector, a, bob)
        );
        _expectTradeRevert(
            _tp(a, alice, b, alice, call180, 1e18, 8e18),
            abi.encodeWithSelector(CHErrors.NotAuthorized.selector, b, alice)
        );
        _expectTradeRevert(
            _tp(a, address(0), b, bob, call180, 1e18, 8e18),
            abi.encodeWithSelector(CHErrors.NotAuthorized.selector, a, address(0))
        );
        // an account that doesn't exist has no owner to act for it, not even the zero address
        _expectTradeRevert(
            _tp(a, alice, 99, address(0), call180, 1e18, 8e18),
            abi.encodeWithSelector(CHErrors.NotAuthorized.selector, 99, address(0))
        );
        // an agent of one account can't act for another
        _grant(b, bob, 1000e18, 100e18, NVDA_MASK);
        _expectTradeRevert(
            _tp(a, agent, b, bob, call180, 1e18, 8e18),
            abi.encodeWithSelector(CHErrors.NotAuthorized.selector, a, agent)
        );
    }

    function test_agentCannotWithdraw() public {
        uint256 a = _fund(alice, 1000 * USDG, 0);
        _grant(a, alice, 1000e18, 100e18, NVDA_MASK);
        AgentPolicy memory p = ch.agentPolicy(a, agent);

        vm.startPrank(agent);
        vm.expectRevert(abi.encodeWithSelector(CHErrors.NotOwner.selector, a, agent));
        ch.withdraw(a, address(usdg), 1 * USDG, agent);
        vm.expectRevert(abi.encodeWithSelector(CHErrors.NotOwner.selector, a, agent));
        ch.withdraw(a, address(usdg), 1 * USDG, alice);
        vm.expectRevert(abi.encodeWithSelector(CHErrors.NotOwner.selector, a, agent));
        ch.grantAgent(a, bob, p);
        vm.expectRevert(abi.encodeWithSelector(CHErrors.NotOwner.selector, a, agent));
        ch.revokeAgent(a, agent);
        // nor trade except through a venue
        TradeParams memory t = _tp(a, agent, a + 1, agent, call180, 1e18, 8e18);
        vm.expectRevert(abi.encodeWithSelector(CHErrors.NotVenue.selector, agent));
        ch.trade(t);
        vm.stopPrank();
        assertEq(ch.cashOf(a), 1000e18);
    }

    // ================================================================ guards and caps

    function test_onlyVenue() public {
        uint256 a = _fund(alice, 1000 * USDG, 0);
        uint256 b = _fund(bob, 1000 * USDG, 0);
        TradeParams memory t = _tp(a, alice, b, bob, call180, 1e18, 8e18);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CHErrors.NotVenue.selector, alice));
        ch.trade(t);
        vm.expectRevert(abi.encodeWithSelector(CHErrors.NotVenue.selector, address(this)));
        ch.trade(t);

        TestVenue other = new TestVenue(ch);
        vm.expectRevert(abi.encodeWithSelector(CHErrors.NotVenue.selector, address(other)));
        other.trade(t);
        ch.addVenue(address(other));
        other.trade(t);
        _assertPos(a, call180, 1e18);
    }

    function test_expiredSeriesReverts() public {
        uint256 a = _fund(alice, 1000 * USDG, 0);
        uint256 b = _fund(bob, 1000 * USDG, 0);

        vm.warp(e - 1); // Friday 15:59:59 New York
        _setPrice(address(nvda), 180e18);
        _trade(a, b, call180, 1e18, 1e18);

        vm.warp(e);
        _setPrice(address(nvda), 180e18);
        _expectTradeRevert(
            _tp(a, alice, b, bob, call180, 1e18, 1e18), abi.encodeWithSelector(CHErrors.SeriesExpired.selector)
        );
        // closing too: expired positions leave through settlement only
        _expectTradeRevert(
            _tp(a, alice, b, bob, call180, -1e18, 1e18), abi.encodeWithSelector(CHErrors.SeriesExpired.selector)
        );

        // ids that were never listed
        _expectTradeRevert(
            _tp(a, alice, b, bob, 0, 1e18, 1e18), abi.encodeWithSelector(CHErrors.UnknownSeries.selector)
        );
        uint32 next = registry.seriesCount() + 1;
        _expectTradeRevert(
            _tp(a, alice, b, bob, next, 1e18, 1e18), abi.encodeWithSelector(CHErrors.UnknownSeries.selector)
        );
    }

    function test_openInterestCap() public {
        UnderlyingParams memory p = params.underlying(address(nvda));
        p.maxOpenInterest = 3e18;
        params.setUnderlying(address(nvda), p);
        uint256 a = _fund(alice, 10_000 * USDG, 0);
        uint256 b = _fund(bob, 10_000 * USDG, 0);
        uint256 c = _fund(carol, 10_000 * USDG, 0);

        _trade(a, b, call180, 2e18, 16e18);
        _trade(c, b, call180, 1e18, 8e18); // exactly at the cap
        assertEq(ch.openInterest(call180), 3e18);
        _expectTradeRevert(
            _tp(c, carol, b, bob, call180, 0.01e18, 0.08e18), abi.encodeWithSelector(CHErrors.OpenInterestCap.selector)
        );
        // handing a long to another account leaves open interest unchanged
        _trade(c, a, call180, 1e18, 8e18);
        assertEq(ch.openInterest(call180), 3e18);
        // each series has its own cap
        _trade(a, b, put170, 3e18, 9e18);

        // with the cap lowered below open interest, reducing still works, growing doesn't
        p.maxOpenInterest = 1e18;
        params.setUnderlying(address(nvda), p);
        _trade(a, b, call180, -1e18, 8e18);
        assertEq(ch.openInterest(call180), 2e18);
        _expectTradeRevert(
            _tp(a, alice, b, bob, call180, 0.01e18, 0.08e18), abi.encodeWithSelector(CHErrors.OpenInterestCap.selector)
        );
    }

    function test_shortQtyTrackedPerExpiry() public {
        uint64 e2 = uint64(NyseCalendar.nextWeeklyExpiry(e));
        uint32 call185w2 = _list(address(nvda), e2, 185e18, true);
        uint32 spyPut = _list(address(spy), e, 600e18, false);
        uint256 a = _fund(alice, 10_000 * USDG, 0);
        uint256 b = _fund(bob, 10_000 * USDG, 0);
        uint256 c = _fund(carol, 10_000 * USDG, 0);

        _trade(a, b, call180, 2e18, 16e18); // a +2, b -2
        _trade(b, c, put170, 1e18, 3e18); // b +1, c -1
        _trade(c, a, call185w2, -1.5e18, 15e18); // c -1.5, a +1.5 (second expiry)
        _trade(a, b, call180, -3e18, 24e18); // a 2 -> -1, b -2 -> +1
        _trade(a, c, spyPut, 0.5e18, 4e18); // a +0.5, c -0.5
        _trade(b, a, call185w2, 1e18, 10e18); // b +1, a 1.5 -> 0.5

        uint256[] memory ids = new uint256[](3);
        ids[0] = a;
        ids[1] = b;
        ids[2] = c;
        assertEq(_shortQty(e), _manualShortQty(ids, e));
        assertEq(_shortQty(e2), _manualShortQty(ids, e2));
        assertEq(_shortQty(e), 2.5e18); // a call180 -1, c put170 -1, c spyPut -0.5
        assertEq(_shortQty(e2), 1.5e18); // c call185w2 -1.5
        assertEq(ch.openInterest(call180), 1e18);
        assertEq(ch.openInterest(call185w2), 1.5e18);
    }

    function test_selfTradeReverts() public {
        uint256 a = _fund(alice, 1000 * USDG, 0);
        _expectTradeRevert(
            _tp(a, alice, a, alice, call180, 1e18, 8e18), abi.encodeWithSelector(CHErrors.SelfTrade.selector)
        );
        _grant(a, alice, 1000e18, 100e18, NVDA_MASK);
        _expectTradeRevert(
            _tp(a, agent, a, alice, call180, -1e18, 8e18), abi.encodeWithSelector(CHErrors.SelfTrade.selector)
        );
    }

    function test_tradeQtyChecks() public {
        uint256 a = _fund(alice, 1000 * USDG, 0);
        uint256 b = _fund(bob, 1000 * USDG, 0);
        _expectTradeRevert(_tp(a, alice, b, bob, call180, 0, 0), abi.encodeWithSelector(CHErrors.QtyTooSmall.selector));
        _expectTradeRevert(
            _tp(a, alice, b, bob, call180, 0.01e18 - 1, 1e18), abi.encodeWithSelector(CHErrors.QtyTooSmall.selector)
        );
        _expectTradeRevert(
            _tp(a, alice, b, bob, call180, -(0.01e18 - 1), 1e18), abi.encodeWithSelector(CHErrors.QtyTooSmall.selector)
        );
        _trade(a, b, call180, 0.01e18, 0.1e18); // exactly minTradeQty
        _trade(a, b, call180, -0.01e18, 0.1e18);
        assertEq(ch.positionsOf(a).length, 0);
    }

    function test_maxPositionsCap() public {
        uint256 a = _newAccount(alice);
        uint256 b = _fund(bob, 10_000 * USDG, 0);
        uint32[] memory sids = new uint32[](MAX_POSITIONS + 1);
        uint256 n;
        uint64 ex = e;
        while (n <= MAX_POSITIONS) {
            for (uint128 k = 90e18; k <= 270e18 && n <= MAX_POSITIONS; k += 5e18) {
                sids[n++] = _list(address(nvda), ex, k, true);
                if (n <= MAX_POSITIONS) sids[n++] = _list(address(nvda), ex, k, false);
            }
            ex = uint64(NyseCalendar.nextWeeklyExpiry(ex));
        }
        for (uint256 i = 0; i < MAX_POSITIONS; ++i) {
            _cheatMovePosition(a, sids[i], 1e18);
        }
        assertEq(ch.positionsOf(a).length, MAX_POSITIONS);

        _expectTradeRevert(
            _tp(a, alice, b, bob, sids[MAX_POSITIONS], 1e18, 0),
            abi.encodeWithSelector(CHErrors.TooManyPositions.selector)
        );
        // the counterparty side hits the same cap
        _expectTradeRevert(
            _tp(b, bob, a, alice, sids[MAX_POSITIONS], -1e18, 0),
            abi.encodeWithSelector(CHErrors.TooManyPositions.selector)
        );
    }

    // ================================================================ helpers

    function _tp(
        uint256 takerId,
        address takerActor,
        uint256 makerId,
        address makerActor,
        uint32 sid,
        int256 qty,
        uint256 premium
    ) internal pure returns (TradeParams memory) {
        return TradeParams({
            takerActor: takerActor,
            makerActor: makerActor,
            takerId: takerId,
            makerId: makerId,
            seriesId: sid,
            qty: qty,
            premium: premium
        });
    }

    /// @dev Both sides acted for by their owners.
    function _trade(uint256 takerId, uint256 makerId, uint32 sid, int256 qty, uint256 premium)
        internal
        returns (uint256)
    {
        return venue.trade(_tp(takerId, ch.ownerOf(takerId), makerId, ch.ownerOf(makerId), sid, qty, premium));
    }

    function _expectTradeRevert(TradeParams memory t, bytes memory err) internal {
        vm.expectRevert(err);
        venue.trade(t);
    }

    function _grant(uint256 id, address owner, uint128 budget, uint128 maxPremium, uint64 mask) internal {
        vm.prank(owner);
        ch.grantAgent(
            id,
            agent,
            AgentPolicy({
                maxWorstLoss: budget,
                maxPremiumPerTrade: maxPremium,
                allowedMask: mask,
                expiresAt: uint64(block.timestamp + 1 days)
            })
        );
    }

    /// @dev The fee rule written out with the fixture's defaults (feeRate 0.0003, cap 12.5% of premium).
    function _fee(address u, int256 qty, uint256 premium) internal view returns (uint256) {
        (uint256 spot,,) = hub.spot(u);
        uint256 q = qty > 0 ? uint256(qty) : uint256(-qty);
        uint256 byNotional = _ceilWad(0.0003e18 * (q * spot / 1e18));
        uint256 byPremium = _ceilWad(0.125e18 * premium);
        return byNotional < byPremium ? byNotional : byPremium;
    }

    function _ceilWad(uint256 x) internal pure returns (uint256) {
        return (x + 1e18 - 1) / 1e18;
    }

    /// @dev alice short 5 calls at T0 on 450 USDG (healthy), then NVDA jumps to 220: equity ~290 < IM ~375.
    function _underwaterShort() internal returns (uint256 a, uint256 b) {
        a = _fund(alice, 450 * USDG, 0);
        b = _fund(bob, 1000 * USDG, 0);
        _trade(a, b, call180, -5e18, 42e18);
        assertTrue(ch.accountState(a).healthy);
        _setPrice(address(nvda), 220e18);
    }

    function _assertPos(uint256 id, uint32 sid, int256 qty) internal view {
        Position[] memory ps = ch.positionsOf(id);
        for (uint256 i = 0; i < ps.length; ++i) {
            if (ps[i].seriesId == sid) {
                assertEq(ps[i].qty, qty);
                return;
            }
        }
        assertEq(qty, 0, "position missing");
    }

    function _shortQty(uint64 ex) internal view returns (uint256 q) {
        (,, q) = ch.pool(ex);
    }

    function _manualShortQty(uint256[] memory ids, uint64 ex) internal view returns (uint256 sum) {
        for (uint256 i = 0; i < ids.length; ++i) {
            Position[] memory ps = ch.positionsOf(ids[i]);
            for (uint256 j = 0; j < ps.length; ++j) {
                Series memory s = registry.series(ps[j].seriesId);
                if (s.expiry == ex && ps[j].qty < 0) sum += uint256(-int256(ps[j].qty));
            }
        }
    }
}
