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

/// @notice A collateral token seen without a usable price (markUnpriced): since when, the feed's
/// latest round id then (0 if unreadable) and when it was last seen so (kept for an unreadable
/// feed only). Cleared once anyone sees a usable price again.
struct PriceOutage {
    uint64 since;
    uint80 round;
    uint64 seen;
}

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
    // Positions (see CHS.movePosition): the account's series in a packed list, eight per slot, and
    // per series one slot with its place in the list and its quantity.
    mapping(uint256 => uint32[]) positionSeries;
    mapping(uint256 => mapping(uint32 => uint256)) position; // (index + 1) << 128 | uint128(int128 qty)
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
    mapping(uint256 => address[]) unionOf; // the union, in the order its underlyings entered it
    mapping(uint256 => uint256) claimableTotal; // sum over expiries of claimable[id][E], at face
    // What an account still owes after its deficit was socialized (the pool's part spread over
    // all cash, plus the fund's written-off bridge); repaid to the InsuranceFund. Part of
    // deficitTotal.
    mapping(uint256 => uint256) socializedDebt;
    mapping(uint256 => uint64[]) deficitExpiries; // expiries where defPending or defBridged > 0
    mapping(address => PriceOutage) outages; // collateral tokens without a price, see markUnpriced
    mapping(uint256 => uint64[]) claimExpiries; // expiries where claimable[id][E] > 0
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
    error TooManyClaimExpiries(uint256 id);
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
    error AgentValueDrainExceeded(uint256 id, int256 loss, uint256 cap);
    error RiskIncreaseNotAllowed(uint256 id, uint256 im, uint256 preIm);
    error DustPosition(uint256 id, int256 qty);
    error UnderlyingDisabled();
    // settlement and deficits
    error NothingToSettle();
    error ExpiryNotSettled();
    error PoolNotReady();
    error PoolShortfall();
    error NotAuctionHouse(address caller);
    error NothingToSocialize();
    error AccountNotEmpty(uint256 id);
    error DepositNotAllowed();
    // setup
    error NotSetupAdmin();
    error SetupAlreadyFinalized();
    error AlreadyBound();
    error AuctionHouseNotBound();
    error NotImplemented();
    // auction house hooks
    error InvalidFraction();
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

    // ---------------------------------------------------------------- expiry lists

    /// @notice Removes `e` from an unordered expiry list (swap and pop); absent is a no-op.
    function dropExpiry(uint64[] storage xs, uint64 e) internal {
        uint256 n = xs.length;
        for (uint256 i = 0; i < n; ++i) {
            if (xs[i] == e) {
                xs[i] = xs[n - 1];
                xs.pop();
                return;
            }
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
            if ($.positionsOn[id][token] == 0) _enterUnion(id, token);
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
        if ($.positionsOn[id][token] == 0) _leaveUnion(id, token);
    }

    // ---------------------------------------------------------------- positions

    /// @notice How many positions the account holds.
    function positionCount(uint256 id) internal view returns (uint256) {
        return s().positionSeries[id].length;
    }

    /// @notice The account's quantity in `seriesId` (0 if none).
    function qtyOf(uint256 id, uint32 seriesId) internal view returns (int256) {
        return qtyIn(s().position[id][seriesId]);
    }

    /// @notice The quantity held in a position slot.
    function qtyIn(uint256 slot) internal pure returns (int256) {
        return int128(uint128(slot));
    }

    /// @notice The account's positions, in list order (the order they were opened, except that
    /// closing one moves the last into its place).
    function positionsOf(uint256 id) internal view returns (Position[] memory ps) {
        CHStorage storage $ = s();
        uint32[] memory sids = $.positionSeries[id];
        mapping(uint32 => uint256) storage pos = $.position[id];
        ps = new Position[](sids.length);
        for (uint256 i = 0; i < sids.length; ++i) {
            ps[i] = Position({seriesId: sids[i], qty: int128(uint128(pos[sids[i]]))});
        }
    }

    /// @notice The only way to change a position. `series` must be registry.series(seriesId).
    /// Creates, resizes or deletes (at zero) the entry; keeps the position-count and underlying
    /// caps, the per-series long open interest and the per-expiry open short quantity in sync.
    /// A new position costs one fresh slot (its quantity and place in the list) and an eighth of
    /// one (the packed list of series), which keeps a liquidation bid moving a whole book into an
    /// empty account within the gas limit.
    function movePosition(uint256 id, uint32 seriesId, int256 delta, Series memory series)
        internal
        returns (int256 oldQty, int256 newQty)
    {
        CHStorage storage $ = s();
        mapping(uint32 => uint256) storage pos = $.position[id];
        uint256 slot = pos[seriesId];
        uint256 slot1 = slot >> 128;
        oldQty = qtyIn(slot);
        newQty = oldQty + delta;
        int128 q = SafeCast.toInt128(newQty);

        if (slot1 == 0) {
            if (newQty != 0) {
                uint32[] storage sids = $.positionSeries[id];
                if (sids.length >= MAX_POSITIONS) revert CHErrors.TooManyPositions();
                uint256 refs = $.positionsOn[id][series.underlying];
                if (refs == 0 && $.collateral[id][series.underlying] == 0) _enterUnion(id, series.underlying);
                $.positionsOn[id][series.underlying] = refs + 1;
                sids.push(seriesId);
                pos[seriesId] = _slot(sids.length, q);
            }
        } else if (newQty == 0) {
            uint32[] storage sids = $.positionSeries[id];
            uint256 last = sids.length - 1;
            if (slot1 - 1 != last) {
                uint32 moved = sids[last];
                sids[slot1 - 1] = moved;
                pos[moved] = _slot(slot1, int128(qtyIn(pos[moved])));
            }
            sids.pop();
            delete pos[seriesId];
            uint256 refs = $.positionsOn[id][series.underlying] - 1;
            $.positionsOn[id][series.underlying] = refs;
            if (refs == 0 && $.collateral[id][series.underlying] == 0) _leaveUnion(id, series.underlying);
        } else {
            pos[seriesId] = _slot(slot1, q);
        }

        $.longOI[seriesId] = $.longOI[seriesId] + _pos(newQty) - _pos(oldQty);
        $.unsettledShortQty[series.expiry] = $.unsettledShortQty[series.expiry] + _pos(-newQty) - _pos(-oldQty);
    }

    // ---------------------------------------------------------------- claims

    /// @notice Pays `pay` of the account's claim `amt` on `expiry` from the pool into its cash
    /// (less than `amt` only on an impaired pool) and closes the claim.
    function payClaim(uint256 id, uint64 expiry, uint256 amt, uint256 pay) internal {
        CHStorage storage $ = s();
        $.claimable[id][expiry] = 0;
        dropExpiry($.claimExpiries[id], expiry);
        $.totalClaimable[expiry] -= amt;
        $.claimableTotal[id] -= amt;
        $.pool[expiry] -= pay;
        credit(id, pay);
    }

    // ---------------------------------------------------------------- private

    function _slot(uint256 slot1, int128 q) private pure returns (uint256) {
        return slot1 << 128 | uint128(q);
    }

    function _enterUnion(uint256 id, address u) private {
        address[] storage us = s().unionOf[id];
        if (us.length >= MAX_UNDERLYINGS) revert CHErrors.TooManyUnderlyings();
        us.push(u);
    }

    function _leaveUnion(uint256 id, address u) private {
        address[] storage us = s().unionOf[id];
        uint256 n = us.length; // <= MAX_UNDERLYINGS
        for (uint256 i = 0; i < n; ++i) {
            if (us[i] == u) {
                us[i] = us[n - 1];
                us.pop();
                return;
            }
        }
    }

    function _pos(int256 x) private pure returns (uint256) {
        return x > 0 ? uint256(x) : 0;
    }
}
