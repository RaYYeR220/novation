// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Fixture} from "../utils/Fixture.sol";
import {AuctionHouse} from "../../src/core/AuctionHouse.sol";
import {CHS, CHStorage} from "../../src/core/ClearinghouseStorage.sol";
import {NyseCalendar} from "../../src/libraries/NyseCalendar.sol";
import {MAX_POSITIONS, MAX_UNDERLYINGS, MAX_CLAIM_EXPIRIES} from "../../src/types/Types.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";

/// @notice Test-only. Etched over the clearinghouse for one call: an unpaid claim on a past expiry
/// that its pool can't pay yet (a short on it still unsettled), booked like settleAccount books one.
contract BlockedClaimSeeder {
    function seed(uint256 id, uint64 expiry, uint256 wad) external {
        CHStorage storage $ = CHS.s();
        if ($.claimable[id][expiry] == 0) $.claimExpiries[id].push(expiry);
        $.claimable[id][expiry] += wad;
        $.claimableTotal[id] += wad;
        $.totalClaimable[expiry] += wad;
        $.unsettledShortQty[expiry] += 1;
    }
}

/// The most expensive liquidation bid the caps allow, measured cold: the book is built in setUp (a
/// transaction of its own), so the bid starts with every account and slot cold, as on chain.
///  - the account: MAX_POSITIONS (256) short positions over MAX_UNDERLYINGS (4) underlyings (4
///    weekly expiries x 8 strikes x call and put each), collateral in all 4, unpaid claims on
///    MAX_CLAIM_EXPIRIES (16) expiries whose pools can't pay yet (so they all move), insolvent
///    (the InsuranceFund pays the bidder: the bid's longest path);
///  - 64 underlyings registered (RiskParams' cap);
///  - every feed has printed as many rounds since the last fold as a bid folds itself (8);
///  - the bidder holds nothing but cash: every position, token and claim lands in fresh storage.
/// The kernel here is KernelReference. Its calls are replayed to take their gas out, and the Stylus
/// kernel's cost is added back: 1.40M per margin call at 256 positions (measured on the Robinhood
/// Chain testnet) and at most 40k per ewmaUpdate call (program init included).
contract LiquidationGasTest is Fixture {
    uint256 constant STYLUS_MARGIN = 1_400_000;
    uint256 constant STYLUS_EWMA = 40_000;
    uint256 constant TX_BASE = 21_000 + 16 * 132; // intrinsic gas, calldata counted as non-zero bytes
    uint256 constant VOL_BACKLOG = 8; // AuctionHouse.LIQUIDATION_VOL_ROUNDS
    uint256 constant LIMIT = 28_000_000;

    AuctionHouse ah;
    address alice;
    address carol;
    uint256 a;
    uint256 c;
    address[] us;

    function setUp() public override {
        super.setUp();
        ah = new AuctionHouse(ch, params, hub);
        ch.bindAuctionHouse(address(ah));
        alice = _user("alice");
        carol = _user("carol");
        address bob = _user("bob");

        us.push(address(nvda));
        us.push(address(spy));
        us.push(address(_addUnderlying("U2", 100e18, 0.2e18, 1.2e18, 10e18, 1000e18)));
        us.push(address(_addUnderlying("U3", 150e18, 0.2e18, 1.2e18, 15e18, 1500e18)));
        assertEq(us.length, MAX_UNDERLYINGS);
        while (params.underlyingCount() < 64) {
            _addUnderlying(
                string.concat("X", vm.toString(params.underlyingCount())), 100e18, 0.2e18, 1.2e18, 10e18, 1e21
            );
        }

        a = _newAccount(alice);
        uint256 b = _fund(bob, 100_000_000 * USDG, 0);
        c = _fund(carol, 100_000_000 * USDG, 0);
        usdg.mint(address(insurance), 100_000_000 * USDG);

        // 64 short positions per underlying: 4 expiries x 8 strikes x call and put
        uint64[4] memory ex;
        ex[0] = _expiry();
        for (uint256 w = 1; w < 4; ++w) {
            ex[w] = uint64(NyseCalendar.nextWeeklyExpiry(ex[w - 1] + 1));
        }
        for (uint256 i; i < us.length; ++i) {
            (uint256 spot,,) = hub.spot(us[i]);
            spot = spot / 5e18 * 5e18;
            for (uint256 w; w < 4; ++w) {
                for (uint256 k; k < 8; ++k) {
                    for (uint256 cp; cp < 2; ++cp) {
                        uint32 sid = _list(us[i], ex[w], uint128(spot - 20e18 + k * 5e18), cp == 0);
                        _cheatMovePosition(a, sid, -0.05e18);
                        _cheatMovePosition(b, sid, 0.05e18);
                    }
                }
            }
            _deposit(alice, a, us[i], 1e15);
        }
        uint64 pe = ex[0];
        for (uint256 i; i < MAX_CLAIM_EXPIRIES; ++i) {
            pe -= 7 days;
            _seedBlockedClaim(a, pe, 1e18);
        }
        assertEq(ch.positionsOf(a).length, MAX_POSITIONS);
        assertEq(ch.underlyingsOf(a).length, MAX_UNDERLYINGS);
        assertEq(ch.claimExpiriesOf(a).length, MAX_CLAIM_EXPIRIES);
        assertLt(ch.accountState(a).equity, 0);
        ah.startLiquidation(a);

        // the feeds print on: the bid folds these rounds itself
        vm.warp(block.timestamp + 1300);
        for (uint256 i; i < us.length; ++i) {
            (uint256 p0,,) = hub.spot(us[i]);
            for (uint256 j = 1; j <= VOL_BACKLOG; ++j) {
                feedOf[us[i]].pushRound(int256((j % 2 == 1 ? p0 * 1002 / 1000 : p0) / 1e10), block.timestamp);
            }
            assertFalse(hub.volCurrent(us[i]));
        }
    }

    function test_gas_liquidation256_worst() public {
        vm.startStateDiffRecording();
        vm.prank(carol);
        uint256 g0 = gasleft();
        ah.bidLiquidation(a, 0.5e18, c, type(int256).max);
        uint256 used = g0 - gasleft();
        VmSafe.AccountAccess[] memory acc = vm.stopAndReturnStateDiff();

        (uint256 kernelRef, uint256 nMargin, uint256 nEwma) = _replayKernelCalls(acc);
        uint256 outside = used - kernelRef;
        uint256 total = TX_BASE + outside + nMargin * STYLUS_MARGIN + nEwma * STYLUS_EWMA;
        console2.log("bid, outside the kernel        ", outside);
        console2.log("kernel calls: margin / ewma     ", nMargin, nEwma);
        console2.log("bid with the Stylus kernel, tx  ", total);

        assertEq(nMargin, 3);
        assertEq(nEwma, MAX_UNDERLYINGS);
        assertEq(ch.positionsOf(c).length, MAX_POSITIONS); // every position moved
        assertEq(ch.claimExpiriesOf(c).length, MAX_CLAIM_EXPIRIES); // every claim moved
        for (uint256 i; i < us.length; ++i) {
            assertTrue(hub.volCurrent(us[i]));
        }
        assertLe(total, LIMIT);
    }

    /// @dev Replays every kernel call the bid made against KernelReference and sums their gas.
    function _replayKernelCalls(VmSafe.AccountAccess[] memory acc)
        internal
        view
        returns (uint256 gasUsed, uint256 nMargin, uint256 nEwma)
    {
        for (uint256 i; i < acc.length; ++i) {
            if (acc[i].account != address(kernel) || acc[i].kind != VmSafe.AccountAccessKind.StaticCall) continue;
            bytes memory data = acc[i].data;
            uint256 g = gasleft();
            (bool ok,) = address(kernel).staticcall(data);
            gasUsed += g - gasleft();
            assertTrue(ok);
            if (bytes4(data) == kernel.margin.selector) ++nMargin;
            else ++nEwma;
        }
    }

    function _seedBlockedClaim(uint256 id, uint64 expiry, uint256 wad) internal {
        bytes memory code = address(ch).code;
        vm.etch(address(ch), address(new BlockedClaimSeeder()).code);
        BlockedClaimSeeder(address(ch)).seed(id, expiry, wad);
        vm.etch(address(ch), code);
    }
}
