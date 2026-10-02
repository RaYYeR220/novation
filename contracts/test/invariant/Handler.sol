// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Clearinghouse} from "../../src/core/Clearinghouse.sol";
import {AuctionHouse} from "../../src/core/AuctionHouse.sol";
import {MarketDataHub} from "../../src/core/MarketDataHub.sol";
import {SeriesRegistry} from "../../src/core/SeriesRegistry.sol";
import {RiskParams} from "../../src/core/RiskParams.sol";
import {InsuranceFund} from "../../src/core/InsuranceFund.sol";
import {RfqVenue, Quote} from "../../src/venues/RfqVenue.sol";
import {OptionVaultBase} from "../../src/venues/OptionVaultBase.sol";
import {MockAggregator} from "../../src/mocks/MockAggregator.sol";
import {MockUSDG} from "../../src/mocks/MockUSDG.sol";
import {IClearinghouse, TradeParams, AgentPolicy, AccountState} from "../../src/interfaces/IClearinghouse.sol";
import {IInsuranceFund} from "../../src/interfaces/IInsuranceFund.sol";
import {UnderlyingParams, GlobalParams} from "../../src/interfaces/IRiskParams.sol";
import {BlackScholes} from "../../src/libraries/BlackScholes.sol";
import {FixedPointMath as F} from "../../src/libraries/FixedPointMath.sol";
import {NyseCalendar} from "../../src/libraries/NyseCalendar.sol";
import {Position, Series, Session} from "../../src/types/Types.sol";
import {TestVenue} from "../utils/Fixture.sol";

/// @notice Everything the handler drives, deployed by the invariant suite.
struct System {
    Clearinghouse ch;
    AuctionHouse ah;
    MarketDataHub hub;
    SeriesRegistry registry;
    RiskParams params;
    InsuranceFund insurance;
    TestVenue venue;
    RfqVenue rfq;
    OptionVaultBase callVault; // covered calls on the first underlying
    OptionVaultBase putVault; // cash-secured puts on the second underlying
    MockUSDG usdg;
    address[2] underlyings;
    MockAggregator[2] feeds;
}

