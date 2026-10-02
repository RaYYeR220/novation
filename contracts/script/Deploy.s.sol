// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {RiskParams} from "../src/core/RiskParams.sol";
import {MarketDataHub} from "../src/core/MarketDataHub.sol";
import {SeriesRegistry} from "../src/core/SeriesRegistry.sol";
import {InsuranceFund} from "../src/core/InsuranceFund.sol";
import {Clearinghouse} from "../src/core/Clearinghouse.sol";
import {AuctionHouse} from "../src/core/AuctionHouse.sol";
import {RfqVenue} from "../src/venues/RfqVenue.sol";
import {CoveredCallVault} from "../src/venues/CoveredCallVault.sol";
import {PutWriteVault} from "../src/venues/PutWriteVault.sol";
import {VaultConfig} from "../src/venues/OptionVaultBase.sol";
import {UnderlyingParams, GlobalParams} from "../src/interfaces/IRiskParams.sol";
import {IRiskKernel} from "../src/interfaces/IRiskKernel.sol";

/// @notice Deploys the core stack on top of the kernel, tokens and feeds already recorded in
/// deployments/<chainId>.json (deploy.py, plus DeployMocks.s.sol on testnet; the mainnet json
/// lists the real tokens and Chainlink proxies): timelock, RiskParams with the Task 7 defaults for
/// NVDA/TSLA/AAPL/SPY, hub, registry, InsuranceFund, Clearinghouse (logic libraries linked by
/// forge), AuctionHouse, RfqVenue and the vaults. Binds everything, adds the venues, closes the
/// setup phase and merges the addresses back into the json (then run
/// tools/deploy/record_libraries.py for the library addresses and the deploy block).
///
/// What differs between chains is in _chainConfig(): the timelock delay, the vault sizes and
/// whether the TSLA covered-call and NVDA put-write vaults are deployed next to the NVDA
/// covered-call vault. Each can be overridden from the env.
///
/// Env: DEPLOYER_PRIVATE_KEY; optional GUARDIAN, TREASURY (default: the deployer),
/// TIMELOCK_MIN_DELAY (seconds), VAULT_MIN_NEW_SERIES_QTY and VAULT_MAX_TRADE_QTY (WAD contracts)
/// and DEPLOY_ALL_VAULTS (bool).
/// Run: forge script script/Deploy.s.sol --rpc-url $RH_TESTNET_RPC --broadcast --slow
contract Deploy is Script {
    uint256 internal constant RH_TESTNET = 46630;

    /// @dev What differs between chains. minNewSeriesQty is the smallest sale that opens a series
    /// slot in a vault: at 10 contracts, filling all 24 of a vault's slots takes 240 in-band
    /// contracts.
    struct ChainConfig {
        uint256 timelockDelay; // seconds
        uint256 minNewSeriesQty; // WAD contracts
        uint256 maxTradeQty; // WAD contracts per vault sale
        bool allVaults; // TSLA covered call and NVDA put-write next to the NVDA covered call
    }

    struct Stack {
        TimelockController timelock;
        RiskParams params;
        MarketDataHub hub;
        SeriesRegistry registry;
        InsuranceFund insurance;
        Clearinghouse ch;
        AuctionHouse ah;
        RfqVenue rfq;
        CoveredCallVault ccNvda;
        CoveredCallVault ccTsla;
        PutWriteVault pwNvda;
    }

    string[4] internal syms = ["NVDA", "TSLA", "AAPL", "SPY"];
    uint64[4] internal volFloors = [0.35e18, 0.45e18, 0.2e18, 0.12e18];
    uint64[4] internal volCaps = [1.5e18, 2e18, 1e18, 0.8e18];
    uint128[4] internal minPrices = [20e18, 30e18, 25e18, 60e18];
    uint128[4] internal maxPrices = [2000e18, 4000e18, 2500e18, 6000e18];

    function run() external {
        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        string memory dep = vm.readFile(path);
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address guardian = vm.envOr("GUARDIAN", deployer);
        address treasury = vm.envOr("TREASURY", deployer);
        ChainConfig memory cc = _chainConfig();
        address usdg = vm.parseJsonAddress(dep, ".tokens.USDG");
        IRiskKernel kernel = IRiskKernel(vm.parseJsonAddress(dep, ".kernel.address"));

        vm.startBroadcast(pk);
        Stack memory s;

        address[] memory roles = new address[](1);
        roles[0] = guardian;
        s.timelock = new TimelockController(cc.timelockDelay, roles, roles, address(0));

        s.params = new RiskParams(usdg, treasury, address(0), address(s.timelock), guardian, deployer, _globals());
        for (uint256 i = 0; i < 4; ++i) {
            address token = vm.parseJsonAddress(dep, string.concat(".tokens.", syms[i]));
            address feed = vm.parseJsonAddress(dep, string.concat(".feeds.", syms[i]));
            s.params.addUnderlying(token, _underlying(feed, i));
        }

        s.hub = new MarketDataHub(s.params, kernel);
        s.registry = new SeriesRegistry(s.params, s.hub);
        s.insurance = new InsuranceFund(IERC20Metadata(usdg), deployer);
        s.ch = new Clearinghouse(s.params, s.hub, s.registry, kernel, s.insurance, deployer);
        s.ah = new AuctionHouse(s.ch, s.params, s.hub);
        s.rfq = new RfqVenue(s.ch);

        address nvda = vm.parseJsonAddress(dep, ".tokens.NVDA");
        VaultConfig memory cfg = _vaultConfig();
        s.ccNvda = new CoveredCallVault(IERC20Metadata(nvda), s.ch, s.registry, s.hub, s.params, cfg);
        if (cc.allVaults) {
            address tsla = vm.parseJsonAddress(dep, ".tokens.TSLA");
            s.ccTsla = new CoveredCallVault(IERC20Metadata(tsla), s.ch, s.registry, s.hub, s.params, cfg);
            s.pwNvda = new PutWriteVault(IERC20Metadata(usdg), nvda, s.ch, s.registry, s.hub, s.params, cfg);
        }

        s.insurance.bindClearinghouse(address(s.ch));
        s.ch.bindAuctionHouse(address(s.ah));
        s.ch.addVenue(address(s.rfq));
        s.ch.addVenue(address(s.ccNvda));
        if (cc.allVaults) {
            s.ch.addVenue(address(s.ccTsla));
            s.ch.addVenue(address(s.pwNvda));
        }
        s.ch.finalizeSetup();
        s.params.finalizeSetup();
        vm.stopBroadcast();

        _record(path, s, guardian);
    }

    // ---------------------------------------------------------------- per-chain settings

    /// @dev RH testnet: a 60 s timelock, 1-contract series slots and all three vaults, so the demo
    /// can move fast. RH mainnet and any other chain (forks, local nodes): a 24 h timelock,
    /// 10-contract series slots and only the NVDA covered-call vault. The risk parameters below
    /// are the same on every chain.
    function _chainConfig() internal view returns (ChainConfig memory c) {
        if (block.chainid == RH_TESTNET) {
            c = ChainConfig({timelockDelay: 60, minNewSeriesQty: 1e18, maxTradeQty: 1000e18, allVaults: true});
        } else {
            c = ChainConfig({timelockDelay: 1 days, minNewSeriesQty: 10e18, maxTradeQty: 1000e18, allVaults: false});
        }
        c.timelockDelay = vm.envOr("TIMELOCK_MIN_DELAY", c.timelockDelay);
        c.minNewSeriesQty = vm.envOr("VAULT_MIN_NEW_SERIES_QTY", c.minNewSeriesQty);
        c.maxTradeQty = vm.envOr("VAULT_MAX_TRADE_QTY", c.maxTradeQty);
        c.allVaults = vm.envOr("DEPLOY_ALL_VAULTS", c.allVaults);
    }

    // ---------------------------------------------------------------- parameters (Task 7 defaults)

    function _globals() internal pure returns (GlobalParams memory) {
        return GlobalParams({
            mmRatio: 0.75e18,
            diversificationCredit: 0.3e18,
            shortOptionMinPct: 0.01e18,
            feeRate: 0.0003e18,
            feeCapOfPremium: 0.125e18,
            insuranceShare: 0.5e18,
            startDiscount: 0.02e18,
            maxDiscount: 0.12e18,
            maxFractionPerBid: 0.5e18,
            liquidationPenalty: 0.01e18,
            auctionDuration: 1800,
            maxSettlementLag: 87300,
            haltWindow: 86400,
            maxWeeksOut: 6,
            maxStrikeDeviation: 0.5e18,
            rate: 0,
            minTradeQty: 0.01e18,
            dustEquity: 5e18
        });
    }

    function _underlying(address feed, uint256 i) internal view returns (UnderlyingParams memory) {
        return UnderlyingParams({
            enabled: true,
            index: 0,
            feed: feed,
            strikeStep: 5e18,
            volFloor: volFloors[i],
            volCap: volCaps[i],
            lambda: 0.97e18,
            shockK: 3e18,
            minShock: 0.1e18,
            horizonDays: 2,
            volUp: 0.4e18,
            volDown: 0.3e18,
            multExtended: 1.2e18,
            multWeekend: 1.75e18,
            multHoliday: 1.75e18,
            multHalted: 2.5e18,
            maxOpenInterest: 1_000_000e18,
            maxStaleRegular: 93600,
            maxStaleExtended: 93600,
            maxStaleClosed: 345600,
            volStaleness: 172800,
            minPrice: minPrices[i],
            maxPrice: maxPrices[i]
        });
    }

    function _vaultConfig() internal view returns (VaultConfig memory) {
        ChainConfig memory cc = _chainConfig();
        return VaultConfig({
            minOtm: 0.05e18,
            maxTenorDays: 35,
            skewSlope: 0.5e18,
            utilSlope: 0.3e18,
            spread: 0.02e18,
            sessionVolAdd: [uint64(0), 0.05e18, 0.15e18, 0.15e18, 0],
            maxTradeQty: SafeCast.toUint128(cc.maxTradeQty),
            maxOpenSeries: 24,
            minDelta: 0.05e18,
            maxDelta: 0.5e18,
            minNewSeriesQty: SafeCast.toUint128(cc.minNewSeriesQty)
        });
    }

    // ---------------------------------------------------------------- deployments json

    /// @dev The linked libraries and the deploy block (block.number is the L1 block on Arbitrum)
    /// are added from the broadcast by tools/deploy/record_libraries.py.
    function _record(string memory path, Stack memory s, address guardian) internal {
        _set(path, "timelock", address(s.timelock));
        _set(path, "guardian", guardian);
        _set(path, "riskParams", address(s.params));
        _set(path, "hub", address(s.hub));
        _set(path, "registry", address(s.registry));
        _set(path, "insurance", address(s.insurance));
        _set(path, "clearinghouse", address(s.ch));
        _set(path, "auctionHouse", address(s.ah));
        _set(path, "rfq", address(s.rfq));
        string memory vaults = _vault(address(s.ccNvda), "coveredCall", "NVDA");
        if (address(s.ccTsla) != address(0)) {
            vaults = string.concat(
                vaults,
                ",",
                _vault(address(s.ccTsla), "coveredCall", "TSLA"),
                ",",
                _vault(address(s.pwNvda), "putWrite", "NVDA")
            );
        }
        vm.writeJson(string.concat("[", vaults, "]"), path, ".vaults");
    }

    function _set(string memory path, string memory key, address a) internal {
        vm.writeJson(string.concat("\"", vm.toString(a), "\""), path, string.concat(".", key));
    }

    function _vault(address a, string memory kind, string memory u) internal pure returns (string memory) {
        return
            string.concat("{\"address\":\"", vm.toString(a), "\",\"type\":\"", kind, "\",\"underlying\":\"", u, "\"}");
    }
}
