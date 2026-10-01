// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Fixture} from "../utils/Fixture.sol";
import {MockAuctionHouse} from "../utils/MockAuctionHouse.sol";
import {CHErrors} from "../../src/core/ClearinghouseStorage.sol";
import {IClearinghouse, TradeParams} from "../../src/interfaces/IClearinghouse.sol";
import {IInsuranceFund} from "../../src/interfaces/IInsuranceFund.sol";
import {GlobalParams} from "../../src/interfaces/IRiskParams.sol";
import {NyseCalendar} from "../../src/libraries/NyseCalendar.sol";
import {Position} from "../../src/types/Types.sol";

/// @notice Expiry settlement through the per-expiry pool: payers pay in, receivers claim once the
/// pool is complete, deficits are bridged by the InsuranceFund or wait for auction proceeds, and an
/// unrecoverable remainder is socialized through the cash index.
///
/// Fees are switched off in this suite (feeRate 0), so cash moves are exactly the premiums and
/// payoffs and the InsuranceFund holds only what a test puts there.
contract ClearinghouseSettlementTest is Fixture {
    MockAuctionHouse internal ah;

    address internal alice;
    address internal bob;
    address internal carol;
    address internal dave;
    address internal erin;
    address internal bidder;

    uint64 internal e;
    uint64 internal e2;
    uint32 internal call180;
    uint32 internal call190;
    uint32 internal put170;

    function setUp() public override {
        super.setUp();
        ah = new MockAuctionHouse(ch);
        ch.bindAuctionHouse(address(ah));

        GlobalParams memory g = params.globals();
        g.feeRate = 0;
        params.setGlobals(g);

        alice = _user("alice");
        bob = _user("bob");
        carol = _user("carol");
        dave = _user("dave");
        erin = _user("erin");
        bidder = _user("bidder");

        e = _expiry();
        e2 = uint64(NyseCalendar.nextWeeklyExpiry(e));
        call180 = _list(address(nvda), e, 180e18, true);
        call190 = _list(address(nvda), e, 190e18, true);
        put170 = _list(address(nvda), e, 170e18, false);
    }

    // ================================================================ pool and claims

    function test_longClaimsAfterShortSettles() public {
        uint256 a = _fund(alice, 1000 * USDG, 0);
        uint256 b = _fund(bob, 1000 * USDG, 0);
        _trade(a, b, call180, 5e18, 40e18); // alice long 5, bob short 5
        assertEq(_shortQty(e), 5e18);

        _settleAt(address(nvda), 197.5e18); // payoff 17.5 per call

        // the receiver settles first: it gets a claim, its cash is untouched
        vm.expectEmit(true, true, false, true, address(ch));
        emit IClearinghouse.AccountSettled(a, e, 87.5e18, 0, 0, 0);
        ch.settleAccount(a, e);
        assertEq(ch.claimable(a, e), 87.5e18);
        assertEq(ch.cashOf(a), 960e18);
        assertEq(ch.positionsOf(a).length, 0);
        assertEq(_shortQty(e), 5e18); // bob's short is still open

        // nothing has been paid in yet: the claim must wait
        vm.expectRevert(CHErrors.PoolNotReady.selector);
        ch.claim(a, e);
        // an account with nothing to claim is a silent no-op, ready or not (keepers and vaults
        // call claim blindly)
        vm.recordLogs();
        ch.claim(b, e);
        assertEq(vm.getRecordedLogs().length, 0);

        // the payer settles: its cash goes into the pool
        vm.expectEmit(true, true, false, true, address(ch));
        emit IClearinghouse.AccountSettled(b, e, -87.5e18, 87.5e18, 0, 0);
        ch.settleAccount(b, e);
        assertEq(ch.cashOf(b), 1040e18 - 87.5e18);
        assertEq(_pool(e), 87.5e18);
        assertEq(_shortQty(e), 0);
        assertEq(ch.openInterest(call180), 0);
        assertEq(ah.salesCount(), 0); // paid in full: no deficit, no sale
        (uint256 total,,) = ch.deficitOf(b, e);
        assertEq(total, 0);
        _assertSolvent();

        // now the claim pays the exact payoff, once
        vm.expectEmit(true, true, false, true, address(ch));
        emit IClearinghouse.Claimed(a, e, 87.5e18);
        ch.claim(a, e);
        assertEq(ch.cashOf(a), 960e18 + 87.5e18);
        assertEq(ch.claimable(a, e), 0);
        assertEq(_pool(e), 0);

        vm.recordLogs();
        ch.claim(a, e); // nothing left: no-op
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(ch.cashOf(a), 1047.5e18);
        _assertSolvent();
    }

    /// Review Focus #2: accounts that hold longs and shorts of the same expiry, settled in every
    /// possible order. Nobody is paid before the pool is complete and nobody blocks anyone.
    function test_mixedAccountsNoDeadlock() public {
        uint256 a = _fund(alice, 10_000 * USDG, 0);
        uint256 b = _fund(bob, 10_000 * USDG, 0);
        uint256 c = _fund(carol, 10_000 * USDG, 0);
        int256 qb = 2.123456789012345677e18; // X = call180, B sells to A
        int256 qc = 2.876543210987654329e18; // X, C sells to A
        int256 qy = 6.111111111111111111e18; // Y = call190, A sells to B
        _trade(a, b, call180, qb, 21e18);
        _trade(a, c, call180, qc, 29e18);
        _trade(b, a, call190, qy, 33e18);
        // A long X / short Y, B long Y / short X, C short X
        _assertPos(a, call180, qb + qc);
        _assertPos(a, call190, -qy);
        _assertPos(b, call190, qy);
        _assertPos(b, call180, -qb);
        _assertPos(c, call180, -qc);

        uint256 price = 200.12345678e18;
        _settleAt(address(nvda), price);
        uint256 px = price - 180e18;
        uint256 py = price - 190e18;
        int256[3] memory expNet = [
            int256(_floorMul(uint256(qb + qc), px)) - int256(_ceilMul(uint256(qy), py)),
            int256(_floorMul(uint256(qy), py)) - int256(_ceilMul(uint256(qb), px)),
            -int256(_ceilMul(uint256(qc), px))
        ];
        assertGt(expNet[0], 0);
        assertGt(expNet[1], 0);
        assertLt(expNet[2], 0);

        uint256[3] memory ids = [a, b, c];
        uint8[3][6] memory orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
        for (uint256 o = 0; o < orders.length; ++o) {
            uint256 snap = vm.snapshotState();
            _settleInOrder(ids, orders[o], expNet, 5);
            vm.revertToState(snap);
        }
    }

    function test_otmExpiryZeroPayout() public {
        uint256 a = _fund(alice, 1000 * USDG, 0);
        uint256 b = _fund(bob, 1000 * USDG, 0);
        _trade(a, b, call190, 5e18, 20e18);
        _trade(a, b, put170, 3e18, 15e18);
        _settleAt(address(nvda), 185e18); // call 190 and put 170 both expire worthless

        vm.expectEmit(true, true, false, true, address(ch));
        emit IClearinghouse.AccountSettled(b, e, 0, 0, 0, 0);
        ch.settleAccount(b, e);
        ch.settleAccount(a, e);

        assertEq(ch.cashOf(a), 965e18);
        assertEq(ch.cashOf(b), 1035e18);
        assertEq(ch.claimable(a, e), 0);
        assertEq(ch.claimable(b, e), 0);
        assertEq(ch.positionsOf(a).length, 0);
        assertEq(ch.positionsOf(b).length, 0);
        assertEq(ch.openInterest(call190), 0);
        assertEq(ch.openInterest(put170), 0);
        (uint256 p, uint256 pend, uint256 sq) = ch.pool(e);
        assertEq(p, 0);
        assertEq(pend, 0);
        assertEq(sq, 0);
        (uint256 total,,) = ch.deficitOf(b, e);
        assertEq(total, 0);
        assertEq(ah.salesCount(), 0);

        ch.claim(a, e); // nothing to claim: no-op
        assertEq(ch.cashOf(a), 965e18);
        _assertSolvent();
    }

    function test_settleOnlyTouchesThatExpiry() public {
        uint32 far = _list(address(nvda), e2, 180e18, true);
        uint256 a = _fund(alice, 1000 * USDG, 0);
        uint256 b = _fund(bob, 1000 * USDG, 0);
        _trade(a, b, call180, 1e18, 10e18);
        _trade(a, b, far, 2e18, 30e18);
        assertEq(_shortQty(e2), 2e18);

        _settleAt(address(nvda), 190e18);
        ch.settleAccount(b, e);
        ch.settleAccount(a, e);

        _assertPos(a, far, 2e18);
        _assertPos(b, far, -2e18);
        assertEq(ch.positionsOf(a).length, 1);
        assertEq(_shortQty(e), 0);
        assertEq(_shortQty(e2), 2e18);
        assertEq(ch.openInterest(far), 2e18);
        assertEq(ch.claimable(a, e), 10e18);

        // the far expiry has nothing settled yet
        vm.expectRevert(CHErrors.NothingToSettle.selector);
        ch.settleAccount(a, e);
        vm.expectRevert(CHErrors.ExpiryNotSettled.selector);
        ch.settleAccount(a, e2);
    }

    function test_settleRequiresSettledExpiry() public {
        uint32 spyCall = _list(address(spy), e, 600e18, true);
        uint256 a = _fund(alice, 10_000 * USDG, 0);
        uint256 b = _fund(bob, 10_000 * USDG, 0);
        _trade(a, b, call180, 1e18, 10e18);
        _trade(a, b, spyCall, 1e18, 20e18);

        // before the close
        vm.expectRevert(CHErrors.ExpiryNotSettled.selector);
        ch.settleAccount(a, e);

        // after the close, before the registry has a price
        vm.warp(e + 1 hours);
        vm.expectRevert(CHErrors.ExpiryNotSettled.selector);
        ch.settleAccount(a, e);

        // one underlying settled is not enough
        _settleExpiry(address(nvda), e, 190e18);
        vm.expectRevert(CHErrors.ExpiryNotSettled.selector);
        ch.settleAccount(a, e);
        vm.expectRevert(CHErrors.ExpiryNotSettled.selector);
        ch.settleAccount(b, e);

        _settleExpiry(address(spy), e, 610e18);
        ch.settleAccount(b, e);
        ch.settleAccount(a, e);
        assertEq(ch.claimable(a, e), 20e18);
        assertEq(ch.cashOf(b), 10_030e18 - 20e18);
        ch.claim(a, e);
        assertEq(ch.cashOf(a), 9970e18 + 20e18);
        _assertSolvent();
    }

    function test_nothingToSettle() public {
        uint32 far = _list(address(nvda), e2, 190e18, true);
        uint256 a = _fund(alice, 1000 * USDG, 0);
        uint256 b = _fund(bob, 1000 * USDG, 0);
        uint256 c = _fund(carol, 1000 * USDG, 0);
        _trade(a, b, far, 1e18, 10e18);
        _settleAt(address(nvda), 190e18);

        vm.expectRevert(CHErrors.NothingToSettle.selector);
        ch.settleAccount(c, e); // no positions at all
        vm.expectRevert(CHErrors.NothingToSettle.selector);
        ch.settleAccount(999, e); // no such account
        vm.expectRevert(CHErrors.NothingToSettle.selector);
        ch.settleAccount(type(uint256).max, 0);
        // positions only in another expiry
        vm.expectRevert(CHErrors.NothingToSettle.selector);
        ch.settleAccount(a, e);
        vm.expectRevert(CHErrors.NothingToSettle.selector);
        ch.settleAccount(b, e);
    }

    /// Payoffs round against the account per position: a long gets floor(qty * payoff), a short
    /// pays ceil(qty * payoff). Whatever the order, the pool never owes more than it holds and
    /// keeps at most one wei per position.
    function test_roundingFavorsPool(
        uint256 q1,
        uint256 q2,
        uint256 split,
        uint256 qp,
        uint256 strikeStep,
        uint256 price,
        uint256 seed
    ) public {
        q1 = bound(q1, 1, 1000e18);
        q2 = bound(q2, 1, 1000e18);
        uint256 s1 = bound(split, 1, q1 + q2 - 1);
        uint256 s2 = q1 + q2 - s1;
        qp = bound(qp, 1, 1000e18);
        uint128 k = uint128(bound(strikeStep, 18, 54) * 5e18); // 90..270, within 50% of 180
        price = bound(price, 21e18, 1999e18);

        uint32 c = _list(address(nvda), e, k, true);
        uint32 p = _list(address(nvda), e, k, false);
        uint256[4] memory ids = [
            _fund(alice, 5_000_000 * USDG, 0),
            _fund(bob, 5_000_000 * USDG, 0),
            _fund(carol, 5_000_000 * USDG, 0),
            _fund(dave, 5_000_000 * USDG, 0)
        ];
        // 0: long q1 calls, short qp puts | 1: long q2 calls | 2: short s1 calls, long qp puts
        // 3: short s2 calls
        _cheatMovePosition(ids[0], c, int256(q1));
        _cheatMovePosition(ids[1], c, int256(q2));
        _cheatMovePosition(ids[2], c, -int256(s1));
        _cheatMovePosition(ids[3], c, -int256(s2));
        _cheatMovePosition(ids[0], p, -int256(qp));
        _cheatMovePosition(ids[2], p, int256(qp));

        _settleAt(address(nvda), price);
        (uint256 px,) = registry.settlementPriceOf(address(nvda), e);
        uint256 cp = px > k ? px - k : 0;
        uint256 pp = k > px ? k - px : 0;
        int256[4] memory expNet = [
            int256(_floorMul(q1, cp)) - int256(_ceilMul(qp, pp)),
            int256(_floorMul(q2, cp)),
            int256(_floorMul(qp, pp)) - int256(_ceilMul(s1, cp)),
            -int256(_ceilMul(s2, cp))
        ];

        uint256 paidIn;
        uint256 claimed;
        uint256[4] memory order = _shuffle(seed);
        for (uint256 i = 0; i < 4; ++i) {
            uint256 id = ids[order[i]];
            int256 net = expNet[order[i]];
            uint256 cashBefore = ch.cashOf(id);
            ch.settleAccount(id, e);
            if (net < 0) {
                assertEq(cashBefore - ch.cashOf(id), uint256(-net), "paid");
                paidIn += uint256(-net);
            } else {
                assertEq(ch.claimable(id, e), uint256(net), "claim");
            }
            assertEq(_pool(e), paidIn);
            _assertSolvent();
        }
        assertEq(_pool(e), paidIn);
        assertEq(_shortQty(e), 0);
        for (uint256 i = 0; i < 4; ++i) {
            uint256 amt = ch.claimable(ids[i], e);
            uint256 before = ch.cashOf(ids[i]);
            ch.claim(ids[i], e);
            assertEq(ch.cashOf(ids[i]) - before, amt);
            claimed += amt;
        }
        assertLe(claimed, paidIn);
        assertEq(_pool(e), paidIn - claimed);
        assertLe(paidIn - claimed, 6); // < 1 wei per position
        _assertSolvent();
    }

    // ================================================================ deficits

    function test_coveredCallDeficitBridgedByInsurance() public {
        (uint256 v, uint256 b) = _coveredCallSold(30e18); // v: 10 NVDA + 35 USDG, short 10 call190
        usdg.mint(address(insurance), 1000 * USDG);
        _settleAt(address(nvda), 210e18); // payoff 20 per call: v owes 200, has 35

        vm.expectEmit(true, true, false, true, address(ch));
        emit IClearinghouse.AccountSettled(v, e, -200e18, 35e18, 165e18, 0);
        ch.settleAccount(v, e);

        (uint256 total, uint256 bridged, uint256 pend) = ch.deficitOf(v, e);
        assertEq(total, 165e18);
        assertEq(bridged, 165e18);
        assertEq(pend, 0);
        assertEq(ch.cashOf(v), 0);
        assertEq(ch.collateralOf(v, address(nvda)), 10e18); // the stock waits for the deficit sale
        assertEq(_pool(e), 200e18);
        assertEq(insurance.outstandingWad(), 165e18);
        assertEq(insurance.balanceWad(), 835e18);
        assertEq(ah.salesCount(), 1);
        (uint256 saleId, uint64 saleExpiry) = ah.sale(0);
        assertEq(saleId, v);
        assertEq(saleExpiry, e);
        _assertSolvent();

        // the buyer is paid in full right away
        ch.settleAccount(b, e);
        ch.claim(b, e);
        assertEq(ch.cashOf(b), 970e18 + 200e18);
        assertEq(_pool(e), 0);
        _assertSolvent();

        // the defaulter is frozen until the deficit is repaid
        vm.expectRevert(CHErrors.InDeficit.selector);
        vm.prank(carol);
        ch.withdraw(v, address(nvda), 1e18, carol);
    }

    function test_bridgeRoundsUpToTokenUnit() public {
        (uint256 v, uint256 b) = _coveredCallSold(30e18);
        usdg.mint(address(insurance), 1000 * USDG);
        _settleAt(address(nvda), 210.00000001e18); // debt 200.0000001: short 165.0000001 (sub-unit)

        // the fund pays whole USDG units: it bridges 165.000001 and nothing is left pending
        vm.expectEmit(true, true, false, true, address(ch));
        emit IClearinghouse.AccountSettled(v, e, -200.0000001e18, 35e18, 165.000001e18, 0);
        ch.settleAccount(v, e);
        (uint256 total, uint256 bridged, uint256 pend) = ch.deficitOf(v, e);
        assertEq(total, 165.000001e18);
        assertEq(bridged, 165.000001e18);
        assertEq(pend, 0);
        assertEq(_pending(e), 0);

        ch.settleAccount(b, e);
        ch.claim(b, e);
        assertEq(ch.cashOf(b), 970e18 + 200.0000001e18);
        assertEq(_pool(e), 0.0000009e18); // the rounding stays in the pool
        _assertSolvent();
    }

    function test_deficitWithEmptyInsuranceBlocksClaimsUntilProceeds() public {
        (uint256 v, uint256 b) = _coveredCallSold(30e18);
        assertEq(insurance.balanceWad(), 0);
        _settleAt(address(nvda), 210e18);

        vm.expectEmit(true, true, false, true, address(ch));
        emit IClearinghouse.AccountSettled(v, e, -200e18, 35e18, 0, 165e18);
        ch.settleAccount(v, e);
        (uint256 total, uint256 bridged, uint256 pend) = ch.deficitOf(v, e);
        assertEq(total, 165e18);
        assertEq(bridged, 0);
        assertEq(pend, 165e18);
        (uint256 p, uint256 pending,) = ch.pool(e);
        assertEq(p, 35e18);
        assertEq(pending, 165e18);
        assertEq(ah.salesCount(), 1);

        ch.settleAccount(b, e);
        assertEq(_shortQty(e), 0);
        vm.expectRevert(CHErrors.PoolNotReady.selector);
        ch.claim(b, e);

        // a first bid covers part of it: still not ready
        _deposit(bidder, v, address(usdg), 100 * USDG);
        vm.expectEmit(true, true, false, true, address(ch));
        emit IClearinghouse.DeficitReduced(v, e, 100e18, 0);
        vm.prank(address(ah));
        ch.applyDeficitProceeds(v, e);
        (total, bridged, pend) = ch.deficitOf(v, e);
        assertEq(total, 65e18);
        assertEq(pend, 65e18);
        assertEq(_pool(e), 135e18);
        assertEq(_pending(e), 65e18);
        vm.expectRevert(CHErrors.PoolNotReady.selector);
        ch.claim(b, e);
        _assertSolvent();

        // the second bid clears it (through the mock this time); the surplus stays with the owner
        _deposit(bidder, v, address(usdg), 80 * USDG);
        ah.applyDeficitProceeds(v, e);
        (total, bridged, pend) = ch.deficitOf(v, e);
        assertEq(total, 0);
        assertEq(_pending(e), 0);
        assertEq(ch.cashOf(v), 15e18);

        ch.claim(b, e);
        assertEq(ch.cashOf(b), 970e18 + 200e18);
        assertEq(_pool(e), 0);
        _assertSolvent();

        // no deficit any more: the owner can take the rest out
        vm.startPrank(carol);
        ch.withdraw(v, address(usdg), 15 * USDG, carol);
        ch.withdraw(v, address(nvda), 10e18, carol);
        vm.stopPrank();
    }

    function test_proceedsRepayPendingThenInsurance() public {
        (uint256 v, uint256 b) = _coveredCallSold(30e18 + 7); // v cash 35e18 + 7
        usdg.mint(address(insurance), 50 * USDG);
        _settleAt(address(nvda), 210e18);

        // short 165e18 - 7: the fund bridges its 50, the rest is pending
        vm.expectEmit(true, true, false, true, address(ch));
        emit IClearinghouse.AccountSettled(v, e, -200e18, 35e18 + 7, 50e18, 115e18 - 7);
        ch.settleAccount(v, e);
        (uint256 total, uint256 bridged, uint256 pend) = ch.deficitOf(v, e);
        assertEq(total, 165e18 - 7);
        assertEq(bridged, 50e18);
        assertEq(pend, 115e18 - 7);
        assertEq(insurance.outstandingWad(), 50e18);
        assertEq(insurance.balanceWad(), 0);
        ch.settleAccount(b, e);

        // 140 in: the pool first (115 - 7 wei), then whole USDG units to the fund; dust stays
        _deposit(bidder, v, address(usdg), 140 * USDG);
        vm.expectEmit(true, true, false, true, address(ch));
        emit IClearinghouse.DeficitReduced(v, e, 115e18 - 7, 25e18);
        vm.expectCall(address(insurance), abi.encodeCall(IInsuranceFund.notifyRecovered, (25e18)));
        vm.prank(address(ah));
        ch.applyDeficitProceeds(v, e);
        (total, bridged, pend) = ch.deficitOf(v, e);
        assertEq(total, 25e18);
        assertEq(bridged, 25e18);
        assertEq(pend, 0);
        assertEq(ch.cashOf(v), 7);
        assertEq(insurance.balanceWad(), 25e18);
        assertEq(insurance.outstandingWad(), 25e18);
        _assertSolvent();

        // the pool is whole again: claims no longer wait for the fund's repayment
        ch.claim(b, e);
        assertEq(ch.cashOf(b), 970e18 - 7 + 200e18);
        assertEq(_pool(e), 0);

        _deposit(bidder, v, address(usdg), 30 * USDG);
        vm.expectEmit(true, true, false, true, address(ch));
        emit IClearinghouse.DeficitReduced(v, e, 0, 25e18);
        vm.prank(address(ah));
        ch.applyDeficitProceeds(v, e);
        (total,,) = ch.deficitOf(v, e);
        assertEq(total, 0);
        assertEq(insurance.balanceWad(), 50e18);
        assertEq(insurance.outstandingWad(), 0);
        assertEq(ch.cashOf(v), 5e18 + 7);
        _assertSolvent();

        vm.prank(carol);
        ch.withdraw(v, address(usdg), 5 * USDG, carol);
        assertEq(ch.cashOf(v), 7);
    }

    function test_applyDeficitProceedsOnlyAuctionHouse() public {
        (uint256 v,) = _coveredCallSold(30e18);
        _settleAt(address(nvda), 210e18);
        ch.settleAccount(v, e);
        _deposit(bidder, v, address(usdg), 100 * USDG);

        vm.expectRevert(abi.encodeWithSelector(CHErrors.NotAuctionHouse.selector, alice));
        vm.prank(alice);
        ch.applyDeficitProceeds(v, e);
        vm.expectRevert(abi.encodeWithSelector(CHErrors.NotAuctionHouse.selector, address(this)));
        ch.applyDeficitProceeds(v, e);
        (uint256 total,,) = ch.deficitOf(v, e);
        assertEq(total, 165e18);
    }

    /// The whole waterfall at an arbitrary cash index (credits floor and debits ceil there): the
    /// clearinghouse stays solvent at every step and the pool pays the claim in full at the end.
    function test_waterfallSolventAtAnyIndex(
        uint256 index,
        uint256 price,
        uint256 insUnits,
        uint256 bidUnits,
        uint256 bidDust
    ) public {
        index = bound(index, 1e9, 1e18);
        price = bound(price, 181e18, 600e18);
        insUnits = bound(insUnits, 0, 3000 * USDG);
        bidUnits = bound(bidUnits, 0, 3000 * USDG);
        bidDust = bound(bidDust, 0, 999_999);
        _cheatCashIndex(index);

        (uint256 v, uint256 b) = _nakedShortSold();
        _fund(carol, 2000 * USDG, 0);
        if (insUnits != 0) usdg.mint(address(insurance), insUnits);
        _settleAt(address(nvda), price);
        (uint256 px,) = registry.settlementPriceOf(address(nvda), e);
        uint256 claimAmt = _floorMul(5e18, px - 180e18);
        uint256 debt = _ceilMul(5e18, px - 180e18);
        uint256 cashV = ch.cashOf(v);

        ch.settleAccount(v, e);
        _assertSolvent();
        _assertDeficitBooks(v);
        ch.settleAccount(b, e);
        assertEq(ch.claimable(b, e), claimAmt);
        {
            // the pool (plus what is pending) holds the debt, plus the bridge's round-up to a unit
            uint256 short = debt > cashV ? debt - cashV : 0;
            (, uint256 bridged,) = ch.deficitOf(v, e);
            uint256 roundUp = bridged > short ? bridged - short : 0;
            assertLt(roundUp, 1e12);
            assertEq(_pool(e) + _pending(e), debt + roundUp);
        }

        uint256 bid = bidUnits + bidDust;
        if (bid != 0) {
            _deposit(bidder, v, address(usdg), bid);
            vm.prank(address(ah));
            ch.applyDeficitProceeds(v, e);
            _assertSolvent();
            _assertDeficitBooks(v);
        }
        if (_pending(e) != 0) ch.socializeRemainder(v, e);
        assertEq(_pending(e), 0);
        (, uint256 bridgedLeft, uint256 pendLeft) = ch.deficitOf(v, e);
        assertEq(pendLeft, 0);
        assertEq(insurance.outstandingWad(), bridgedLeft);
        _assertSolvent();

        uint256 before = ch.cashOf(b);
        ch.claim(b, e);
        assertLe(ch.cashOf(b) - before, claimAmt);
        assertApproxEqAbs(ch.cashOf(b) - before, claimAmt, 1);
        _assertSolvent();
    }

    // ================================================================ socialization

    function test_socializeRemainderReducesIndex() public {
        (uint256 v, uint256 b) = _nakedShortSold(); // v short 5 call180 on 492 cash; b long 5 on 958
        uint256 c = _fund(carol, 2000 * USDG, 0);
        uint256 d = _fund(dave, 3000 * USDG, 0);
        _settleAt(address(nvda), 300e18); // v owes 600, has 492

        ch.settleAccount(v, e);
        ch.settleAccount(b, e);
        (uint256 total,, uint256 pend) = ch.deficitOf(v, e);
        assertEq(total, 108e18);
        assertEq(pend, 108e18);
        vm.expectRevert(CHErrors.PoolNotReady.selector);
        ch.claim(b, e);

        // v has nothing left: the 108 is spread over all 5958 of cash
        uint256 totalCash = 958e18 + 2000e18 + 3000e18;
        uint256 newIndex = 1e18 * (totalCash - 108e18) / totalCash;
        vm.expectEmit(true, false, false, true, address(ch));
        emit IClearinghouse.LossSocialized(e, 108e18, newIndex);
        ch.socializeRemainder(v, e);

        assertEq(ch.cashIndex(), newIndex);
        assertEq(ch.cashOf(b), 958e18 * newIndex / 1e18);
        assertEq(ch.cashOf(c), 2000e18 * newIndex / 1e18);
        assertEq(ch.cashOf(d), 3000e18 * newIndex / 1e18);
        // everybody loses the same fraction (to the wei of rounding); the index floors, so the
        // total shrinks by at least the remainder and by less than 1 wei per 1e18 of norm more
        assertApproxEqAbs(ch.cashOf(c) * 1e18 / 2000e18, ch.cashOf(d) * 1e18 / 3000e18, 1);
        uint256 left = ch.cashOf(b) + ch.cashOf(c) + ch.cashOf(d);
        assertLe(left, totalCash - 108e18);
        assertApproxEqAbs(left, totalCash - 108e18, 5958 + 3);
        (total,, pend) = ch.deficitOf(v, e);
        assertEq(total, 0);
        assertEq(pend, 0);
        (uint256 p, uint256 pending,) = ch.pool(e);
        assertEq(p, 600e18);
        assertEq(pending, 0);
        _assertSolvent();

        // claims are paid in full
        uint256 before = ch.cashOf(b);
        ch.claim(b, e);
        assertApproxEqAbs(ch.cashOf(b), before + 600e18, 1);
        assertLe(ch.cashOf(b), before + 600e18);
        assertEq(_pool(e), 0);
        _assertSolvent();

        // the defaulted account is clear again
        vm.expectRevert(CHErrors.NothingToSocialize.selector);
        ch.socializeRemainder(v, e);
    }

    function test_socializeUnfundableMarksImpaired() public {
        uint256 v = _fund(alice, 450 * USDG, 0);
        uint256 b = _fund(bob, 25.2e6, 0);
        uint256 b2 = _fund(erin, 16.8e6, 0);
        uint256 d = _fund(dave, 10 * USDG, 0);
        _trade(b, v, call180, 3e18, 25.2e18);
        _trade(b2, v, call180, 2e18, 16.8e18);
        assertEq(ch.cashOf(b), 0);
        assertEq(ch.cashOf(b2), 0);
        _settleAt(address(nvda), 300e18);

        ch.settleAccount(v, e); // pays 492, 108 pending
        ch.settleAccount(b, e); // claim 360
        ch.settleAccount(b2, e); // claim 240

        // only dave's 10 USDG of cash exist: everything goes, and the index stops at 1 (not 0)
        vm.expectEmit(true, false, false, true, address(ch));
        emit IClearinghouse.LossSocialized(e, 108e18, 1);
        ch.socializeRemainder(v, e);
        assertEq(ch.cashIndex(), 1);
        assertEq(ch.cashOf(d), 10); // 10e18 of norm at index 1
        uint256 pool0 = 492e18 + 10e18 - 10;
        (uint256 p, uint256 pending,) = ch.pool(e);
        assertEq(p, pool0);
        assertEq(pending, 0);
        (uint256 total,,) = ch.deficitOf(v, e);
        assertEq(total, 0);
        _assertSolvent();

        // claims are paid pro rata from what the pool holds
        ch.claim(b, e);
        uint256 paidB = 360e18 * pool0 / 600e18;
        assertEq(ch.cashOf(b), paidB);
        ch.claim(b2, e);
        assertEq(ch.cashOf(b2), pool0 - paidB);
        assertEq(_pool(e), 0);
        assertLt(ch.cashOf(b2), 240e18);
        _assertSolvent();

        // the ledger keeps working at index 1
        uint256 f = _fund(carol, 100 * USDG, 0);
        assertEq(ch.cashOf(f), 100e18);
        vm.prank(carol);
        ch.withdraw(f, address(usdg), 100 * USDG, carol);
        assertEq(ch.cashOf(f), 0);
        _assertSolvent();
    }

    /// A long that settles only after the pool was impaired: the early claimant is capped at its
    /// claim, never paid out of the late claimant's share beyond it.
    function test_impairedClaimNeverExceedsClaim() public {
        uint256 v = _fund(alice, 450 * USDG, 0);
        uint256 b = _fund(bob, 25.2e6, 0);
        uint256 b2 = _fund(erin, 16.8e6, 0);
        _fund(dave, 10 * USDG, 0);
        _trade(b, v, call180, 3e18, 25.2e18);
        _trade(b2, v, call180, 2e18, 16.8e18);
        _settleAt(address(nvda), 300e18);

        ch.settleAccount(v, e);
        ch.settleAccount(b, e); // b2 has not settled yet
        ch.socializeRemainder(v, e);
        uint256 pool0 = 492e18 + 10e18 - 10;
        assertEq(_pool(e), pool0);

        // the pro-rata share over the claims known so far (all of the pool) exceeds b's claim
        ch.claim(b, e);
        assertEq(ch.cashOf(b), 360e18);
        assertEq(_pool(e), pool0 - 360e18);

        ch.settleAccount(b2, e);
        ch.claim(b2, e);
        assertEq(ch.cashOf(b2), pool0 - 360e18);
        assertEq(_pool(e), 0);
        _assertSolvent();
    }

    function test_socializeWritesOffInsuranceBridge() public {
        (uint256 v, uint256 b) = _nakedShortSold();
        uint256 c = _fund(carol, 2000 * USDG, 0);
        usdg.mint(address(insurance), 50 * USDG);
        _settleAt(address(nvda), 300e18);

        vm.expectEmit(true, true, false, true, address(ch));
        emit IClearinghouse.AccountSettled(v, e, -600e18, 492e18, 50e18, 58e18);
        ch.settleAccount(v, e);
        ch.settleAccount(b, e);
        assertEq(insurance.outstandingWad(), 50e18);

        // only the pending 58 is socialized; the fund's 50 can no longer be recovered
        uint256 totalCash = 958e18 + 2000e18;
        uint256 newIndex = 1e18 * (totalCash - 58e18) / totalCash;
        vm.expectEmit(true, false, false, true, address(ch));
        emit IClearinghouse.LossSocialized(e, 58e18, newIndex);
        vm.expectEmit(false, false, false, true, address(insurance));
        emit IInsuranceFund.WrittenOff(50e18);
        ch.socializeRemainder(v, e);

        assertEq(insurance.outstandingWad(), 0);
        (uint256 total, uint256 bridged, uint256 pend) = ch.deficitOf(v, e);
        assertEq(total, 0);
        assertEq(bridged, 0);
        assertEq(pend, 0);
        assertEq(ch.cashOf(c), 2000e18 * newIndex / 1e18);
        assertEq(_pool(e), 600e18);
        _assertSolvent();

        ch.claim(b, e);
        assertEq(_pool(e), 0);
        _assertSolvent();
    }

    function test_socializeSweepsDonatedCashFirst() public {
        (uint256 v, uint256 b) = _nakedShortSold();
        _settleAt(address(nvda), 300e18);
        ch.settleAccount(v, e);
        ch.settleAccount(b, e);

        // somebody parks one USDG unit in the defaulted account: it can't block socialization
        _deposit(bidder, v, address(usdg), 1);
        uint256 rem = 108e18 - 1e12;
        uint256 newIndex = 1e18 * (958e18 - rem) / 958e18;
        vm.expectEmit(true, true, false, true, address(ch));
        emit IClearinghouse.DeficitReduced(v, e, 1e12, 0);
        vm.expectEmit(true, false, false, true, address(ch));
        emit IClearinghouse.LossSocialized(e, rem, newIndex);
        ch.socializeRemainder(v, e);
        assertEq(ch.cashOf(v), 0);
        assertEq(_pool(e), 600e18);
        assertEq(_pending(e), 0);
        _assertSolvent();

        ch.claim(b, e);
        _assertSolvent();
    }

    function test_socializeWithEnoughCashOnlyRepays() public {
        (uint256 v, uint256 b) = _nakedShortSold();
        _settleAt(address(nvda), 300e18);
        ch.settleAccount(v, e);
        ch.settleAccount(b, e);

        _deposit(bidder, v, address(usdg), 110 * USDG);
        vm.recordLogs();
        ch.socializeRemainder(v, e);
        assertEq(vm.getRecordedLogs().length, 1); // DeficitReduced only, no LossSocialized
        assertEq(ch.cashIndex(), 1e18);
        assertEq(ch.cashOf(v), 2e18);
        (uint256 total,,) = ch.deficitOf(v, e);
        assertEq(total, 0);
        assertEq(_pending(e), 0);

        ch.claim(b, e);
        assertEq(ch.cashOf(b), 958e18 + 600e18);
        _assertSolvent();
    }

    function test_socializeRequiresEmptyAccount() public {
        uint256 a = _fund(alice, 1000 * USDG, 0);
        vm.expectRevert(CHErrors.NothingToSocialize.selector);
        ch.socializeRemainder(a, e);

        // collateral left: the deficit sale must run first
        (uint256 v,) = _coveredCallSold(30e18);
        // a naked defaulter that still holds a position in a later expiry
        uint32 far = _list(address(nvda), e2, 180e18, true);
        uint256 w = _fund(dave, 450 * USDG, 0);
        uint256 x = _fund(erin, 1000 * USDG, 0);
        _trade(x, w, call180, 5e18, 42e18);
        _trade(x, w, far, 0.1e18, 1e18);

        _settleAt(address(nvda), 300e18);
        ch.settleAccount(v, e);
        ch.settleAccount(w, e);
        (,, uint256 pv) = ch.deficitOf(v, e);
        (,, uint256 pw) = ch.deficitOf(w, e);
        assertGt(pv, 0);
        assertGt(pw, 0);

        vm.expectRevert(abi.encodeWithSelector(CHErrors.AccountNotEmpty.selector, v));
        ch.socializeRemainder(v, e);
        vm.expectRevert(abi.encodeWithSelector(CHErrors.AccountNotEmpty.selector, w));
        ch.socializeRemainder(w, e);
    }

    // ================================================================ helpers

    function _trade(uint256 takerId, uint256 makerId, uint32 sid, int256 qty, uint256 premium) internal {
        venue.trade(
            TradeParams({
                takerActor: ch.ownerOf(takerId),
                makerActor: ch.ownerOf(makerId),
                takerId: takerId,
                makerId: makerId,
                seriesId: sid,
                qty: qty,
                premium: premium
            })
        );
    }

    /// @dev carol's vault-like account (10 NVDA, 5 USDG) sells 10 call190 to bob (1000 USDG).
    function _coveredCallSold(uint256 premium) internal returns (uint256 v, uint256 b) {
        v = _fund(carol, 5 * USDG, 10e18);
        b = _fund(bob, 1000 * USDG, 0);
        _trade(b, v, call190, 10e18, premium);
    }

    /// @dev alice (450 USDG, no stock) sells 5 call180 to bob (1000 USDG) at 42.
    function _nakedShortSold() internal returns (uint256 v, uint256 b) {
        v = _fund(alice, 450 * USDG, 0);
        b = _fund(bob, 1000 * USDG, 0);
        _trade(b, v, call180, 5e18, 42e18);
    }

    function _settleAt(address u, uint256 price) internal {
        if (block.timestamp < e + 1 hours) vm.warp(e + 1 hours);
        _settleExpiry(u, e, price);
    }

    /// @dev Settles `ids` in `order`, checking every step: payers pay exactly their net, receivers
    /// get exactly their net as a claim, and no claim is paid while a short of `e` is still open.
    function _settleInOrder(uint256[3] memory ids, uint8[3] memory order, int256[3] memory expNet, uint256 nPositions)
        internal
    {
        uint256 paidIn;
        bool[3] memory done;
        for (uint256 step = 0; step < 3; ++step) {
            uint256 i = order[step];
            uint256 cashBefore = ch.cashOf(ids[i]);
            ch.settleAccount(ids[i], e);
            done[i] = true;
            if (expNet[i] < 0) {
                assertEq(cashBefore - ch.cashOf(ids[i]), uint256(-expNet[i]), "payer");
                assertEq(ch.claimable(ids[i], e), 0);
                paidIn += uint256(-expNet[i]);
            } else {
                assertEq(ch.cashOf(ids[i]), cashBefore, "receiver cash");
                assertEq(ch.claimable(ids[i], e), uint256(expNet[i]), "receiver claim");
            }
            assertEq(_pool(e), paidIn);
            for (uint256 j = 0; j < 3; ++j) {
                if (done[j] && ch.claimable(ids[j], e) != 0 && _shortQty(e) != 0) {
                    vm.expectRevert(CHErrors.PoolNotReady.selector);
                    ch.claim(ids[j], e);
                }
            }
            _assertSolvent();
        }

        assertEq(_shortQty(e), 0);
        assertEq(ch.openInterest(call180), 0);
        assertEq(ch.openInterest(call190), 0);
        uint256 claimed;
        for (uint256 j = 0; j < 3; ++j) {
            uint256 amt = ch.claimable(ids[j], e);
            uint256 before = ch.cashOf(ids[j]);
            ch.claim(ids[j], e);
            assertEq(ch.cashOf(ids[j]) - before, amt);
            claimed += amt;
        }
        assertLe(claimed, paidIn);
        assertLe(paidIn - claimed, 3 * nPositions);
        assertEq(_pool(e), paidIn - claimed);
        _assertSolvent();
    }

    /// @dev A permutation of 0..3 from `seed` (Fisher-Yates).
    function _shuffle(uint256 seed) internal pure returns (uint256[4] memory o) {
        o = [uint256(0), 1, 2, 3];
        for (uint256 i = 3; i > 0; --i) {
            uint256 j = uint256(keccak256(abi.encode(seed, i))) % (i + 1);
            (o[i], o[j]) = (o[j], o[i]);
        }
    }

    /// @dev The account's deficit is exactly its per-expiry parts, and the fund is owed exactly
    /// what it bridged to this (only) defaulter.
    function _assertDeficitBooks(uint256 id) internal view {
        (uint256 total, uint256 bridged, uint256 pend) = ch.deficitOf(id, e);
        assertEq(total, bridged + pend, "deficit parts");
        assertEq(insurance.outstandingWad(), bridged, "fund outstanding");
        assertEq(bridged % 1e12, 0, "bridge in whole units");
    }

    /// @dev USDG held by the clearinghouse covers every account's cash plus every pool.
    function _assertSolvent() internal view {
        uint256 sum;
        for (uint256 id = 1; ch.ownerOf(id) != address(0); ++id) {
            sum += ch.cashOf(id);
        }
        assertGe(usdg.balanceOf(address(ch)) * 1e12, sum + _pool(e) + _pool(e2), "USDG held < cash + pools");
    }

    function _pool(uint64 ex) internal view returns (uint256 p) {
        (p,,) = ch.pool(ex);
    }

    function _pending(uint64 ex) internal view returns (uint256 q) {
        (, q,) = ch.pool(ex);
    }

    function _shortQty(uint64 ex) internal view returns (uint256 q) {
        (,, q) = ch.pool(ex);
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

    function _floorMul(uint256 q, uint256 p) internal pure returns (uint256) {
        return q * p / 1e18;
    }

    function _ceilMul(uint256 q, uint256 p) internal pure returns (uint256) {
        return (q * p + 1e18 - 1) / 1e18;
    }
}
