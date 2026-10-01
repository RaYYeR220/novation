// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Fixture} from "../utils/Fixture.sol";
import {CHErrors} from "../../src/core/ClearinghouseStorage.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {OptionVaultBase, VaultConfig} from "../../src/venues/OptionVaultBase.sol";
import {CoveredCallVault} from "../../src/venues/CoveredCallVault.sol";
import {PutWriteVault} from "../../src/venues/PutWriteVault.sol";
import {MockUSDG} from "../../src/mocks/MockUSDG.sol";
import {NyseCalendar} from "../../src/libraries/NyseCalendar.sol";
import {FixedPointMath as F} from "../../src/libraries/FixedPointMath.sol";
import {Position} from "../../src/types/Types.sol";

/// @notice Stands in for the auction house: records the deficit sales the clearinghouse starts.
contract DeficitSaleRecorder {
    uint256 public calls;
    uint256 public lastId;
    uint64 public lastExpiry;

    function startDeficitSale(uint256 id, uint64 expiry) external {
        ++calls;
        lastId = id;
        lastExpiry = expiry;
    }
}

/// @notice The core Fixture plus the vault helpers. Vaults are added as venues while the
/// clearinghouse setup phase is still open (the core Fixture never finalizes it).
///
/// Expiries at T0 (Wed 2026-09-23): e = Fri 09-25, e2 = Fri 10-02, eFar = Fri 10-30 (37 days out,
/// beyond the default 35-day tenor cap but within the registry's 6-week window).
abstract contract VaultFixture is Fixture {
    uint256 internal constant STALE = 93_600 + 1; // maxStaleRegular + 1
    uint256 internal constant SATURDAY = T0 + 3 days; // 2026-09-26 14:00 UTC, WEEKEND session
    uint64 internal constant WEEKEND_ADD = 0.1e18;

    address internal alice;
    address internal bob;
    address internal carol;
    address internal taker;
    uint256 internal takerId;

    uint64 internal e;
    uint64 internal e2;
    uint64 internal eFar;

    function setUp() public virtual override {
        super.setUp();
        alice = _user("alice");
        bob = _user("bob");
        carol = _user("carol");
        taker = _user("taker");
        takerId = _fund(taker, 1_000_000 * USDG, 0);

        e = _expiry();
        e2 = uint64(NyseCalendar.nextWeeklyExpiry(e));
        eFar = e2;
        for (uint256 i = 0; i < 4; ++i) {
            eFar = uint64(NyseCalendar.nextWeeklyExpiry(eFar));
        }
    }

    // ---------------------------------------------------------------- deployment

    function _config() internal pure returns (VaultConfig memory c) {
        c.minOtm = 0.05e18;
        c.maxTenorDays = 35;
        c.skewSlope = 0.5e18;
        c.utilSlope = 0.3e18;
        c.spread = 0.02e18;
        c.sessionVolAdd = [uint64(0), 0.05e18, WEEKEND_ADD, 0.1e18, 0];
        c.maxTradeQty = 100e18;
    }

    function _flatConfig() internal pure returns (VaultConfig memory c) {
        c = _config();
        c.sessionVolAdd = [uint64(0), 0, 0, 0, 0];
    }

    function _newCoveredCall(VaultConfig memory c) internal returns (CoveredCallVault v) {
        v = new CoveredCallVault(IERC20Metadata(address(nvda)), ch, registry, hub, params, c);
        ch.addVenue(address(v));
    }

    function _newPutWrite(VaultConfig memory c) internal returns (PutWriteVault v) {
        v = new PutWriteVault(IERC20Metadata(address(usdg)), address(nvda), ch, registry, hub, params, c);
        ch.addVenue(address(v));
    }

    // ---------------------------------------------------------------- actions

    /// @notice Mints `assets` of the vault's asset to `user` and deposits them for `user`.
    function _vaultDeposit(OptionVaultBase v, address user, uint256 assets) internal returns (uint256 shares) {
        address token = v.asset();
        MockUSDG(token).mint(user, assets); // MockUSDG and MockStockToken share mint(address,uint256)
        vm.startPrank(user);
        IERC20(token).approve(address(v), assets);
        shares = v.deposit(assets, user);
        vm.stopPrank();
    }

    function _buy(OptionVaultBase v, uint32 sid, uint256 qty) internal returns (uint256 premium) {
        vm.prank(taker);
        premium = v.buy(sid, qty, type(uint256).max, takerId);
    }

    /// @notice Taker fee: min(ceil(feeRate * qty * spot), ceil(feeCapOfPremium * premium)).
    function _takerFee(uint256 qty, uint256 spot, uint256 premium) internal pure returns (uint256) {
        uint256 byNotional = F.mulWadUp(0.0003e18, qty * spot / 1e18);
        uint256 byPremium = F.mulWadUp(0.125e18, premium);
        return byNotional < byPremium ? byNotional : byPremium;
    }

    function _one(uint64 x) internal pure returns (uint64[] memory es) {
        es = new uint64[](1);
        es[0] = x;
    }

    function _assertPos(uint256 id, uint32 sid, int256 qty) internal view {
        Position[] memory ps = ch.positionsOf(id);
        for (uint256 i = 0; i < ps.length; ++i) {
            if (ps[i].seriesId == sid) {
                assertEq(int256(ps[i].qty), qty, "position qty");
                return;
            }
        }
        assertEq(qty, 0, "position missing");
    }

    // ---------------------------------------------------------------- settlement availability

    /// @notice True once the clearinghouse implements settleAccount (probed with an id nobody
    /// owns: any revert other than NotImplemented means the entry point is live).
    function _settlementAvailable() internal returns (bool) {
        try ch.settleAccount(type(uint256).max, 0) {
            return true;
        } catch (bytes memory err) {
            return err.length < 4 || bytes4(err) != CHErrors.NotImplemented.selector;
        }
    }

    function _skipWithoutSettlement() internal {
        if (!_settlementAvailable()) {
            vm.skip(true, "clearinghouse settleAccount/claim not implemented yet; enabled with expiry settlement");
        }
    }
}