/// @notice Drives the whole clearinghouse for the invariant suite: five trading actors (each with
/// an agent key), a well-funded liquidator, two vaults, the RFQ venue and the test venue, over
/// two underlyings and a rolling set of weekly expiries (plus a backstop account that only bids
/// in the end-of-run deficit sales). Inputs are bounded so most calls do something; calls that
/// the protocol refuses simply revert and are discarded. It inherits Test only for the cheatcodes
/// and so that the size report skips it.
///
/// Every action runs inside `tracked`, which keeps ghost books from the events the call emitted
/// (pool inflows and claim payouts per expiry, settled quantities per series, insurance cover,
/// recoveries and write-offs, cash-index moves) and lists the accounts that took on risk, for the
/// suite to check against storage after the call. Paths whose failure would itself be a bug
/// (settling an account once its expiry is priced, a claim on a complete pool, settlement
/// moving equity, a vault entry or exit moving the share price) are wrapped and recorded as
/// violations instead of reverting.
contract Handler is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant UNIT = 1e12; // WAD per raw USDG unit
    uint256 internal constant N_ACTORS = 5;
    uint256 internal constant MAX_SERIES = 32;
    uint256 internal constant MAX_LIVE_SERIES = 10;
    uint256 internal constant LOT = 0.01e18;
    uint256 internal constant FALLBACK_DELAY = 72 hours;
    uint256 internal constant VIRTUAL_SHARES = 1e6; // the vaults' 6-decimal share offset

    bytes32 internal constant CH_SLOT = 0xdb4f0b7186370eee7ccd7c24237257b9ec2a4e76df5b9d3882697c1f0a732400;

    struct Round {
        uint80 id;
        uint64 at;
    }

    struct AgentSide {
        uint256 id;
        address agent;
    }

    /// @dev A vault exit's state before it runs (see vaultExit).
    struct Exit {
        uint256 a0; // totalAssets
        uint256 s0; // totalSupply
        uint256 shares0; // the owner's shares
        IERC20 asset;
        bool inKind; // the asset isn't USDG: a USDG leg may come on top
        uint256 tokens0; // the owner's asset balance
        uint256 cash0; // the owner's USDG balance
    }

    // ---------------------------------------------------------------- system

    Clearinghouse public immutable ch;
    AuctionHouse public immutable ah;
    MarketDataHub public immutable hub;
    SeriesRegistry public immutable registry;
    RiskParams public immutable params;
    InsuranceFund public immutable insurance;
    TestVenue public immutable venue;
    RfqVenue public immutable rfq;
    OptionVaultBase public immutable callVault;
    OptionVaultBase public immutable putVault;
    MockUSDG public immutable usdg;

    address[2] internal _us;
    MockAggregator[2] internal _feeds;

    // ---------------------------------------------------------------- actors

    uint256[N_ACTORS] internal _pks;
    address[N_ACTORS] public actors;
    uint256[N_ACTORS] public actorIds;
    uint256[N_ACTORS] internal _agentPks;
    address[N_ACTORS] public agents;
    address public liquidator;
    uint256 public liquidatorId;
    address public backstop; // bids in the end-of-run deficit sales only
    uint256 public backstopId;
    uint256[] internal _ids; // every subaccount, vaults included

    // ---------------------------------------------------------------- series and rounds

    uint32[] internal _series;
    mapping(uint32 sid => uint64) public expiryOf;
    uint64[] internal _expiries; // ascending
    mapping(address u => mapping(uint64 e => bool)) public listedOn;
    mapping(address u => Round[]) internal _rounds;
    uint256 internal _nonce;

    // ---------------------------------------------------------------- ghosts

    // into pool[e]: payers' cash, bridges, deficit repayments and socialized loss
    mapping(uint64 e => uint256) public ghostPaidIn;
    mapping(uint64 e => uint256) public ghostClaimsPaid; // out of pool[e]
    mapping(uint64 e => uint256) public ghostOwed; // net payoffs owed by payers at settlement
    mapping(uint64 e => uint256) public ghostClaimsCreated; // net payoffs credited to receivers as claims
    mapping(uint32 sid => int256) public ghostSettledQty; // quantity closed by settleAccount, signed
    uint256 public ghostCovered;
    uint256 public ghostRecovered;
    uint256 public ghostWrittenOff;
    uint256 public ghostPremiums;
    uint256 public ghostFees;
    uint256 public ghostIndexIncreases;
    uint256 public ghostIndexMovesWithoutEvent;

    // the accounts that opened risk, bought a lot or withdrew in the last call: checked against IM
    // after it
    uint256[] internal _openers;
    AgentSide[] internal _agentSides;

    // recorded violations, by category
    mapping(bytes32 category => uint256) public violations;
    mapping(bytes32 category => string) public firstViolation;

    // successful operations, for the run summary
    mapping(bytes32 op => uint256) public count;

    constructor(System memory s) {
        ch = s.ch;
        ah = s.ah;
        hub = s.hub;
        registry = s.registry;
        params = s.params;
        insurance = s.insurance;
        venue = s.venue;
        rfq = s.rfq;
        callVault = s.callVault;
        putVault = s.putVault;
        usdg = s.usdg;
        _us = s.underlyings;
        _feeds = s.feeds;

        for (uint256 k = 0; k < 2; ++k) {
            (uint80 rid,,, uint256 at,) = _feeds[k].latestRoundData();
            _rounds[_us[k]].push(Round(rid, uint64(at)));
        }

        for (uint256 i = 0; i < N_ACTORS; ++i) {
            _pks[i] = 0xA11CE + i;
            actors[i] = vm.addr(_pks[i]);
            _agentPks[i] = 0xA6E47 + i;
            agents[i] = vm.addr(_agentPks[i]);
            vm.prank(actors[i]);
            actorIds[i] = ch.createSubaccount();
            _mintDeposit(actors[i], actorIds[i], address(usdg), (1_000 + 1_000 * i) * 1e6);
            if (i != 0) _mintDeposit(actors[i], actorIds[i], _us[0], 1e18 * i);
            if (i % 2 == 1) _mintDeposit(actors[i], actorIds[i], _us[1], 1e18);
        }
        liquidator = vm.addr(0x11C1D);
        vm.prank(liquidator);
        liquidatorId = ch.createSubaccount();
        _mintDeposit(liquidator, liquidatorId, address(usdg), 1_000_000 * 1e6);
        backstop = vm.addr(0xBAC5);
        vm.prank(backstop);
        backstopId = ch.createSubaccount();
        _mintDeposit(backstop, backstopId, address(usdg), 10_000_000 * 1e6);

        // ids are sequential from 1: the vaults' accounts come first
        uint256 next = backstopId + 1;
        for (uint256 id = 1; id < next; ++id) {
            _ids.push(id);
        }

        // seed the vaults and the InsuranceFund
        address seeder = vm.addr(0x5EED);
        _vaultDeposit(seeder, callVault, 40e18);
        _vaultDeposit(seeder, putVault, 40_000 * 1e6);
        usdg.mint(address(insurance), 100 * 1e6);

        // series for the next two weekly expiries: OTM calls and puts on both underlyings
        uint64 e1 = uint64(NyseCalendar.nextWeeklyExpiry(_now()));
        uint64 e2 = uint64(NyseCalendar.nextWeeklyExpiry(e1));
        _listAround(e1);
        _listAround(e2);
    }

    // ================================================================ tracking

    modifier tracked() {
        delete _openers;
        delete _agentSides;
        uint256 idx0 = ch.cashIndex();
        Position[][] memory pre = _snapshotPositions();
        vm.recordLogs();
        _;
        _ingest(vm.getRecordedLogs(), pre, idx0);
    }

    // ================================================================ funds

    function deposit(uint256 actorSeed, uint256 tokenSeed, uint256 amount) external tracked {
        uint256 a = actorSeed % N_ACTORS;
        uint256 k = tokenSeed % 3;
        if (k == 0) {
            _mintDeposit(actors[a], actorIds[a], address(usdg), _bound(amount, 10e6, 5_000e6));
        } else {
            _mintDeposit(actors[a], actorIds[a], _us[k - 1], _bound(amount, 0.1e18, 20e18));
        }
        ++count["deposit"];
    }

    function withdraw(uint256 actorSeed, uint256 tokenSeed, uint256 amount) external tracked {
        uint256 a = actorSeed % N_ACTORS;
        uint256 k = tokenSeed % 3;
        address token = k == 0 ? address(usdg) : _us[k - 1];
        uint256 bal = k == 0 ? ch.cashOf(actorIds[a]) / UNIT : ch.collateralOf(actorIds[a], token);
        if (bal == 0) return;
        vm.prank(actors[a]);
        ch.withdraw(actorIds[a], token, _bound(amount, 1, bal), actors[a]);
        _noteWithdrawal(actorIds[a]);
        ++count["withdraw"];
    }

    /// @notice Withdraws 50% to 99.9% of the cash above initial margin: leaves the account close to
    /// its IM, so the next price moves can push it into liquidation or a settlement deficit.
    function withdrawToMargin(uint256 actorSeed, uint256 fraction) external tracked {
        uint256 a = actorSeed % N_ACTORS;
        uint256 id = actorIds[a];
        AccountState memory st = ch.accountState(id);
        if (st.equity <= int256(st.im)) return;
        uint256 free = uint256(st.equity - int256(st.im));
        uint256 cash = ch.cashOf(id);
        uint256 amount = (free < cash ? free : cash) * _bound(fraction, 0.5e18, 0.999e18) / WAD / UNIT;
        if (amount == 0) return;
        vm.prank(actors[a]);
        ch.withdraw(id, address(usdg), amount, actors[a]);
        _noteWithdrawal(id);
        ++count["withdrawToMargin"];
    }

    // ================================================================ trading

    /// @notice A trade through the test venue between two actors, at a premium within 30% of the
    /// mark (BlackScholes at the hub's mark vol, the price the kernel marks positions at).
    function tradeViaVenue(
        uint256 takerSeed,
        uint256 makerSeed,
        uint256 seriesSeed,
        uint256 qtySeed,
        uint256 premiumSeed,
        bool takerBuys
    ) external tracked {
        (bool ok, uint32 sid) = _liveSeries(seriesSeed);
        if (!ok) return;
        (uint256 t, uint256 m) = _pair(takerSeed, makerSeed);
        uint256 px = _mark(sid) * _bound(premiumSeed, 0.7e18, 1.3e18) / WAD;
        uint256 qty = _affordable(_qty(qtySeed, 20e18), px, takerBuys ? actorIds[t] : actorIds[m]);
        if (qty == 0) return;
        int256 sq = takerBuys ? int256(qty) : -int256(qty);
        uint256 premium = px * qty / WAD;
        int256 tOld = _qtyOf(actorIds[t], sid);
        int256 mOld = _qtyOf(actorIds[m], sid);
        venue.trade(
            TradeParams({
                takerActor: actors[t],
                makerActor: actors[m],
                takerId: actorIds[t],
                makerId: actorIds[m],
                seriesId: sid,
                qty: sq,
                premium: premium
            })
        );
        _noteSide(actorIds[t], tOld, tOld + sq, address(0));
        _noteSide(actorIds[m], mOld, mOld - sq, address(0));
        ++count["trade"];
    }

    /// @notice A signed RFQ quote filled by another actor. `agentBits % 4` of 1: the maker's agent
    /// signs; 2: the taker's agent fills (when it has a live policy, see grantAgent; otherwise the
    /// owner acts).
    function rfqFill(
        uint256 makerSeed,
        uint256 takerSeed,
        uint256 seriesSeed,
        uint256 qtySeed,
        uint256 priceSeed,
        bool makerSells,
        uint8 agentBits
    ) external tracked {
        (bool ok, uint32 sid) = _liveSeries(seriesSeed);
        if (!ok) return;
        (uint256 t, uint256 m) = _pair(takerSeed, makerSeed);
        bool makerAgent = agentBits % 4 == 1 && _agentLive(m);
        bool takerAgent = agentBits % 4 == 2 && _agentLive(t);
        uint256 px = _mark(sid) * _bound(priceSeed, 0.7e18, 1.3e18) / WAD;
        uint256 qty = _affordable(_qty(qtySeed, 20e18), px, makerSells ? actorIds[t] : actorIds[m]);
        if (qty == 0) return;
        Quote memory q = Quote({
            signer: makerAgent ? agents[m] : actors[m],
            makerId: actorIds[m],
            seriesId: sid,
            makerSells: makerSells,
            maxQty: qty,
            price: px,
            deadline: uint64(_now() + 1 hours),
            nonce: ++_nonce
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerAgent ? _agentPks[m] : _pks[m], rfq.hashQuote(q));
        address takerActor = takerAgent ? agents[t] : actors[t];
        int256 tOld = _qtyOf(actorIds[t], sid);
        int256 mOld = _qtyOf(actorIds[m], sid);
        vm.prank(takerActor);
        rfq.fill(q, abi.encodePacked(r, s, v), actorIds[t], qty);
        int256 tq = makerSells ? int256(qty) : -int256(qty);
        _noteSide(actorIds[t], tOld, tOld + tq, takerAgent ? takerActor : address(0));
        _noteSide(actorIds[m], mOld, mOld - tq, makerAgent ? q.signer : address(0));
        ++count["rfq"];
    }

    function grantAgent(uint256 actorSeed, uint256 lossSeed, uint256 premiumSeed, uint256 durationSeed, uint8 mask)
        external
        tracked
    {
        uint256 a = actorSeed % N_ACTORS;
        AgentPolicy memory p = AgentPolicy({
            maxWorstLoss: uint128(_bound(lossSeed, 50e18, 20_000e18)),
            maxPremiumPerTrade: uint128(_bound(premiumSeed, 5e18, 2_000e18)),
            allowedMask: uint64(1 + mask % 3),
            expiresAt: uint64(_now() + _bound(durationSeed, 1 hours, 7 days))
        });
        vm.prank(actors[a]);
        ch.grantAgent(actorIds[a], agents[a], p);
        ++count["grantAgent"];
    }

    // ================================================================ vaults

    function vaultBuy(uint256 actorSeed, bool calls, uint256 seriesSeed, uint256 qtySeed) external tracked {
        if (!_marketOpen()) return;
        OptionVaultBase v = calls ? callVault : putVault;
        (bool ok, uint32 sid) = _offered(calls, seriesSeed);
        if (!ok) return;
        uint256 a = actorSeed % N_ACTORS;
        uint256 qty = _bound(qtySeed, 100, 2_000) * LOT; // 1 to 20 contracts
        try v.quote(sid, 1e18, true) returns (uint256 perContract) {
            qty = _affordable(qty, perContract, actorIds[a]);
        } catch {}
        if (qty == 0) return;
        uint256 vid = v.vaultId();
        int256 tOld = _qtyOf(actorIds[a], sid);
        int256 vOld = _qtyOf(vid, sid);
        vm.prank(actors[a]);
        v.buy(sid, qty, type(uint256).max, actorIds[a]);
        _noteSide(actorIds[a], tOld, tOld + int256(qty), address(0));
        _noteSide(vid, vOld, vOld - int256(qty), address(0));
        ++count["vaultBuy"];
    }

    function vaultSellBack(uint256 actorSeed, bool calls, uint256 seriesSeed, uint256 qtySeed) external tracked {
        if (!_marketOpen()) return;
        OptionVaultBase v = calls ? callVault : putVault;
        uint256 a = actorSeed % N_ACTORS;
        (bool ok, uint32 sid) = _heldAgainst(v, calls, actorIds[a], seriesSeed);
        if (!ok) return;
        int256 own = _qtyOf(actorIds[a], sid);
        int256 vq = _qtyOf(v.vaultId(), sid);
        if (own <= 0 || vq >= 0) return;
        uint256 cap = uint256(own) < uint256(-vq) ? uint256(own) : uint256(-vq);
        // whole lots (no side may be left with a sub-lot position), or everything
        uint256 qty = cap < LOT || qtySeed % 4 == 0 ? cap : _bound(qtySeed, 1, cap / LOT) * LOT;
        vm.prank(actors[a]);
        v.sellBack(sid, qty, 0, actorIds[a]);
        ++count["vaultSellBack"];
    }

    /// @notice A deposit at NAV must leave every other holder's share price where it was (up to
    /// rounding in the vault's favour). The vol is synced first so the deposit's own sync can't
    /// re-mark the book in between.
    function vaultDeposit(uint256 actorSeed, bool calls, uint256 amount) external tracked {
        if (!_marketOpen()) return;
        OptionVaultBase v = calls ? callVault : putVault;
        uint256 a = actorSeed % N_ACTORS;
        amount = calls ? _bound(amount, 0.01e18, 20e18) : _bound(amount, 1e6, 5_000e6);
        hub.syncVol(v.underlying());
        uint256 a0 = v.totalAssets();
        uint256 s0 = v.totalSupply();
        _vaultDeposit(actors[a], v, amount);
        _checkSharePrice(v, a0, s0, 0, "deposit");
        ++count["vaultDeposit"];
    }

    /// @notice An instant exit: `mode % 3` of 0 is redeem, 1 redeemInKind (its minimums set to the
    /// exact preview, which must be met), 2 withdraw. The covered-call vault pays exits in kind,
    /// its asset plus a USDG leg floored to whole units. With both legs valued at spot, the leaver
    /// gets at most what its burned shares are worth and at most one USDG unit (plus a few wei of
    /// rounding) less; the holders who stay keep their share price, gaining at most that rounding
    /// and never losing more than the conversion's own few wei.
    function vaultExit(uint256 actorSeed, bool calls, uint256 amountSeed, uint8 mode) external tracked {
        if (!_marketOpen()) return;
        // three exits in four from the covered-call vault, the one with a USDG leg
        OptionVaultBase v = calls || amountSeed % 2 == 0 ? callVault : putVault;
        (bool found, address owner) = _shareholder(v, actorSeed);
        if (!found) return;
        hub.syncVol(v.underlying());
        Exit memory x;
        x.a0 = v.totalAssets();
        x.s0 = v.totalSupply();
        x.shares0 = v.balanceOf(owner);
        x.asset = IERC20(v.asset());
        x.inKind = address(x.asset) != address(usdg);
        x.tokens0 = x.asset.balanceOf(owner);
        x.cash0 = usdg.balanceOf(owner);
        mode %= 3;
        if (mode == 2) {
            uint256 cap = v.maxWithdraw(owner);
            if (cap == 0) return;
            uint256 assets = _bound(amountSeed, 1, cap);
            vm.prank(owner);
            v.withdraw(assets, owner, owner);
            if (x.asset.balanceOf(owner) - x.tokens0 != assets) {
                _flag("sharePrice", "withdraw moved other than assets");
            }
        } else {
            uint256 cap = v.maxRedeem(owner);
            if (cap == 0) return;
            uint256 sh = _bound(amountSeed, 1, cap);
            if (mode == 1) {
                (uint256 t, uint256 c) = v.previewRedeemInKind(sh);
                vm.prank(owner);
                (uint256 gotT, uint256 gotC) = v.redeemInKind(sh, owner, owner, t, c);
                if (gotT != t || gotC != c) _flag("sharePrice", "redeemInKind differs from its preview");
                if (x.asset.balanceOf(owner) - x.tokens0 != gotT) _flag("sharePrice", "redeemInKind tokens moved");
                if (x.inKind && usdg.balanceOf(owner) - x.cash0 != gotC) {
                    _flag("sharePrice", "redeemInKind cash moved");
                }
            } else {
                vm.prank(owner);
                uint256 got = v.redeem(sh, owner, owner);
                if (x.asset.balanceOf(owner) - x.tokens0 != got) _flag("sharePrice", "redeem return != tokens moved");
            }
        }
        _checkExit(v, x, owner, mode == 0 ? "redeem" : mode == 1 ? "redeemInKind" : "withdraw");
        ++count[
            mode == 0 ? bytes32("vaultRedeem") : mode == 1 ? bytes32("vaultRedeemInKind") : bytes32("vaultWithdraw")
        ];
    }

    function vaultRequestRedeem(uint256 actorSeed, bool calls, uint256 sharesSeed) external tracked {
        OptionVaultBase v = calls || sharesSeed % 2 == 0 ? callVault : putVault;
        (bool found, address owner) = _shareholder(v, actorSeed);
        if (!found) return;
        uint256 bal = v.balanceOf(owner);
        vm.prank(owner);
        v.requestRedeem(_bound(sharesSeed, 1, bal), owner);
        ++count["vaultRequestRedeem"];
    }

    /// @notice The vault's permissionless roll over every listed expiry, then every receiver's
    /// claims on rolled epochs: the asset, and the USDG leg of an in-kind exit on its own.
    function vaultRoll(bool calls) external tracked {
        OptionVaultBase v = calls ? callVault : putVault;
        v.roll(_expiries);
        for (uint256 i = 0; i < N_ACTORS; ++i) {
            if (v.redeemable(actors[i]) != 0) v.claimRedeemed(actors[i]);
            if (v.redeemableCash(actors[i]) != 0) {
                v.claimRedeemedCash(actors[i]);
                ++count["claimRedeemedCash"];
            }
        }
        ++count["vaultRoll"];
    }

    // ================================================================ market

    /// @notice A new feed round at the current time, up to 15% away from the last one (kept inside
    /// the plausibility band).
    function movePrice(uint256 uSeed, uint256 moveSeed) external tracked {
        uint256 k = uSeed % 2;
        uint256 p = _price(k);
        int256 m = int256(_bound(moveSeed, 0, 0.3e18)) - 0.15e18;
        uint256 np = uint256(int256(p) + int256(p) * m / int256(WAD));
        UnderlyingParams memory up = params.underlying(_us[k]);
        uint256 lo = uint256(up.minPrice) * 11 / 10;
        uint256 hi = uint256(up.maxPrice) * 9 / 10;
        if (np < lo) np = lo;
        if (np > hi) np = hi;
        _push(k, np);
        ++count["movePrice"];
    }

    /// @notice A 5% to 15% move of an actor's first underlying in the direction of its worst
    /// scenario (the kernel's argmin): the market turning against a book, which is what drives
    /// accounts into liquidation and settlement deficits.
    function adverseMove(uint256 actorSeed, uint256 sizeSeed) external tracked {
        uint256 id = actorIds[actorSeed % N_ACTORS];
        Position[] memory ps = ch.positionsOf(id);
        if (ps.length == 0) return;
        uint256 j = ch.accountState(id).worstScenario % 13; // price point; 6 is no move
        if (j == 6) return;
        uint256 k = registry.series(ps[0].seriesId).underlying == _us[0] ? 0 : 1;
        uint256 p = _price(k);
        uint256 size = _bound(sizeSeed, 0.05e18, 0.15e18);
        uint256 np = j < 6 ? p * (WAD - size) / WAD : p * (WAD + size) / WAD;
        UnderlyingParams memory up = params.underlying(_us[k]);
        uint256 lo = uint256(up.minPrice) * 11 / 10;
        uint256 hi = uint256(up.maxPrice) * 9 / 10;
        if (np < lo) np = lo;
        if (np > hi) np = hi;
        _push(k, np);
        ++count["adverseMove"];
    }

    /// @notice Moves time forward by 1 minute to 3 days (two warps in three stay within 12 hours).
    /// At every listed expiry it crosses, the feeds print the close (skipped for one warp in
    /// eight, which leaves a stale pre-close print that only the 72-hour fallback can settle).
    /// `keeper` prints a fresh round at the end. When few series are left live, the next two
    /// weekly expiries are listed around spot, as a listing keeper would.
    function warp(uint256 secs, bool keeper) external tracked {
        secs = _bound(secs, 1 minutes, 3 days);
        if (secs % 3 != 0) secs = secs / 6 + 1 minutes;
        uint256 t = _now() + secs;
        bool closePrint = secs % 8 != 0;
        for (uint256 i = 0; i < _expiries.length; ++i) {
            uint64 e = _expiries[i];
            if (closePrint && _now() < e && e <= t) {
                vm.warp(e);
                _push(0, _price(0));
                _push(1, _price(1));
            }
        }
        vm.warp(t);
        if (keeper) {
            _push(0, _price(0));
            _push(1, _price(1));
        }
        if (_liveCount() < 4 && _series.length + 8 <= MAX_SERIES) {
            uint64 e = uint64(NyseCalendar.nextWeeklyExpiry(t));
            _listAround(e);
            _listAround(uint64(NyseCalendar.nextWeeklyExpiry(e)));
        }
        ++count["warp"];
    }

    function syncVol(uint256 uSeed) external tracked {
        hub.syncVol(_us[uSeed % 2]);
        ++count["syncVol"];
    }

    /// @notice A bounded vol catch-up (what a liquidation runs itself): it reports whether the
    /// estimate has folded the feed's latest round, which must agree with the hub's own view.
    function syncVolUpTo(uint256 uSeed, uint256 rounds) external tracked {
        address u = _us[uSeed % 2];
        bool current = hub.syncVolUpTo(u, _bound(rounds, 1, 64));
        if (current != hub.volCurrent(u)) _flag("liveness", "syncVolUpTo disagrees with volCurrent");
        ++count["syncVolUpTo"];
    }

    /// @notice Lists a series within 15% of spot on one of the next two weekly expiries.
    function listSeries(uint256 uSeed, bool later, uint256 strikeSeed, bool isCall) external tracked {
        if (_series.length >= MAX_SERIES || _liveCount() >= MAX_LIVE_SERIES) return;
        uint256 k = uSeed % 2;
        uint64 e = uint64(NyseCalendar.nextWeeklyExpiry(_now()));
        if (later) e = uint64(NyseCalendar.nextWeeklyExpiry(e));
        _list(k, e, _price(k) * _bound(strikeSeed, 0.85e18, 1.15e18) / WAD, isCall);
        ++count["listSeries"];
    }

    // ================================================================ settlement

    /// @notice Settles a past expiry in the registry for every underlying listed on it: the last
    /// print at or before the close when it is recent enough, else (72 hours on) the first print
    /// after it. Either proof must pass: a refusal is a violation.
    function settleExpiry(uint256 expirySeed) external tracked {
        (bool ok, uint64 e) = _pastExpiry(expirySeed);
        if (!ok) return;
        _settleRegistry(e);
    }

    /// @notice Settles every account holding positions of a priced expiry, net payers first.
    function settleAccounts(uint256 expirySeed) external tracked {
        (bool ok, uint64 e) = _pastExpiry(expirySeed);
        if (!ok || !_registrySettled(e)) return;
        _settlePayersFirst(e, true);
    }

    /// @notice Settles one account, in whatever order the fuzzer picks.
    function settleOne(uint256 idSeed, uint256 expirySeed) external tracked {
        (bool ok, uint64 e) = _pastExpiry(expirySeed);
        if (!ok || !_registrySettled(e)) return;
        uint256 id = _ids[idSeed % _ids.length];
        if (_holdsExpiry(id, e)) _settleChecked(id, e, true);
    }

    /// @notice Claims every claim on an expiry's pool. Refused only while the pool is incomplete.
    function claimAll(uint256 expirySeed) external tracked {
        if (_expiries.length == 0) return;
        _claimAll(_expiries[expirySeed % _expiries.length]);
    }

    // ================================================================ defaults

    /// @notice Starts the liquidation of the first liquidatable account from `targetSeed` on.
    function startLiquidation(uint256 targetSeed) external tracked {
        _syncVols();
        (bool ok, uint256 id) = _liquidatable(targetSeed);
        if (!ok) return;
        ah.startLiquidation(id);
        ++count["liquidationStart"];
    }

    /// @notice Ends the first running liquidation, from `targetSeed` on, whose account recovered
    /// without a bid (anyone may; the auction clock counts market time, so it would otherwise stay
    /// open across a weekend).
    function endLiquidation(uint256 targetSeed) external tracked {
        uint256 n = _ids.length;
        for (uint256 j = 0; j < n; ++j) {
            uint256 id = _ids[(targetSeed + j) % n];
            if (ah.liquidationStartedAt(id) == 0) continue;
            if (ch.accountState(id).liquidatable) continue;
            ah.endLiquidation(id);
            ++count["liquidationEnd"];
            return;
        }
    }

    /// @notice Anyone records a collateral token's price outage, or clears it. The feeds here
    /// always carry a price inside the band, so the token has a usable price exactly when its
    /// session isn't HALTED (a stale feed): the record must then be cleared, and kept otherwise.
    function markUnpriced(uint256 uSeed) external tracked {
        address u = _us[uSeed % 2];
        // a token without a usable price, if either is, so outages get recorded when they happen
        if (hub.session(u) != Session.HALTED && hub.session(_us[(uSeed + 1) % 2]) == Session.HALTED) {
            u = _us[(uSeed + 1) % 2];
        }
        ch.markUnpriced(u);
        (uint256 since,) = ch.priceOutageOf(u);
        if ((since != 0) != (hub.session(u) == Session.HALTED)) {
            _flag("liveness", "price outage record disagrees with the hub");
        }
        ++count[since != 0 ? bytes32("markUnpriced") : bytes32("markPriced")];
    }

    /// @notice Bids on a running liquidation, or starts one on a liquidatable account and bids on
    /// it. The bidder takes over a fraction of the book and must stay above IM.
    function bidLiquidation(uint256 targetSeed, uint256 bidderSeed, uint256 fractionSeed) external tracked {
        _syncVols();
        (bool ok, uint256 id) = _runningLiquidation(targetSeed);
        if (!ok) {
            (ok, id) = _liquidatable(targetSeed);
            if (!ok) return;
            ah.startLiquidation(id);
        }
        (address bidder, uint256 bidderId) = _bidder(bidderSeed);
        if (bidderId == id) (bidder, bidderId) = (liquidator, liquidatorId);
        GlobalParams memory g = params.globals();
        uint256 f = _bound(fractionSeed, 0.05e18, g.maxFractionPerBid);
        AccountState memory st = _checkLiquidationState(id);
        if (st.equity <= int256(uint256(g.dustEquity)) && fractionSeed % 2 == 0) f = WAD;
        bool claims = ch.claimableTotalOf(id) != 0;
        vm.prank(bidder);
        ah.bidLiquidation(id, f, bidderId, type(int256).max);
        _openers.push(bidderId);
        ++count["liquidationBid"];
        if (claims) ++count["bidWithClaims"]; // unpaid claims paid or moved with the fraction
    }

    /// @notice Buys stock collateral of an account in deficit at the sale's discount, up to what
    /// the debt still needs.
    function bidDeficit(uint256 targetSeed, uint256 bidderSeed, uint256 tokenSeed, uint256 amountSeed)
        external
        tracked
    {
        uint256 id = _ids[targetSeed % _ids.length];
        (address bidder, uint256 bidderId) = _bidder(bidderSeed);
        if (bidderId == id) return;
        (bool ok, uint64 e) = _activeSale(id, targetSeed);
        if (!ok) return;
        address[] memory toks = ch.collateralTokensOf(id);
        if (toks.length == 0) return;
        address token = toks[tokenSeed % toks.length];
        uint256 max = _deficitLot(id, e, token);
        if (max == 0) return;
        vm.prank(bidder);
        ah.bidDeficit(id, e, token, _bound(amountSeed, 1, max), bidderId, type(uint256).max);
        _openers.push(bidderId);
        ++count["deficitBid"];
    }

    /// @notice Socializes the pending deficit of an emptied account, where eligible.
    function socializeIfEligible(uint256 targetSeed) external tracked {
        uint256 id = _ids[targetSeed % _ids.length];
        if (ch.positionsOf(id).length != 0) return;
        uint64[] memory xs = ch.deficitExpiriesOf(id);
        for (uint256 i = 0; i < xs.length; ++i) {
            (,, uint256 pending) = ch.deficitOf(id, xs[i]);
            if (pending == 0) continue;
            // refused only for an account that still holds more than dust; no event before that
            try ch.socializeRemainder(id, xs[i]) {
                ++count["socialize"];
            } catch {}
        }
    }

    /// @notice Ends the first deficit sale, from `targetSeed` on, whose account owes nothing more for
    /// it (repaid from its own cash rather than by a bid). Anyone may.
    function endDeficitSale(uint256 targetSeed) external tracked {
        uint256 n = _ids.length;
        for (uint256 j = 0; j < n; ++j) {
            uint256 id = _ids[(targetSeed + j) % n];
            for (uint256 i = 0; i < _expiries.length; ++i) {
                uint64 e = _expiries[i];
                if (ah.saleStartedAt(id, e) == 0 || !_saleRepaid(id, e)) continue;
                ah.endDeficitSale(id, e);
                ++count["endDeficitSale"];
                return;
            }
        }
    }

    /// @notice Someone funds an account in deficit with USDG and repays what it owes: the pools'
    /// pending parts, the InsuranceFund's bridges, then its residual socialized debt.
    function repayDeficit(uint256 targetSeed, uint256 amount) external tracked {
        uint256 n = _ids.length;
        for (uint256 j = 0; j < n; ++j) {
            uint256 id = _ids[(targetSeed + j) % n];
            (uint256 owed,,) = ch.deficitOf(id, 0);
            if (owed == 0) continue;
            address payer = actors[amount % N_ACTORS];
            _mintDeposit(payer, id, address(usdg), _bound(amount, 1e6, 2_000e6));
            ch.repayDeficit(id);
            ++count["repayDeficit"];
            return;
        }
    }

    // ================================================================ end of run

    /// @notice Runs every listed expiry to completion: prints the closes, settles the registry
    /// (falling back after 72 hours where the pre-close print is stale), settles every account
    /// payers first, then takes every deficit through the rest of the waterfall (a deficit sale
    /// of the defaulter's stock to a backstop bidder in a live session, socialization of what an
    /// emptied account still owes, repayment from its cash) and claims every claim. Afterwards no
    /// position of a listed expiry is left, nothing is pending, every unimpaired pool has paid
    /// every claim, and every account's debt can be repaid from cash.
    function finish() external tracked {
        uint256 n = _expiries.length;
        for (uint256 i = 0; i < n; ++i) {
            uint64 e = _expiries[i];
            if (_now() < e) {
                vm.warp(e);
                _push(0, _price(0));
                _push(1, _price(1));
            }
        }
        vm.warp(_now() + 1 hours);
        _push(0, _price(0));
        _push(1, _price(1));

        uint256 until;
        for (uint256 i = 0; i < n; ++i) {
            _settleRegistry(_expiries[i]);
            if (!_registrySettled(_expiries[i]) && _expiries[i] + FALLBACK_DELAY + 1 > until) {
                until = _expiries[i] + FALLBACK_DELAY + 1;
            }
        }
        if (until > _now()) {
            vm.warp(until);
            _push(0, _price(0));
            _push(1, _price(1));
            for (uint256 i = 0; i < n; ++i) {
                _settleRegistry(_expiries[i]);
            }
        }

        for (uint256 i = 0; i < n; ++i) {
            uint64 e = _expiries[i];
            if (!_registrySettled(e)) {
                _flag("liveness", "expiry never settled in the registry");
                continue;
            }
            _settlePayersFirst(e, false);
        }
        if (_anyDeficit()) {
            _toLiveSession();
            for (uint256 j = 0; j < _ids.length; ++j) {
                _closeOut(_ids[j]);
            }
        }
        for (uint256 i = 0; i < n; ++i) {
            uint64 e = _expiries[i];
            _claimAll(e);
            (, uint256 pending, uint256 shortQty) = ch.pool(e);
            if (shortQty != 0) _flag("liveness", "short quantity left on a settled expiry");
            if (pending != 0) _flag("liveness", "pending deficit left after the waterfall");
            for (uint256 j = 0; j < _ids.length; ++j) {
                if (_holdsExpiry(_ids[j], e)) _flag("liveness", "position left on a settled expiry");
                if (pending == 0 && !impaired(e) && ch.claimable(_ids[j], e) != 0) {
                    _flag("liveness", "claim left on a complete pool");
                }
            }
        }
        _repayAll();
        _endSales();
    }

    /// @dev With every debt repaid, every deficit sale still running must end (endDeficitSale).
    function _endSales() internal {
        for (uint256 j = 0; j < _ids.length; ++j) {
            for (uint256 i = 0; i < _expiries.length; ++i) {
                uint64 e = _expiries[i];
                if (ah.saleStartedAt(_ids[j], e) == 0) continue;
                try ah.endDeficitSale(_ids[j], e) {
                    ++count["endDeficitSale"];
                } catch {
                    _flag("liveness", "a repaid deficit sale could not be ended");
                }
            }
        }
    }

    function _saleRepaid(uint256 id, uint64 e) internal view returns (bool) {
        (, uint256 bridged, uint256 pending) = ch.deficitOf(id, e);
        return bridged + pending + ch.socializedDebtOf(id) == 0;
    }

    /// @dev Every underlying's vol folded to the feed's latest round, as a keeper does before it
    /// liquidates (a liquidation folds at most 8 rounds itself).
    function _syncVols() internal {
        hub.syncVol(_us[0]);
        hub.syncVol(_us[1]);
    }

    /// @dev liquidationState is accountState plus positionStatus from one pass: both must agree.
    function _checkLiquidationState(uint256 id) internal returns (AccountState memory st) {
        (AccountState memory l, uint256 live, uint256 awaiting) = ch.liquidationState(id);
        st = ch.accountState(id);
        (uint256 live2, uint256 awaiting2) = ch.positionStatus(id);
        if (
            l.equity != st.equity || l.im != st.im || l.mm != st.mm || l.liquidatable != st.liquidatable
                || live != live2 || awaiting != awaiting2
        ) _flag("liveness", "liquidationState disagrees with accountState and positionStatus");
    }

    function _marketOpen() internal view returns (bool) {
        Session sess = NyseCalendar.baseSession(_now());
        return sess == Session.REGULAR || sess == Session.EXTENDED;
    }

    /// @dev Every debt can be repaid from cash: each account still in deficit is funded with what
    /// it owes plus two USDG units and repays, and must then owe nothing (a socialized debt is
    /// booked in whole units, see test_socializedDebtRepayableInFull).
    function _repayAll() internal {
        for (uint256 j = 0; j < _ids.length; ++j) {
            uint256 id = _ids[j];
            (uint256 owed,,) = ch.deficitOf(id, 0);
            if (owed == 0) continue;
            _mintDeposit(liquidator, id, address(usdg), owed / UNIT + 2);
            ch.repayDeficit(id);
            ++count["repayAtEnd"];
            (owed,,) = ch.deficitOf(id, 0);
            if (owed != 0) _flag("liveness", "debt not repayable from cash");
        }
    }

    function _anyDeficit() internal view returns (bool) {
        for (uint256 j = 0; j < _ids.length; ++j) {
            (uint256 owed,,) = ch.deficitOf(_ids[j], 0);
            if (owed != 0) return true;
        }
        return false;
    }

    /// @dev Moves to the next hour with a REGULAR or EXTENDED session (deficit sales pause
    /// otherwise) and prints fresh rounds there.
    function _toLiveSession() internal {
        for (uint256 i = 0; i < 96; ++i) {
            Session sess = NyseCalendar.baseSession(_now());
            if (sess == Session.REGULAR || sess == Session.EXTENDED) break;
            vm.warp(_now() + 1 hours);
        }
        _push(0, _price(0));
        _push(1, _price(1));
    }

    /// @dev The waterfall after settlement for one account: the backstop buys its stock in every
    /// running deficit sale, up to what the debt needs; whatever an emptied account still owes a
    /// pool is socialized; its cash repays the rest.
    function _closeOut(uint256 id) internal {
        if (id == backstopId) return;
        (uint256 owed,,) = ch.deficitOf(id, 0);
        if (owed == 0) return;
        for (uint256 i = 0; i < _expiries.length; ++i) {
            uint64 e = _expiries[i];
            address[] memory toks = ch.collateralTokensOf(id);
            for (uint256 k = 0; k < toks.length; ++k) {
                if (ah.saleStartedAt(id, e) == 0) break;
                uint256 amount = _deficitLot(id, e, toks[k]);
                if (amount == 0) continue;
                vm.prank(backstop);
                ah.bidDeficit(id, e, toks[k], amount, backstopId, type(uint256).max);
                ++count["deficitBid"];
            }
        }
        if (ch.positionsOf(id).length == 0) {
            uint64[] memory xs = ch.deficitExpiriesOf(id);
            for (uint256 i = 0; i < xs.length; ++i) {
                (,, uint256 pending) = ch.deficitOf(id, xs[i]);
                if (pending == 0) continue;
                try ch.socializeRemainder(id, xs[i]) {
                    ++count["socialize"];
                } catch {}
            }
        }
        (owed,,) = ch.deficitOf(id, 0);
        if (owed != 0 && ch.cashOf(id) != 0) {
            ch.repayDeficit(id);
            ++count["repayDeficit"];
        }
    }

    /// @dev The most of `token` a deficit-sale bid on (`id`, `e`) may buy now: what the debt still
    /// needs net of the account's cash, at spot less the sale's discount, capped by the collateral.
    function _deficitLot(uint256 id, uint64 e, address token) internal view returns (uint256) {
        (uint256 d,) = ah.deficitDiscount(id, e);
        (uint256 spot,,) = hub.spot(token);
        uint256 price = spot * (WAD - d) / WAD;
        (, uint256 bridged, uint256 pending) = ch.deficitOf(id, e);
        uint256 owed = bridged + pending + ch.socializedDebtOf(id);
        uint256 cash = ch.cashOf(id);
        if (owed <= cash || price == 0) return 0;
        uint256 max = F.divWadUp(owed - cash, price);
        uint256 coll = ch.collateralOf(id, token);
        return coll < max ? coll : max;
    }

    // ================================================================ views for the suite

    function ids() external view returns (uint256[] memory) {
        return _ids;
    }

    function seriesIds() external view returns (uint32[] memory) {
        return _series;
    }

    function expiries() external view returns (uint64[] memory) {
        return _expiries;
    }

    function openers() external view returns (uint256[] memory) {
        return _openers;
    }

    function agentSides() external view returns (AgentSide[] memory) {
        return _agentSides;
    }

    function underlyings() external view returns (address[2] memory) {
        return _us;
    }

    /// @notice CHStorage.totalCashNorm.
    function totalCashNorm() public view returns (uint256) {
        return uint256(vm.load(address(ch), bytes32(uint256(CH_SLOT) + 2)));
    }

    /// @notice Account.cashNorm of `id`.
    function cashNormOf(uint256 id) public view returns (uint256) {
        bytes32 base = keccak256(abi.encode(id, uint256(CH_SLOT) + 3));
        return uint256(vm.load(address(ch), bytes32(uint256(base) + 1)));
    }

    /// @notice CHStorage.totalClaimable[e].
    function totalClaimable(uint64 e) public view returns (uint256) {
        return uint256(vm.load(address(ch), keccak256(abi.encode(uint256(e), uint256(CH_SLOT) + 16))));
    }

    /// @notice CHStorage.position[id][sid]: (index in the series list + 1) << 128 | uint128(qty).
    function positionSlot(uint256 id, uint32 sid) public view returns (uint256) {
        bytes32 base = keccak256(abi.encode(id, uint256(CH_SLOT) + 8));
        return uint256(vm.load(address(ch), keccak256(abi.encode(uint256(sid), base))));
    }

    /// @notice CHStorage.impaired[e].
    function impaired(uint64 e) public view returns (bool) {
        return uint256(vm.load(address(ch), keccak256(abi.encode(uint256(e), uint256(CH_SLOT) + 17)))) != 0;
    }

    // ================================================================ internal: ghosts

    function _snapshotPositions() internal view returns (Position[][] memory pre) {
        uint256 n = _ids.length;
        pre = new Position[][](n);
        for (uint256 i = 0; i < n; ++i) {
            pre[i] = ch.positionsOf(_ids[i]);
        }
    }

    function _ingest(Vm.Log[] memory logs, Position[][] memory pre, uint256 idx0) internal {
        bool socialized;
        for (uint256 i = 0; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.topics.length == 0) continue;
            bytes32 sig = l.topics[0];
            if (l.emitter == address(ch)) {
                if (sig == IClearinghouse.AccountSettled.selector) {
                    uint256 id = uint256(l.topics[1]);
                    uint64 e = uint64(uint256(l.topics[2]));
                    (int256 net, uint256 paid, uint256 bridged,) =
                        abi.decode(l.data, (int256, uint256, uint256, uint256));
                    ghostPaidIn[e] += paid + bridged;
                    if (net >= 0) ghostClaimsCreated[e] += uint256(net);
                    else ghostOwed[e] += uint256(-net);
                    _noteSettled(pre, id, e);
                    ++count["settleAccount"];
                } else if (sig == IClearinghouse.Claimed.selector) {
                    ghostClaimsPaid[uint64(uint256(l.topics[2]))] += abi.decode(l.data, (uint256));
                    ++count["claim"];
                } else if (sig == IClearinghouse.DeficitReduced.selector) {
                    uint64 e = uint64(uint256(l.topics[2]));
                    (uint256 toPending,) = abi.decode(l.data, (uint256, uint256));
                    if (e != 0) ghostPaidIn[e] += toPending;
                } else if (sig == IClearinghouse.LossSocialized.selector) {
                    (uint256 amount,) = abi.decode(l.data, (uint256, uint256));
                    ghostPaidIn[uint64(uint256(l.topics[1]))] += amount;
                    socialized = true;
                } else if (sig == IClearinghouse.Traded.selector) {
                    (, uint256 premium, uint256 fee,,) =
                        abi.decode(l.data, (int256, uint256, uint256, address, address));
                    ghostPremiums += premium;
                    ghostFees += fee;
                }
            } else if (l.emitter == address(insurance)) {
                if (sig == IInsuranceFund.Covered.selector) {
                    (, uint256 covered) = abi.decode(l.data, (uint256, uint256));
                    ghostCovered += covered;
                } else if (sig == IInsuranceFund.Recovered.selector) {
                    ghostRecovered += abi.decode(l.data, (uint256));
                } else if (sig == IInsuranceFund.WrittenOff.selector) {
                    ghostWrittenOff += abi.decode(l.data, (uint256));
                }
            }
        }
        uint256 idx1 = ch.cashIndex();
        if (idx1 > idx0) ++ghostIndexIncreases;
        if (idx1 != idx0 && !socialized) ++ghostIndexMovesWithoutEvent;
    }

    /// @dev Books the quantities `id` held on `e` before the call as closed by settlement.
    function _noteSettled(Position[][] memory pre, uint256 id, uint64 e) internal {
        for (uint256 k = 0; k < _ids.length; ++k) {
            if (_ids[k] != id) continue;
            Position[] memory ps = pre[k];
            for (uint256 j = 0; j < ps.length; ++j) {
                if (expiryOf[ps[j].seriesId] == e) ghostSettledQty[ps[j].seriesId] += ps[j].qty;
            }
            return;
        }
    }

    /// @dev A side opens when its position grows or flips (the clearinghouse's own rule).
    function _noteSide(uint256 id, int256 oldQty, int256 newQty, address agent) internal {
        bool opening = newQty != 0 && (_abs(newQty) > _abs(oldQty) || (oldQty > 0) != (newQty > 0));
        if (!opening) return;
        _openers.push(id);
        if (agent != address(0)) _agentSides.push(AgentSide(id, agent));
    }

    /// @dev An account with positions must still meet IM after a withdrawal.
    function _noteWithdrawal(uint256 id) internal {
        if (ch.positionsOf(id).length != 0) _openers.push(id);
    }

    function _flag(bytes32 category, string memory what) internal {
        if (violations[category] == 0) firstViolation[category] = what;
        ++violations[category];
    }

    // ================================================================ internal: settlement

    function _settleRegistry(uint64 e) internal {
        uint256 lag = params.globals().maxSettlementLag;
        for (uint256 k = 0; k < 2; ++k) {
            address u = _us[k];
            if (!listedOn[u][e]) continue;
            (, bool done) = registry.settlementPriceOf(u, e);
            if (done) continue;
            (bool found, Round memory r) = _lastRoundAtOrBefore(u, e);
            if (found && e - r.at <= lag) {
                try registry.settleExpiry(u, e, r.id) {
                    ++count["settleExpiry"];
                } catch {
                    _flag("liveness", "settleExpiry refused a valid last-round proof");
                }
            } else if (_now() >= uint256(e) + FALLBACK_DELAY) {
                (bool after_, Round memory first) = _firstRoundAfter(u, e);
                if (!after_) continue;
                try registry.settleExpiryFallback(u, e, first.id) {
                    ++count["settleExpiryFallback"];
                } catch {
                    _flag("liveness", "settleExpiryFallback refused a stale pre-close print");
                }
            }
        }
    }

    function _settlePayersFirst(uint64 e, bool checkEquity) internal {
        uint256 n = _ids.length;
        int256[] memory nets = new int256[](n);
        bool[] memory holds = new bool[](n);
        for (uint256 i = 0; i < n; ++i) {
            (holds[i], nets[i]) = _netOn(_ids[i], e);
        }
        for (uint256 pass = 0; pass < 2; ++pass) {
            for (uint256 i = 0; i < n; ++i) {
                if (holds[i] && (pass == 0) == (nets[i] < 0)) _settleChecked(_ids[i], e, checkEquity);
            }
        }
    }

    /// @dev settleAccount must go through once the registry priced the expiry, and must not move
    /// the account's equity, except by less than one USDG unit when the InsuranceFund's bridge
    /// rounds a shortfall up to a whole unit.
    function _settleChecked(uint256 id, uint64 e, bool checkEquity) internal {
        (bool ok0, int256 eq0) = checkEquity ? _equity(id) : (false, int256(0));
        try ch.settleAccount(id, e) {}
        catch {
            _flag("liveness", "settleAccount reverted on a priced expiry");
            return;
        }
        if (!ok0) return;
        (bool ok1, int256 eq1) = _equity(id);
        if (ok1 && (eq1 > eq0 || eq1 + int256(UNIT) <= eq0)) _flag("liveness", "settleAccount moved equity");
    }

    function _claimAll(uint64 e) internal {
        (, uint256 pending, uint256 shortQty) = ch.pool(e);
        bool ready = shortQty == 0 && pending == 0;
        for (uint256 j = 0; j < _ids.length; ++j) {
            uint256 id = _ids[j];
            if (ch.claimable(id, e) == 0) continue;
            // claim emits nothing before its checks, so a refusal leaves no stray event behind
            try ch.claim(id, e) {}
            catch {
                if (ready) _flag("liveness", "claim refused on a complete pool");
            }
        }
    }

    /// @dev Whether `id` holds a position of `e`, and its net payoff at the registry's prices,
    /// rounded like Payoff (longs down, shorts up).
    function _netOn(uint256 id, uint64 e) internal view returns (bool holds, int256 net) {
        Position[] memory ps = ch.positionsOf(id);
        for (uint256 i = 0; i < ps.length; ++i) {
            if (expiryOf[ps[i].seriesId] != e) continue;
            holds = true;
            Series memory s = registry.series(ps[i].seriesId);
            (uint256 price,) = registry.settlementPriceOf(s.underlying, e);
            uint256 k = s.strike;
            uint256 payoff = s.isCall ? (price > k ? price - k : 0) : (k > price ? k - price : 0);
            int256 q = ps[i].qty;
            net += q > 0 ? int256(uint256(q) * payoff / WAD) : -int256(F.mulWadUp(uint256(-q), payoff));
        }
    }

    function _registrySettled(uint64 e) internal view returns (bool) {
        for (uint256 k = 0; k < 2; ++k) {
            if (!listedOn[_us[k]][e]) continue;
            (, bool done) = registry.settlementPriceOf(_us[k], e);
            if (!done) return false;
        }
        return true;
    }

    function _holdsExpiry(uint256 id, uint64 e) internal view returns (bool) {
        Position[] memory ps = ch.positionsOf(id);
        for (uint256 i = 0; i < ps.length; ++i) {
            if (expiryOf[ps[i].seriesId] == e) return true;
        }
        return false;
    }

    function _equity(uint256 id) internal view returns (bool ok, int256 eq) {
        try ch.accountState(id) returns (AccountState memory st) {
            return (true, st.equity);
        } catch {
            return (false, 0);
        }
    }

    // ================================================================ internal: picking

    function _pair(uint256 aSeed, uint256 bSeed) internal pure returns (uint256 a, uint256 b) {
        a = aSeed % N_ACTORS;
        b = bSeed % N_ACTORS;
        if (a == b) b = (b + 1) % N_ACTORS;
    }

    function _bidder(uint256 seed) internal view returns (address owner, uint256 id) {
        uint256 b = seed % (N_ACTORS + 1);
        return b == N_ACTORS ? (liquidator, liquidatorId) : (actors[b], actorIds[b]);
    }

    /// @dev Multiples of the minimum trade size, from one lot to `max`.
    function _qty(uint256 seed, uint256 max) internal pure returns (uint256) {
        return _bound(seed, 1, max / LOT) * LOT;
    }

    function _liveSeries(uint256 seed) internal view returns (bool, uint32) {
        uint256 n = _series.length;
        uint256 t = _now();
        for (uint256 j = 0; j < n; ++j) {
            uint32 sid = _series[(seed + j) % n];
            if (expiryOf[sid] > t) return (true, sid);
        }
        return (false, 0);
    }

    /// @dev A live series the vault sells right now (its option type, at least minOtm out of the
    /// money, |delta| at the mark vol inside its offer band). If none is listed, lists one about
    /// 8% out of the money on the first weekly expiry at least a day away.
    function _offered(bool calls, uint256 seed) internal returns (bool, uint32) {
        OptionVaultBase v = calls ? callVault : putVault;
        uint256 n = _series.length;
        uint256 t = _now();
        address u = v.underlying();
        (uint256 spot,,) = hub.spot(u);
        uint256 vol = hub.markVol(u);
        int256 rate = params.globals().rate;
        for (uint256 j = 0; j < n; ++j) {
            uint32 sid = _series[(seed + j) % n];
            if (expiryOf[sid] <= t) continue;
            Series memory s = registry.series(sid);
            if (s.underlying != u || s.isCall != calls) continue;
            if (calls ? s.strike < spot * 1.05e18 / WAD : s.strike > spot * 0.95e18 / WAD) continue;
            (int256 delta,,,) = BlackScholes.greeks(spot, s.strike, s.expiry - t, vol, rate, calls);
            uint256 d = _abs(delta);
            if (d >= 0.05e18 && d <= 0.5e18) return (true, sid);
        }
        if (n >= MAX_SERIES) return (false, 0);
        uint64 e = uint64(NyseCalendar.nextWeeklyExpiry(t + 1 days));
        uint256 step = params.underlying(u).strikeStep;
        uint256 strike = calls ? (spot * 1.08e18 / WAD + step - 1) / step * step : spot * 0.92e18 / WAD;
        _list(calls ? 0 : 1, e, strike, calls);
        if (_series.length == n) return (false, 0);
        return (true, _series[n]);
    }

    /// @dev A live series in which `id` is long and the vault short (what it can sell back).
    function _heldAgainst(OptionVaultBase v, bool calls, uint256 id, uint256 seed)
        internal
        view
        returns (bool, uint32)
    {
        uint256 n = _series.length;
        uint256 t = _now();
        address u = v.underlying();
        for (uint256 j = 0; j < n; ++j) {
            uint32 sid = _series[(seed + j) % n];
            if (expiryOf[sid] <= t) continue;
            Series memory s = registry.series(sid);
            if (s.underlying != u || s.isCall != calls) continue;
            if (_qtyOf(id, sid) > 0 && _qtyOf(v.vaultId(), sid) < 0) return (true, sid);
        }
        return (false, 0);
    }

    /// @dev The first actor from `seed` on that holds shares of `v` past its exit cooldown.
    function _shareholder(OptionVaultBase v, uint256 seed) internal view returns (bool, address) {
        uint256 cooldown = v.EXIT_COOLDOWN();
        for (uint256 j = 0; j < N_ACTORS; ++j) {
            address a = actors[(seed + j) % N_ACTORS];
            if (v.balanceOf(a) != 0 && v.lastReceive(a) + cooldown <= _now()) return (true, a);
        }
        return (false, address(0));
    }

    function _agentLive(uint256 a) internal view returns (bool) {
        return ch.agentPolicy(actorIds[a], agents[a]).expiresAt > _now();
    }

    /// @dev `qty` cut down (in whole lots) so its premium at `px` stays within half the payer's
    /// cash; 0 if not even one lot fits.
    function _affordable(uint256 qty, uint256 px, uint256 payerId) internal view returns (uint256) {
        if (px == 0) return qty;
        uint256 max = ch.cashOf(payerId) / 2 * WAD / px / LOT * LOT;
        return qty < max ? qty : max;
    }

    function _pastExpiry(uint256 seed) internal view returns (bool, uint64) {
        uint256 n = _expiries.length;
        uint256 t = _now();
        for (uint256 j = 0; j < n; ++j) {
            uint64 e = _expiries[(seed + j) % n];
            if (e < t) return (true, e);
        }
        return (false, 0);
    }

    /// @dev The first account from `seed` on with a position and below maintenance margin, among
    /// the next three that hold positions.
    function _liquidatable(uint256 seed) internal view returns (bool, uint256) {
        uint256 n = _ids.length;
        uint256 tried;
        for (uint256 j = 0; j < n && tried < 3; ++j) {
            uint256 id = _ids[(seed + j) % n];
            if (ch.positionsOf(id).length == 0) continue;
            ++tried; // each probe runs the kernel: look at three books at most
            (bool ok, bytes memory ret) = address(ch).staticcall(abi.encodeCall(ch.accountState, (id)));
            if (ok && abi.decode(ret, (AccountState)).liquidatable) return (true, id);
        }
        return (false, 0);
    }

    function _runningLiquidation(uint256 seed) internal view returns (bool, uint256) {
        uint256 n = _ids.length;
        for (uint256 j = 0; j < n; ++j) {
            uint256 id = _ids[(seed + j) % n];
            (, bool active) = ah.liquidationDiscount(id);
            if (active) return (true, id);
        }
        return (false, 0);
    }

    /// @dev An expiry with a running deficit sale on `id`.
    function _activeSale(uint256 id, uint256 seed) internal view returns (bool, uint64) {
        uint256 n = _expiries.length;
        for (uint256 j = 0; j < n; ++j) {
            uint64 e = _expiries[(seed + j) % n];
            if (ah.saleStartedAt(id, e) != 0) return (true, e);
        }
        return (false, 0);
    }

    function _liveCount() internal view returns (uint256 live) {
        uint256 t = _now();
        for (uint256 i = 0; i < _series.length; ++i) {
            if (expiryOf[_series[i]] > t) ++live;
        }
    }

    function _qtyOf(uint256 id, uint32 sid) internal view returns (int256) {
        Position[] memory ps = ch.positionsOf(id);
        for (uint256 i = 0; i < ps.length; ++i) {
            if (ps[i].seriesId == sid) return ps[i].qty;
        }
        return 0;
    }

    /// @dev BlackScholes at the hub's spot and mark vol: what the kernel marks the series at.
    function _mark(uint32 sid) internal view returns (uint256) {
        Series memory s = registry.series(sid);
        (uint256 spot,,) = hub.spot(s.underlying);
        return BlackScholes.price(
            spot, s.strike, s.expiry - _now(), hub.markVol(s.underlying), params.globals().rate, s.isCall
        );
    }

    // ================================================================ internal: series and rounds

    /// @dev The vault-friendly strikes (about 5.6% out of the money) plus the mirror-image option
    /// on each underlying.
    function _listAround(uint64 e) internal {
        _list(0, e, _price(0) * 1.056e18 / WAD, true);
        _list(0, e, _price(0) * 0.944e18 / WAD, false);
        _list(1, e, _price(1) * 1.058e18 / WAD, true);
        _list(1, e, _price(1) * 0.942e18 / WAD, false);
    }

    function _list(uint256 k, uint64 e, uint256 rawStrike, bool isCall) internal {
        address u = _us[k];
        uint256 step = params.underlying(u).strikeStep;
        uint256 strike = rawStrike / step * step;
        if (strike == 0) strike = step;
        // refused while the underlying is halted (e.g. a stale feed); SeriesListed is not tracked
        uint32 sid;
        try registry.listSeries(u, e, uint128(strike), isCall) returns (uint32 got) {
            sid = got;
        } catch {
            return;
        }
        if (expiryOf[sid] != 0) return;
        _series.push(sid);
        expiryOf[sid] = e;
        listedOn[u][e] = true;
        // keep the expiries ascending (warp prints the closes in order)
        uint256 n = _expiries.length;
        uint256 at = n;
        for (uint256 i = 0; i < n; ++i) {
            if (_expiries[i] == e) return;
            if (_expiries[i] > e) {
                at = i;
                break;
            }
        }
        _expiries.push(e);
        for (uint256 i = n; i > at; --i) {
            _expiries[i] = _expiries[i - 1];
        }
        _expiries[at] = e;
    }

    function _price(uint256 k) internal view returns (uint256) {
        (, int256 a,,,) = _feeds[k].latestRoundData();
        return uint256(a) * 1e10;
    }

    function _push(uint256 k, uint256 priceWad) internal {
        uint256 t = _now();
        uint80 rid = _feeds[k].pushRound(int256(priceWad / 1e10), t);
        _rounds[_us[k]].push(Round(rid, uint64(t)));
    }

    function _lastRoundAtOrBefore(address u, uint64 e) internal view returns (bool, Round memory) {
        Round[] storage rs = _rounds[u];
        for (uint256 i = rs.length; i > 0; --i) {
            if (rs[i - 1].at <= e) return (true, rs[i - 1]);
        }
        Round memory none;
        return (false, none);
    }

    function _firstRoundAfter(address u, uint64 e) internal view returns (bool, Round memory) {
        Round[] storage rs = _rounds[u];
        for (uint256 i = 0; i < rs.length; ++i) {
            if (rs[i].at > e) return (true, rs[i]);
        }
        Round memory none;
        return (false, none);
    }

    // ================================================================ internal: funds

    // Single-call pranks only: a call that reverts between startPrank and stopPrank would leave
    // the prank running into whatever comes next (the end-of-run `finish` included).

    function _mintDeposit(address from, uint256 id, address token, uint256 amount) internal {
        MockUSDG(token).mint(from, amount); // the mock stock token has the same mint(address,uint256)
        vm.prank(from);
        IERC20(token).approve(address(ch), amount);
        vm.prank(from);
        ch.deposit(id, token, amount);
    }

    function _vaultDeposit(address from, OptionVaultBase v, uint256 amount) internal {
        address token = v.asset();
        MockUSDG(token).mint(from, amount);
        vm.prank(from);
        IERC20(token).approve(address(v), amount);
        vm.prank(from);
        v.deposit(amount, from);
    }

    /// @dev Share price p = (assets + 1) / (supply + 1e6), the vaults' ERC-4626 conversion. An
    /// entry or exit may move it only by rounding: at most 4 asset units down (the account's
    /// equity converts into assets with floors) and at most one share plus 4 units, plus `kept`
    /// asset units an exit leaves behind for the holders who stay, up.
    function _checkSharePrice(OptionVaultBase v, uint256 a0, uint256 s0, uint256 kept, string memory what) internal {
        uint256 a1 = v.totalAssets();
        uint256 s1 = v.totalSupply();
        uint256 off = VIRTUAL_SHARES;
        if ((a1 + 1 + 4) * (s0 + off) < (a0 + 1) * (s1 + off)) {
            _flag("sharePrice", string.concat("share price fell on ", what));
        }
        if ((a1 + 1) * (s0 + off) > (a0 + 1) * (s1 + off + 1) + (4 + kept) * (s0 + off)) {
            _flag("sharePrice", string.concat("share price jumped on ", what));
        }
    }

    /// @dev An exit, both legs valued at spot in asset units: what the leaver got is at most the
    /// burned shares' value at the pre-exit NAV, and at most `kept` less, where `kept` is one USDG
    /// unit at spot (the cash leg is floored to whole units) plus 4 units of conversion rounding.
    /// That rest stays with the holders who stay, so the share price may rise by it, never fall.
    function _checkExit(OptionVaultBase v, Exit memory x, address owner, string memory what) internal {
        uint256 burned = x.shares0 - v.balanceOf(owner);
        uint256 value = burned * (x.a0 + 1) / (x.s0 + VIRTUAL_SHARES);
        uint256 got = x.asset.balanceOf(owner) - x.tokens0;
        uint256 kept = 4;
        if (x.inKind) {
            (uint256 spot,,) = hub.spot(v.underlying());
            uint256 cash = usdg.balanceOf(owner) - x.cash0;
            if (cash != 0) ++count["exitCashLeg"];
            got += cash * UNIT * WAD / spot;
            kept += (UNIT * WAD + spot - 1) / spot;
        }
        if (got > value) _flag("sharePrice", string.concat("exit paid more than the shares are worth on ", what));
        if (got + kept < value) _flag("sharePrice", string.concat("exit paid too little on ", what));
        _checkSharePrice(v, x.a0, x.s0, kept, what);
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _abs(int256 x) internal pure returns (uint256) {
        return x >= 0 ? uint256(x) : uint256(-x);
    }
}
