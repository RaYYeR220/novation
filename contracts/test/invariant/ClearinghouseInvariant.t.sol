// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Fixture} from "../utils/Fixture.sol";
import {Handler, System} from "./Handler.sol";
import {AuctionHouse} from "../../src/core/AuctionHouse.sol";
import {RfqVenue} from "../../src/venues/RfqVenue.sol";
import {VaultConfig} from "../../src/venues/OptionVaultBase.sol";
import {CoveredCallVault} from "../../src/venues/CoveredCallVault.sol";
import {PutWriteVault} from "../../src/venues/PutWriteVault.sol";
import {MockAggregator} from "../../src/mocks/MockAggregator.sol";
import {AccountState, AgentPolicy} from "../../src/interfaces/IClearinghouse.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Position, MAX_POSITIONS, MAX_UNDERLYINGS} from "../../src/types/Types.sol";
import {console2} from "forge-std/console2.sol";

/// @notice Stateful invariants of the whole clearinghouse: trades through every venue, vault
/// entries and exits, agents, price moves and time across sessions and expiries, vol syncs,
/// settlement in any order, claims, liquidations, deficit sales, socialization and repayment
/// (see Handler). Each invariant is checked after every call, and once more after `finish` runs
/// every listed expiry to completion at the end of each run.
///
/// The default profile keeps the campaign short enough for every `forge test`; the
/// `invariant-deep` profile runs it for longer:
///   FOUNDRY_PROFILE=invariant-deep forge test --match-path "test/invariant/*"
contract ClearinghouseInvariantTest is Fixture {
    uint256 internal constant UNIT = 1e12; // WAD per raw USDG unit

    Handler internal handler;
    AuctionHouse internal ah;
    RfqVenue internal rfq;
    CoveredCallVault internal callVault;
    PutWriteVault internal putVault;

    function setUp() public override {
        super.setUp();
        ah = new AuctionHouse(ch, params, hub);
        ch.bindAuctionHouse(address(ah));
        rfq = new RfqVenue(ch);
        ch.addVenue(address(rfq));
        callVault = new CoveredCallVault(IERC20Metadata(address(nvda)), ch, registry, hub, params, _vaultConfig());
        ch.addVenue(address(callVault));
        putVault =
            new PutWriteVault(IERC20Metadata(address(usdg)), address(spy), ch, registry, hub, params, _vaultConfig());
        ch.addVenue(address(putVault));
        ch.finalizeSetup();

        handler = new Handler(
            System({
                ch: ch,
                ah: ah,
                hub: hub,
                registry: registry,
                params: params,
                insurance: insurance,
                venue: venue,
                rfq: rfq,
                callVault: callVault,
                putVault: putVault,
                usdg: usdg,
                underlyings: [address(nvda), address(spy)],
                feeds: [feedOf[address(nvda)], feedOf[address(spy)]]
            })
        );

        // A selector listed n times is picked n times as often: trading and price moves dominate,
        // so the books are big enough for the default paths to matter.
        _target(Handler.tradeViaVenue.selector, 4);
        _target(Handler.rfqFill.selector, 2);
        _target(Handler.vaultBuy.selector, 2);
        _target(Handler.vaultSellBack.selector, 1);
        _target(Handler.movePrice.selector, 2);
        _target(Handler.adverseMove.selector, 2);
        _target(Handler.warp.selector, 2);
        _target(Handler.withdrawToMargin.selector, 2);
        _target(Handler.deposit.selector, 1);
        _target(Handler.withdraw.selector, 1);
        _target(Handler.grantAgent.selector, 1);
        _target(Handler.vaultDeposit.selector, 1);
        _target(Handler.vaultRedeem.selector, 1);
        _target(Handler.vaultRequestRedeem.selector, 1);
        _target(Handler.vaultRoll.selector, 1);
        _target(Handler.syncVol.selector, 1);
        _target(Handler.listSeries.selector, 1);
        _target(Handler.settleExpiry.selector, 1);
        _target(Handler.settleAccounts.selector, 1);
        _target(Handler.settleOne.selector, 1);
        _target(Handler.claimAll.selector, 1);
        _target(Handler.startLiquidation.selector, 1);
        _target(Handler.bidLiquidation.selector, 2);
        _target(Handler.bidDeficit.selector, 2);
        _target(Handler.socializeIfEligible.selector, 1);
        _target(Handler.repayDeficit.selector, 1);
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: _selectors}));
    }

    bytes4[] internal _selectors;

    function _target(bytes4 sel, uint256 weight) internal {
        for (uint256 i = 0; i < weight; ++i) {
            _selectors.push(sel);
        }
    }

    function _vaultConfig() internal pure returns (VaultConfig memory c) {
        c.minOtm = 0.05e18;
        c.maxTenorDays = 35;
        c.skewSlope = 0.5e18;
        c.utilSlope = 0.3e18;
        c.spread = 0.02e18;
        c.sessionVolAdd = [uint64(0), 0.05e18, 0.1e18, 0.1e18, 0];
        c.maxTradeQty = 100e18;
        c.maxOpenSeries = 24;
        c.minDelta = 0.05e18;
        c.maxDelta = 0.5e18;
        c.minNewSeriesQty = 1e18;
    }

    /// @notice The handler reads three CHStorage fields straight from storage; their slots must
    /// match what the clearinghouse's own getters report.
    function test_storageReadsMatchGetters() public view {
        uint256[] memory ids = handler.ids();
        uint256 norm;
        for (uint256 i = 0; i < ids.length; ++i) {
            uint256 n = handler.cashNormOf(ids[i]);
            assertEq(n * ch.cashIndex() / 1e18, ch.cashOf(ids[i]), "cashNorm slot");
            norm += n;
        }
        assertGt(norm, 0);
        assertEq(handler.totalCashNorm(), norm, "totalCashNorm slot");
        uint64[] memory xs = handler.expiries();
        assertEq(xs.length, 2);
        assertEq(handler.totalClaimable(xs[0]), 0);
        assertFalse(handler.impaired(xs[0]));
    }

    // ================================================================ 1-8: core

    /// 1. The clearinghouse's USDG covers all cash (the index-scaled aggregate, which is at least
    ///    the sum of every account's floored cash) plus every expiry pool.
    function invariant_usdgCoversCashAndPools() public view {
        uint256[] memory ids = handler.ids();
        uint256 sumCash;
        for (uint256 i = 0; i < ids.length; ++i) {
            sumCash += ch.cashOf(ids[i]);
        }
        uint256 aggregate = handler.totalCashNorm() * ch.cashIndex() / 1e18;
        uint256 held = usdg.balanceOf(address(ch)) * UNIT;
        assertGe(aggregate, sumCash, "per-account cash above the aggregate");
        assertGe(held, aggregate + _sumPools(), "USDG held < cash + pools");
    }

    /// 2. Its balance of each stock token covers all collateral in that token.
    function invariant_tokensCoverCollateral() public view {
        uint256[] memory ids = handler.ids();
        address[2] memory us = handler.underlyings();
        for (uint256 k = 0; k < 2; ++k) {
            uint256 sum;
            for (uint256 i = 0; i < ids.length; ++i) {
                sum += ch.collateralOf(ids[i], us[k]);
            }
            assertGe(IERC20Metadata(us[k]).balanceOf(address(ch)), sum, "token held < collateral");
        }
    }

    /// 3. Per series, open quantities net to zero once what settlement closed is added back, and
    ///    open interest is the sum of the long quantities.
    function invariant_seriesZeroSumAndOpenInterest() public view {
        uint32 n = registry.seriesCount();
        int256[] memory net = new int256[](n + 1);
        uint256[] memory longs = new uint256[](n + 1);
        uint256[] memory ids = handler.ids();
        for (uint256 i = 0; i < ids.length; ++i) {
            Position[] memory ps = ch.positionsOf(ids[i]);
            for (uint256 j = 0; j < ps.length; ++j) {
                net[ps[j].seriesId] += ps[j].qty;
                if (ps[j].qty > 0) longs[ps[j].seriesId] += uint256(int256(ps[j].qty));
            }
        }
        for (uint32 sid = 1; sid <= n; ++sid) {
            assertEq(net[sid] + handler.ghostSettledQty(sid), 0, "series not zero-sum");
            assertEq(ch.openInterest(sid), longs[sid], "open interest != sum of longs");
        }
    }

    /// 4. Per expiry, the unsettled short quantity is the sum of the open short positions on it.
    function invariant_unsettledShortQtyPerExpiry() public view {
        uint64[] memory xs = handler.expiries();
        uint64[] memory expiryOf = _expiryTable();
        Position[][] memory books = _books();
        for (uint256 x = 0; x < xs.length; ++x) {
            uint256 shorts;
            for (uint256 i = 0; i < books.length; ++i) {
                Position[] memory ps = books[i];
                for (uint256 j = 0; j < ps.length; ++j) {
                    if (ps[j].qty < 0 && expiryOf[ps[j].seriesId] == xs[x]) shorts += uint256(-int256(ps[j].qty));
                }
            }
            (,, uint256 sq) = ch.pool(xs[x]);
            assertEq(sq, shorts, "unsettledShortQty != open shorts");
        }
    }

    /// 5. Claims paid out of a pool never exceed what was paid into it, and the pool holds exactly
    ///    the difference. Once an expiry is fully settled, the claims it created are at most what
    ///    its payers owed (longs round down, shorts up). A complete, unimpaired pool covers every
    ///    outstanding claim.
    function invariant_claimsNeverExceedPaidIn() public view {
        uint64[] memory xs = handler.expiries();
        uint64[] memory expiryOf = _expiryTable();
        Position[][] memory books = _books();
        for (uint256 x = 0; x < xs.length; ++x) {
            _checkPool(xs[x], expiryOf, books);
        }
    }

    function _checkPool(uint64 e, uint64[] memory expiryOf, Position[][] memory books) internal view {
        uint256 paidIn = handler.ghostPaidIn(e);
        uint256 paidOut = handler.ghostClaimsPaid(e);
        assertLe(paidOut, paidIn, "claims paid > paid in");
        (uint256 poolWad, uint256 pending, uint256 sq) = ch.pool(e);
        assertEq(poolWad, paidIn - paidOut, "pool != paid in - claims paid");

        uint256[] memory ids = handler.ids();
        bool open;
        uint256 claims;
        for (uint256 i = 0; i < ids.length; ++i) {
            claims += ch.claimable(ids[i], e);
            for (uint256 j = 0; j < books[i].length; ++j) {
                if (expiryOf[books[i][j].seriesId] == e) open = true;
            }
        }
        if (!open) assertLe(handler.ghostClaimsCreated(e), handler.ghostOwed(e), "claims created > owed");
        if (sq == 0 && pending == 0 && !handler.impaired(e)) assertGe(poolWad, claims, "pool < claims");
    }

    /// 6. The cash index never increases, moves only with a LossSocialized event, and stays in
    ///    [1, 1e18].
    function invariant_cashIndexNeverIncreases() public view {
        assertEq(handler.ghostIndexIncreases(), 0, "cash index increased");
        assertEq(handler.ghostIndexMovesWithoutEvent(), 0, "cash index moved without LossSocialized");
        uint256 index = ch.cashIndex();
        assertLe(index, 1e18);
        assertGe(index, 1);
    }

    /// 7. An account that opened risk in the last call (a trade through any venue, a vault sale, a
    ///    liquidation or deficit-sale bid), or withdrew while holding positions, ends it at or
    ///    above initial margin.
    function invariant_openingTradesLeaveHealthy() public view {
        uint256[] memory xs = handler.openers();
        for (uint256 i = 0; i < xs.length; ++i) {
            AccountState memory st = ch.accountState(xs[i]);
            assertGe(st.equity, int256(st.im), "opening side below IM");
        }
    }

    /// 8. The InsuranceFund's outstanding bridges match its Covered, Recovered and WrittenOff
    ///    events and, exactly, the bridges the clearinghouse books against accounts.
    function invariant_insuranceOutstandingMatchesBridges() public view {
        uint256 out = insurance.outstandingWad();
        assertEq(
            out,
            handler.ghostCovered() - handler.ghostRecovered() - handler.ghostWrittenOff(),
            "outstanding != covered - recovered - written off"
        );
        uint64[] memory xs = handler.expiries();
        uint256[] memory ids = handler.ids();
        uint256 bridged;
        for (uint256 i = 0; i < ids.length; ++i) {
            for (uint256 x = 0; x < xs.length; ++x) {
                (, uint256 b,) = ch.deficitOf(ids[i], xs[x]);
                bridged += b;
            }
        }
        assertEq(out, bridged, "outstanding != bridges booked on accounts");
    }

    // ================================================================ bookkeeping

    /// The index-scaled cash norms of all accounts add up to the total norm.
    function invariant_cashNormBookkeeping() public view {
        uint256[] memory ids = handler.ids();
        uint256 sum;
        for (uint256 i = 0; i < ids.length; ++i) {
            sum += handler.cashNormOf(ids[i]);
        }
        assertEq(sum, handler.totalCashNorm(), "sum of cash norms != total");
    }

    /// An account's deficit is its per-expiry parts plus its socialized debt; each expiry's
    /// pending is the sum of the accounts' pending parts; the list of deficit expiries is exactly
    /// the expiries with something owed.
    function invariant_deficitBookkeeping() public view {
        uint64[] memory xs = handler.expiries();
        uint256[] memory ids = handler.ids();
        uint256[] memory pendingSum = new uint256[](xs.length);
        for (uint256 i = 0; i < ids.length; ++i) {
            uint256 parts = ch.socializedDebtOf(ids[i]);
            uint256 owing;
            uint256 total;
            for (uint256 x = 0; x < xs.length; ++x) {
                uint256 b;
                uint256 p;
                (total, b, p) = ch.deficitOf(ids[i], xs[x]);
                parts += b + p;
                pendingSum[x] += p;
                if (b + p != 0) {
                    ++owing;
                    assertTrue(_contains(ch.deficitExpiriesOf(ids[i]), xs[x]), "owed expiry not tracked");
                }
            }
            (total,,) = ch.deficitOf(ids[i], 0);
            assertEq(total, parts, "deficit != parts + socialized debt");
            assertEq(ch.deficitExpiriesOf(ids[i]).length, owing, "stale deficit expiry tracked");
        }
        for (uint256 x = 0; x < xs.length; ++x) {
            (, uint256 pending,) = ch.pool(xs[x]);
            assertEq(pending, pendingSum[x], "pending != sum of accounts' pending");
        }
    }

    /// Each expiry's total claimable is the sum of the accounts' claims, and each account's
    /// claim total is the sum over expiries.
    function invariant_claimBookkeeping() public view {
        uint64[] memory xs = handler.expiries();
        uint256[] memory ids = handler.ids();
        uint256[] memory perAccount = new uint256[](ids.length);
        for (uint256 x = 0; x < xs.length; ++x) {
            uint256 sum;
            for (uint256 i = 0; i < ids.length; ++i) {
                uint256 c = ch.claimable(ids[i], xs[x]);
                sum += c;
                perAccount[i] += c;
            }
            assertEq(handler.totalClaimable(xs[x]), sum, "totalClaimable != sum of claims");
        }
        for (uint256 i = 0; i < ids.length; ++i) {
            assertEq(ch.claimableTotalOf(ids[i]), perAccount[i], "claimableTotal != sum of claims");
        }
    }

    /// No account holds more than MAX_POSITIONS positions or MAX_UNDERLYINGS underlyings, and no
    /// position is below the minimum trade size.
    function invariant_positionLimits() public view {
        uint256 minQty = params.globals().minTradeQty;
        uint256[] memory ids = handler.ids();
        for (uint256 i = 0; i < ids.length; ++i) {
            Position[] memory ps = ch.positionsOf(ids[i]);
            assertLe(ps.length, MAX_POSITIONS, "too many positions");
            assertLe(ch.underlyingsOf(ids[i]).length, MAX_UNDERLYINGS, "too many underlyings");
            for (uint256 j = 0; j < ps.length; ++j) {
                int256 q = ps[j].qty;
                assertTrue(q != 0, "zero position kept");
                assertGe(q > 0 ? uint256(q) : uint256(-q), minQty, "dust position");
            }
        }
    }

    // ================================================================ ghost checks

    /// A vault's share price doesn't move on a deposit or a redemption beyond rounding (checked by
    /// the handler around each one).
    function invariant_vaultSharePriceStableOnEntryExit() public view {
        assertEq(handler.violations("sharePrice"), 0, handler.firstViolation("sharePrice"));
    }

    /// Settlement can't be blocked or used to move value: a priced expiry always settles in the
    /// registry, settleAccount always goes through and moves equity by less than one USDG unit,
    /// a complete pool always pays its claims, every run ends with every expiry settled and
    /// nothing pending, and every debt can then be repaid from cash (but for the sub-unit rest of
    /// a socialized debt, see InvariantRegressions.t.sol).
    function invariant_settlementNeverBlocked() public view {
        assertEq(handler.violations("liveness"), 0, handler.firstViolation("liveness"));
    }

    /// An agent-acted side that opened risk in the last call stays within its policy's
    /// worst-loss budget.
    function invariant_agentOpeningWithinBudget() public view {
        Handler.AgentSide[] memory xs = handler.agentSides();
        for (uint256 i = 0; i < xs.length; ++i) {
            AgentPolicy memory p = ch.agentPolicy(xs[i].id, xs[i].agent);
            assertLe(ch.accountState(xs[i].id).im, p.maxWorstLoss, "agent opened past its budget");
        }
    }

    // ================================================================ end of run

    /// Runs every listed expiry to completion, then checks every invariant on the final state.
    function afterInvariant() external {
        handler.finish();
        invariant_usdgCoversCashAndPools();
        invariant_tokensCoverCollateral();
        invariant_seriesZeroSumAndOpenInterest();
        invariant_unsettledShortQtyPerExpiry();
        invariant_claimsNeverExceedPaidIn();
        invariant_cashIndexNeverIncreases();
        invariant_insuranceOutstandingMatchesBridges();
        invariant_cashNormBookkeeping();
        invariant_deficitBookkeeping();
        invariant_claimBookkeeping();
        invariant_positionLimits();
        invariant_vaultSharePriceStableOnEntryExit();
        invariant_settlementNeverBlocked();
        if (vm.envOr("INVARIANT_SUMMARY", false)) _summary();
    }

    // ================================================================ helpers

    function _sumPools() internal view returns (uint256 sum) {
        uint64[] memory xs = handler.expiries();
        for (uint256 x = 0; x < xs.length; ++x) {
            (uint256 p,,) = ch.pool(xs[x]);
            sum += p;
        }
    }

    /// @dev Every account's positions, in handler.ids() order.
    function _books() internal view returns (Position[][] memory books) {
        uint256[] memory ids = handler.ids();
        books = new Position[][](ids.length);
        for (uint256 i = 0; i < ids.length; ++i) {
            books[i] = ch.positionsOf(ids[i]);
        }
    }

    /// @dev Expiry of every series id (index = id; ids start at 1).
    function _expiryTable() internal view returns (uint64[] memory t) {
        uint32 n = registry.seriesCount();
        t = new uint64[](n + 1);
        for (uint32 sid = 1; sid <= n; ++sid) {
            t[sid] = handler.expiryOf(sid);
        }
    }

    function _contains(uint64[] memory xs, uint64 e) internal pure returns (bool) {
        for (uint256 i = 0; i < xs.length; ++i) {
            if (xs[i] == e) return true;
        }
        return false;
    }

    /// @dev What the campaign reached so far, summed over its runs (set INVARIANT_SUMMARY=true
    /// and run with -vv; the last run's log holds the totals). The running totals live in
    /// environment variables of the forge process, the only state that survives between runs.
    function _summary() internal {
        string[26] memory ops = [
            "deposit",
            "withdraw",
            "withdrawToMargin",
            "trade",
            "rfq",
            "grantAgent",
            "vaultBuy",
            "vaultSellBack",
            "vaultDeposit",
            "vaultRedeem",
            "vaultRequestRedeem",
            "vaultRoll",
            "movePrice",
            "adverseMove",
            "warp",
            "listSeries",
            "settleExpiry",
            "settleExpiryFallback",
            "settleAccount",
            "claim",
            "liquidationStart",
            "liquidationBid",
            "deficitBid",
            "socialize",
            "repayDeficit",
            "socialDebtSubUnitRest"
        ];
        for (uint256 i = 0; i < ops.length; ++i) {
            console2.log(ops[i], _accumulate(ops[i], handler.count(bytes32(bytes(ops[i])))));
        }
        console2.log("runs", _accumulate("runs", 1));
        console2.log("runs with a lowered cash index", _accumulate("indexCut", ch.cashIndex() < 1e18 ? 1 : 0));
        console2.log("runs with a bridge outstanding", _accumulate("bridged", insurance.outstandingWad() != 0 ? 1 : 0));
    }

    function _accumulate(string memory key, uint256 add) internal returns (uint256 total) {
        string memory name = string.concat("NOVATION_INVARIANT_", key);
        total = vm.envOr(name, uint256(0)) + add;
        vm.setEnv(name, vm.toString(total));
    }
}
