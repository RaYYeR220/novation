// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {AgentPolicy} from "../interfaces/IClearinghouse.sol";
import {IRiskParams} from "../interfaces/IRiskParams.sol";
import {IMarketDataHub} from "../interfaces/IMarketDataHub.sol";
import {ISeriesRegistry} from "../interfaces/ISeriesRegistry.sol";
import {IRiskKernel} from "../interfaces/IRiskKernel.sol";
import {IInsuranceFund} from "../interfaces/IInsuranceFund.sol";
import {FixedPointMath as F} from "../libraries/FixedPointMath.sol";
import {Position, Series, WAD, MAX_POSITIONS, MAX_UNDERLYINGS} from "../types/Types.sol";

struct Account {
    address owner;
    uint256 cashNorm; // cash = cashNorm * cashIndex / 1e18 (floor)
    uint256 deficitTotal; // sum over expiries of (defPending + defBridged)
}

/// @custom:storage-location erc7201:novation.storage.Clearinghouse
struct CHStorage {
    uint256 nextId; // next subaccount id; the first one is 1
    uint256 cashIndex; // WAD, starts at 1e18, only decreases
    uint256 totalCashNorm;
    mapping(uint256 => Account) accounts;
    mapping(address => uint256[]) owned;
    mapping(uint256 => mapping(address => uint256)) collateral; // WAD raw tokens
    mapping(uint256 => address[]) collateralTokens; // tokens with collateral > 0
    mapping(uint256 => Position[]) positions;
    mapping(uint256 => mapping(uint32 => uint256)) posIndex; // index + 1
    mapping(uint256 => mapping(address => AgentPolicy)) agents;
    mapping(address => bool) venues;
    address auctionHouse;
    bool setupFinalized;
    mapping(uint32 => uint256) longOI; // sum of positive qty per series
    mapping(uint64 => uint256) pool;
    mapping(uint64 => uint256) pending;
    mapping(uint64 => uint256) unsettledShortQty; // sum of open short qty over the series of the expiry
    mapping(uint64 => uint256) totalClaimable;
    mapping(uint64 => bool) impaired; // only after an unfundable socialization
    mapping(uint256 => mapping(uint64 => uint256)) claimable;
    mapping(uint256 => mapping(uint64 => uint256)) defPending; // owed to pool[E]
    mapping(uint256 => mapping(uint64 => uint256)) defBridged; // owed to the InsuranceFund
    // Union-of-underlyings bookkeeping for the MAX_UNDERLYINGS cap: an underlying is in an
    // account's union while it has collateral > 0 or at least one open position on it.
    mapping(uint256 => mapping(address => uint256)) positionsOn; // open positions per underlying
    mapping(uint256 => uint256) underlyingCount; // size of the union
}

/// @notice Dependencies handed to the logic libraries, built by the Clearinghouse from its
/// immutables and storage.
struct Deps {
    IRiskParams params;
    IMarketDataHub hub;
    ISeriesRegistry registry;
    IRiskKernel kernel;
    IInsuranceFund insurance;
    address auctionHouse;
    address usdg;
    uint256 usdgScale; // 10 ** (18 - usdg decimals)
}

/// @notice Errors of the clearinghouse and its logic libraries.
library CHErrors {
    // ledger
    error InsufficientCash(uint256 id, uint256 cash, uint256 wad);
    error InsufficientCollateral(uint256 id, address token, uint256 collateral, uint256 wad);
    error TooManyPositions();
    error TooManyUnderlyings();
    // accounts and funds
    error UnknownAccount(uint256 id);
    error NotOwner(uint256 id, address caller);
    error InDeficit();
    error InsufficientMargin(uint256 id, int256 equity, uint256 im);
    error TokenNotAllowed(address token);
    error ZeroAmount();
    error ZeroAddress();
    error InvalidRecipient();
    error BadDecimals();
    // agents
    error InvalidAgent();
    error InvalidExpiry();
    // trading
    error NotVenue(address caller);
    error UnknownSeries();
    error SeriesExpired();
    error SelfTrade();
    error QtyTooSmall();
    error NotAuthorized(uint256 id, address actor);
    error AgentUnderlyingNotAllowed();
    error OpeningNotAllowed(uint256 id);
    error OpenInterestCap();
    error AgentRiskBudgetExceeded(uint256 id, uint256 worstLoss, uint256 budget);
    error AgentPremiumExceeded();
    // setup
    error NotSetupAdmin();
    error SetupAlreadyFinalized();
    error AlreadyBound();
    error AuctionHouseNotBound();
    error NotImplemented();
}

