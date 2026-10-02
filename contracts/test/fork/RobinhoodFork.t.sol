// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {KernelReference} from "../../src/kernel/KernelReference.sol";
import {RiskParams} from "../../src/core/RiskParams.sol";
import {MarketDataHub} from "../../src/core/MarketDataHub.sol";
import {SeriesRegistry} from "../../src/core/SeriesRegistry.sol";
import {InsuranceFund} from "../../src/core/InsuranceFund.sol";
import {Clearinghouse} from "../../src/core/Clearinghouse.sol";
import {AuctionHouse} from "../../src/core/AuctionHouse.sol";
import {CoveredCallVault} from "../../src/venues/CoveredCallVault.sol";
import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";
import {IScaledUiAmount} from "../../src/interfaces/IScaledUiAmount.sol";
import {UnderlyingParams} from "../../src/interfaces/IRiskParams.sol";
import {AccountState} from "../../src/interfaces/IClearinghouse.sol";
import {NyseCalendar} from "../../src/libraries/NyseCalendar.sol";
import {Position, Session} from "../../src/types/Types.sol";

/// @notice The core deployed on a fork of Robinhood Chain mainnet (chain 4663) against the real
/// USDG, NVDA, TSLA, SPY and AAPL tokens and the real Chainlink proxies, with the parameters of
/// script/Deploy.s.sol and KernelReference as the kernel. Balances come from `deal`.
///
/// Skipped unless RH_MAINNET_RPC is set. The public RPC keeps only a few thousand blocks of
/// state, so the fork is always taken at the latest block:
///   RH_MAINNET_RPC=https://rpc.mainnet.chain.robinhood.com forge test --match-path "test/fork/*" -vv
contract RobinhoodForkTest is Test, Deploy {
    uint256 internal constant RH_MAINNET = 4663;

    address internal constant USDG_TOKEN = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    // in the order of Deploy.syms: NVDA, TSLA, AAPL, SPY
    address[4] internal TOKENS = [
        0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC,
        0x322F0929c4625eD5bAd873c95208D54E1c003b2d,
        0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9,
        0x117cc2133c37B721F49dE2A7a74833232B3B4C0C
    ];
    address[4] internal FEEDS = [
        0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15,
        0x4A1166a659A55625345e9515b32adECea5547C38,
        0x6B22A786bAa607d76728168703a39Ea9C99f2cD0,
        0x319724394D3A0e3669269846abE664Cd621f9f6A
    ];

    address internal constant TIMELOCK = address(0x7100);
    address internal constant GUARDIAN = address(0x6600);
    address internal constant TREASURY = address(0x7E00);

    KernelReference internal kernel;
    RiskParams internal params;
    MarketDataHub internal hub;
    SeriesRegistry internal registry;
    InsuranceFund internal insurance;
    Clearinghouse internal ch;
    AuctionHouse internal ah;
    CoveredCallVault internal vault;

    function setUp() public {
        string memory rpc = vm.envOr("RH_MAINNET_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true, "set RH_MAINNET_RPC to run the Robinhood Chain mainnet fork tests");
            return;
        }
        if (block.chainid != RH_MAINNET) vm.createSelectFork(rpc); // latest block
        assertEq(block.chainid, RH_MAINNET, "not Robinhood Chain mainnet");

        kernel = new KernelReference();
        params = new RiskParams(USDG_TOKEN, TREASURY, address(0), TIMELOCK, GUARDIAN, address(this), _globals());
        for (uint256 i = 0; i < 4; ++i) {
            params.addUnderlying(TOKENS[i], _underlying(FEEDS[i], i));
        }
        hub = new MarketDataHub(params, kernel);
        for (uint256 i = 0; i < 4; ++i) {
            hub.initVol(TOKENS[i]);
        }
        registry = new SeriesRegistry(params, hub);
        insurance = new InsuranceFund(IERC20Metadata(USDG_TOKEN), address(this));
        ch = new Clearinghouse(params, hub, registry, kernel, insurance, address(this));
        ah = new AuctionHouse(ch, params, hub);
        vault = new CoveredCallVault(IERC20Metadata(TOKENS[0]), ch, registry, hub, params, _vaultConfig());
        insurance.bindClearinghouse(address(ch));
        ch.bindAuctionHouse(address(ah));
        ch.addVenue(address(vault));
        ch.finalizeSetup();
        params.finalizeSetup();

        console2.log("fork timestamp", block.timestamp);
    }

    // ================================================================ market data

    /// The hub reads every real feed: a positive 8-decimal answer, scaled to WAD, inside the
    /// plausibility band and in a sane range for the stock.
    function test_spotSanity() public view {
        uint256[4] memory lo = [uint256(50e18), 50e18, 50e18, 100e18];
        uint256[4] memory hi = [uint256(5000e18), 5000e18, 5000e18, 5000e18];
        for (uint256 i = 0; i < 4; ++i) {
            IAggregatorV3 feed = IAggregatorV3(FEEDS[i]);
            assertEq(feed.decimals(), 8, "feed decimals");
            (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
            (uint256 price, Session s, bool ok) = hub.spot(TOKENS[i]);
            assertEq(price, uint256(answer) * 1e10, "spot is the feed answer in WAD");
            assertGe(price, lo[i], "spot below sane range");
            assertLe(price, hi[i], "spot above sane range");
            assertLe(updatedAt, block.timestamp, "round from the future");
            assertEq(ok, s != Session.HALTED);
            console2.log(syms[i], price / 1e16, "cents; last round age (s)", block.timestamp - updatedAt);
        }
        assertEq(IERC20Metadata(USDG_TOKEN).decimals(), 6, "USDG decimals");
    }

    /// The hub's session is the NYSE calendar's session at the fork block's timestamp, unless a
    /// halt condition holds for that token (stale feed, issuer pause, oracle freeze, multiplier
    /// window), in which case it must read HALTED.
    function test_sessionMatchesForkTimestamp() public view {
        Session base = NyseCalendar.baseSession(block.timestamp);
        console2.log("NyseCalendar session at the fork timestamp", uint256(base));
        for (uint256 i = 0; i < 4; ++i) {
            Session s = hub.session(TOKENS[i]);
            bool halt = _haltReason(i);
            if (halt) assertEq(uint256(s), uint256(Session.HALTED), "halt condition not reflected");
            else assertEq(uint256(s), uint256(base), "session != NyseCalendar session");
        }
    }

    /// The ERC-8056 surface the hub depends on is readable on every real stock token: the
    /// multiplier (dividends reinvested, so at least 1.0), the pending multiplier and its
    /// effective time, and the issuer's pause and oracle-freeze flags.
    function test_erc8056Getters() public view {
        for (uint256 i = 0; i < 4; ++i) {
            IScaledUiAmount t = IScaledUiAmount(TOKENS[i]);
            uint256 m = t.uiMultiplier();
            uint256 next = t.newUIMultiplier();
            uint256 at = t.effectiveAt();
            assertGe(m, 1e18, "uiMultiplier below 1");
            assertLt(m, 1.2e18, "uiMultiplier implausible");
            assertGe(next, 1e18, "newUIMultiplier below 1");
            if (at <= block.timestamp) assertEq(next, m, "a past multiplier change not applied");
            assertEq(IERC20Metadata(TOKENS[i]).decimals(), 18, "stock token decimals");
            bool paused = t.paused();
            bool oraclePaused = t.oraclePaused();
            if (paused || oraclePaused) assertEq(uint256(hub.session(TOKENS[i])), uint256(Session.HALTED));
            console2.log(syms[i], "uiMultiplier", m);
            console2.log("  effectiveAt", at, paused ? "paused" : "not paused", oraclePaused ? "oracle paused" : "");
        }
    }

    /// The real proxies' zero-round behaviour, which settlement and the vol estimator rely on: the
    /// round after the latest and round 0 of the phase read back as zeros (no revert); a round in a
    /// phase that doesn't exist reverts, which the hub maps to "missing". The first rounds of each
    /// feed are the launch prints that came out 1e10 too high: outside every plausibility band.
    function test_zeroRoundSemantics() public view {
        for (uint256 i = 0; i < 4; ++i) {
            IAggregatorV3 feed = IAggregatorV3(FEEDS[i]);
            (uint80 latest,,,,) = feed.latestRoundData();
            uint80 phase = latest >> 64;
            (, int256 a, uint256 st, uint256 up,) = feed.getRoundData(latest + 1);
            assertEq(a, 0, "next round answer");
            assertEq(up, 0, "next round updatedAt");
            assertEq(st, 0, "next round startedAt");
            (, a,, up,) = feed.getRoundData(phase << 64);
            assertEq(a, 0, "round 0 answer");
            assertEq(up, 0, "round 0 updatedAt");
            try feed.getRoundData(((phase + 1) << 64) | 1) returns (uint80, int256 a2, uint256, uint256 up2, uint80) {
                assertEq(a2, 0, "next phase answer");
                assertEq(up2, 0, "next phase updatedAt");
            } catch {}
            // the launch print
            (, a,, up,) = feed.getRoundData((uint80(1) << 64) | 1);
            assertGt(up, 0, "first round missing");
            UnderlyingParams memory p = params.underlying(TOKENS[i]);
            assertGt(uint256(a) * 1e10, p.maxPrice, "launch print inside the band");
        }
    }

    // ================================================================ covered-call cycle

    /// Deposit real NVDA into the covered-call vault, sell calls to a taker paying in real USDG,
    /// cross the weekly close with a mocked pre-close print and a mocked first post-close print,
    /// settle the expiry in the registry, settle both accounts through the pool, claim, and pay a
    /// queued redemption out in kind: NVDA plus the USDG leg (the vault's premium cash).
    function test_coveredCallVaultCycle() public {
        address nvda = TOKENS[0];
        IAggregatorV3 feed = IAggregatorV3(FEEDS[0]);
        if (hub.session(nvda) == Session.HALTED) {
            vm.skip(true, "NVDA reads HALTED at the fork block");
            return;
        }
        address alice = makeAddr("alice");
        address taker = makeAddr("taker");
        uint256 vid = vault.vaultId();
        // the smallest sale that opens a series in the vault (10 contracts with the mainnet config)
        uint256 qty = vault.config().minNewSeriesQty;

        // alice deposits twice that in NVDA
        deal(nvda, alice, 2 * qty);
        vm.startPrank(alice);
        IERC20(nvda).approve(address(vault), 2 * qty);
        uint256 shares = vault.deposit(2 * qty, alice);
        vm.stopPrank();
        assertEq(ch.collateralOf(vid, nvda), 2 * qty, "vault collateral");
        assertEq(IERC20(nvda).balanceOf(address(ch)), 2 * qty, "NVDA held by the clearinghouse");

        // the taker funds an account with 5,000 USDG
        deal(USDG_TOKEN, taker, 5_000e6);
        vm.startPrank(taker);
        uint256 takerId = ch.createSubaccount();
        IERC20(USDG_TOKEN).approve(address(ch), 5_000e6);
        ch.deposit(takerId, USDG_TOKEN, 5_000e6);
        vm.stopPrank();
        assertEq(ch.cashOf(takerId), 5_000e18, "taker cash");

        // a call about 8% out of the money, on the first weekly expiry at least two days away
        (uint256 spot,,) = hub.spot(nvda);
        uint64 expiry = uint64(NyseCalendar.nextWeeklyExpiry(block.timestamp + 2 days));
        uint128 strike = uint128((spot * 108 / 100 + 5e18 - 1) / 5e18 * 5e18);
        uint32 sid = registry.listSeries(nvda, expiry, strike, true);

        vm.prank(taker);
        uint256 premium = vault.buy(sid, qty, type(uint256).max, takerId);
        assertGt(premium, 0, "premium");
        _assertPos(takerId, sid, int256(qty));
        _assertPos(vid, sid, -int256(qty));
        assertEq(ch.cashOf(vid), premium, "vault earned the premium");
        assertGe(vault.totalAssets(), 2 * qty, "NAV includes the premium");

        // alice queues half her shares once her exit cooldown has passed
        vm.warp(block.timestamp + vault.EXIT_COOLDOWN());
        vm.prank(alice);
        vault.requestRedeem(shares / 2, alice);

        // the close: a pre-close print 2 USD above the strike, then the first post-close print
        (uint80 last,,,,) = feed.latestRoundData();
        uint256 closePrice = uint256(strike) + 2e18;
        _mockRound(feed, last + 1, closePrice, expiry - 1 hours);
        _mockRound(feed, last + 2, closePrice, expiry + 30 minutes);
        _mockLatest(feed, last + 2, closePrice, expiry + 30 minutes);
        vm.warp(expiry + 1 hours);

        assertEq(registry.settleExpiry(nvda, expiry, last + 1), closePrice, "settlement price");

        // the vault's roll settles its short (it pays qty x 2 USDG into the pool from its premium
        // cash) and pays the queued redemption; the taker settles and claims
        uint256 payoff = 2 * qty;
        vault.roll(_one(expiry));
        (uint256 poolWad,, uint256 shortQty) = ch.pool(expiry);
        assertEq(shortQty, 0, "short left");
        assertEq(poolWad, payoff, "pool holds the payoff");
        assertEq(ch.positionsOf(vid).length, 0, "vault position left");
        assertEq(vault.epoch(), 1, "epoch not rolled");

        ch.settleAccount(takerId, expiry);
        ch.claim(takerId, expiry);
        assertEq(ch.cashOf(takerId), 5_000e18 - premium - _fee(premium, spot, qty) + payoff, "taker cash after claim");
        (poolWad,,) = ch.pool(expiry);
        assertEq(poolWad, 0, "pool not emptied");

        uint256 owed = vault.redeemable(alice);
        uint256 owedCash = vault.redeemableCash(alice);
        console2.log("strike", strike / 1e18, "expiry", expiry);
        console2.log("calls sold", qty / 1e18, "premium (USDG wei)", premium);
        console2.log("NVDA redeemed for half the shares (wei)", owed);
        console2.log("USDG leg (raw units)", owedCash);
        assertGt(owed, qty * 98 / 100, "redemption");
        // half the shares take half the vault's cash (the premium less the payoff) in USDG
        assertApproxEqAbs(owedCash * 1e12, (premium - payoff) / 2, 1e12, "cash leg");
        // and both legs together are worth more than the NVDA alice put in for them
        assertGt(owed + owedCash * 1e12 * 1e18 / closePrice, qty, "in-kind value");
        vault.claimRedeemed(alice);
        vault.claimRedeemedCash(alice);
        assertEq(IERC20(nvda).balanceOf(alice), owed, "alice got NVDA back");
        assertEq(IERC20(USDG_TOKEN).balanceOf(alice), owedCash, "alice got the USDG leg");

        // what the clearinghouse holds still covers every account
        assertGe(IERC20(USDG_TOKEN).balanceOf(address(ch)) * 1e12, ch.cashOf(takerId) + ch.cashOf(vid));
        assertEq(IERC20(nvda).balanceOf(address(ch)), ch.collateralOf(vid, nvda));
        AccountState memory st = ch.accountState(vid);
        assertGt(st.equity, 0);
    }

    // ================================================================ helpers

    /// @dev Whether a halt condition holds for token i at the fork block (see MarketDataHub).
    function _haltReason(uint256 i) internal view returns (bool) {
        IScaledUiAmount t = IScaledUiAmount(TOKENS[i]);
        if (t.paused() || t.oraclePaused()) return true;
        uint256 ea = t.effectiveAt();
        if (ea != 0 && block.timestamp + 86400 >= ea && (ea >= block.timestamp || block.timestamp - ea <= 3600)) {
            return true;
        }
        (, int256 answer,, uint256 updatedAt,) = IAggregatorV3(FEEDS[i]).latestRoundData();
        UnderlyingParams memory p = params.underlying(TOKENS[i]);
        uint256 wad = uint256(answer) * 1e10;
        if (answer <= 0 || wad < p.minPrice || wad > p.maxPrice || updatedAt > block.timestamp) return true;
        Session base = NyseCalendar.baseSession(block.timestamp);
        uint256 limit = base == Session.REGULAR
            ? p.maxStaleRegular
            : base == Session.EXTENDED ? p.maxStaleExtended : p.maxStaleClosed;
        return block.timestamp - updatedAt > limit;
    }

    function _mockRound(IAggregatorV3 feed, uint80 id, uint256 priceWad, uint256 at) internal {
        vm.mockCall(
            address(feed),
            abi.encodeCall(IAggregatorV3.getRoundData, (id)),
            abi.encode(id, int256(priceWad / 1e10), at, at, id)
        );
    }

    function _mockLatest(IAggregatorV3 feed, uint80 id, uint256 priceWad, uint256 at) internal {
        vm.mockCall(
            address(feed),
            abi.encodeCall(IAggregatorV3.latestRoundData, ()),
            abi.encode(id, int256(priceWad / 1e10), at, at, id)
        );
    }

    /// @dev The taker's fee: min(ceil(feeRate * qty * spot), ceil(feeCapOfPremium * premium)).
    function _fee(uint256 premium, uint256 spot, uint256 qty) internal pure returns (uint256) {
        uint256 byNotional = _mulWadUp(0.0003e18, qty * spot / 1e18);
        uint256 byPremium = _mulWadUp(0.125e18, premium);
        return byNotional < byPremium ? byNotional : byPremium;
    }

    function _mulWadUp(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a * b + 1e18 - 1) / 1e18;
    }

    function _assertPos(uint256 id, uint32 sid, int256 qty) internal view {
        Position[] memory ps = ch.positionsOf(id);
        for (uint256 i = 0; i < ps.length; ++i) {
            if (ps[i].seriesId == sid) {
                assertEq(int256(ps[i].qty), qty, "position");
                return;
            }
        }
        assertEq(qty, 0, "position missing");
    }

    function _one(uint64 e) internal pure returns (uint64[] memory xs) {
        xs = new uint64[](1);
        xs[0] = e;
    }
}