/// @notice ERC-7201 storage accessor plus the ledger primitives every logic library goes through.
/// Cash is index-scaled: an account holds cashNorm, worth cashNorm * cashIndex / 1e18. Credits
/// round the account's share down and debits round it up, so rounding never favours the account.
library CHS {
    /// keccak256(abi.encode(uint256(keccak256("novation.storage.Clearinghouse")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant SLOT = 0xdb4f0b7186370eee7ccd7c24237257b9ec2a4e76df5b9d3882697c1f0a732400;

    function s() internal pure returns (CHStorage storage $) {
        assembly ("memory-safe") {
            $.slot := SLOT
        }
    }

    // ---------------------------------------------------------------- cash

    function cashOf(uint256 id) internal view returns (uint256) {
        CHStorage storage $ = s();
        return $.accounts[id].cashNorm * $.cashIndex / WAD;
    }

    function credit(uint256 id, uint256 wad) internal {
        CHStorage storage $ = s();
        uint256 n = wad * WAD / $.cashIndex; // floor
        $.accounts[id].cashNorm += n;
        $.totalCashNorm += n;
    }

    function debit(uint256 id, uint256 wad) internal {
        CHStorage storage $ = s();
        uint256 n = F.divWadUp(wad, $.cashIndex); // ceil(wad * 1e18 / cashIndex)
        Account storage a = $.accounts[id];
        if (n > a.cashNorm) revert CHErrors.InsufficientCash(id, cashOf(id), wad);
        a.cashNorm -= n;
        $.totalCashNorm -= n;
    }

    // ---------------------------------------------------------------- collateral

    function addCollateral(uint256 id, address token, uint256 wad) internal {
        if (wad == 0) return;
        CHStorage storage $ = s();
        uint256 prev = $.collateral[id][token];
        if (prev == 0) {
            if ($.positionsOn[id][token] == 0) _enterUnion(id);
            $.collateralTokens[id].push(token);
        }
        $.collateral[id][token] = prev + wad;
    }

    function removeCollateral(uint256 id, address token, uint256 wad) internal {
        if (wad == 0) return;
        CHStorage storage $ = s();
        uint256 prev = $.collateral[id][token];
        if (prev < wad) revert CHErrors.InsufficientCollateral(id, token, prev, wad);
        uint256 next = prev - wad;
        $.collateral[id][token] = next;
        if (next != 0) return;
        address[] storage toks = $.collateralTokens[id];
        uint256 n = toks.length; // <= MAX_UNDERLYINGS
        for (uint256 i = 0; i < n; ++i) {
            if (toks[i] == token) {
                toks[i] = toks[n - 1];
                toks.pop();
                break;
            }
        }
        if ($.positionsOn[id][token] == 0) --$.underlyingCount[id];
    }

    // ---------------------------------------------------------------- positions

    /// @notice The only way to change a position. `series` must be registry.series(seriesId).
    /// Creates, resizes or deletes (at zero) the entry; keeps the position-count and underlying
    /// caps, the per-series long open interest and the per-expiry open short quantity in sync.
    function movePosition(uint256 id, uint32 seriesId, int256 delta, Series memory series)
        internal
        returns (int256 oldQty, int256 newQty)
    {
        CHStorage storage $ = s();
        Position[] storage ps = $.positions[id];
        uint256 slot1 = $.posIndex[id][seriesId];
        if (slot1 != 0) oldQty = ps[slot1 - 1].qty;
        newQty = oldQty + delta;
        int128 q = SafeCast.toInt128(newQty);

        if (slot1 == 0) {
            if (newQty != 0) {
                if (ps.length >= MAX_POSITIONS) revert CHErrors.TooManyPositions();
                uint256 refs = $.positionsOn[id][series.underlying];
                if (refs == 0 && $.collateral[id][series.underlying] == 0) _enterUnion(id);
                $.positionsOn[id][series.underlying] = refs + 1;
                ps.push(Position({seriesId: seriesId, qty: q}));
                $.posIndex[id][seriesId] = ps.length;
            }
        } else if (newQty == 0) {
            uint256 last = ps.length - 1;
            if (slot1 - 1 != last) {
                Position memory moved = ps[last];
                ps[slot1 - 1] = moved;
                $.posIndex[id][moved.seriesId] = slot1;
            }
            ps.pop();
            delete $.posIndex[id][seriesId];
            uint256 refs = $.positionsOn[id][series.underlying] - 1;
            $.positionsOn[id][series.underlying] = refs;
            if (refs == 0 && $.collateral[id][series.underlying] == 0) --$.underlyingCount[id];
        } else {
            ps[slot1 - 1].qty = q;
        }

        $.longOI[seriesId] = $.longOI[seriesId] + _pos(newQty) - _pos(oldQty);
        $.unsettledShortQty[series.expiry] = $.unsettledShortQty[series.expiry] + _pos(-newQty) - _pos(-oldQty);
    }

    // ---------------------------------------------------------------- private

    function _enterUnion(uint256 id) private {
        CHStorage storage $ = s();
        uint256 n = $.underlyingCount[id];
        if (n >= MAX_UNDERLYINGS) revert CHErrors.TooManyUnderlyings();
        $.underlyingCount[id] = n + 1;
    }

    function _pos(int256 x) private pure returns (uint256) {
        return x > 0 ? uint256(x) : 0;
    }
}
