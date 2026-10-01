// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IClearinghouse, TradeParams} from "../interfaces/IClearinghouse.sol";
import {ISeriesRegistry} from "../interfaces/ISeriesRegistry.sol";
import {IMarketDataHub} from "../interfaces/IMarketDataHub.sol";
import {IRiskParams} from "../interfaces/IRiskParams.sol";
import {BlackScholes} from "../libraries/BlackScholes.sol";
import {FixedPointMath as F} from "../libraries/FixedPointMath.sol";
import {Position, Series, Session, WAD} from "../types/Types.sol";

/// @notice Strategy and quoting parameters of a vault. All fractions are WAD.
struct VaultConfig {
    uint64 minOtm; // minimum distance of the strike from spot, e.g. 0.05e18
    uint32 maxTenorDays; // latest expiry the vault sells, in days from now
    uint64 skewSlope; // vol add per unit |ln(K/S)|
    uint64 utilSlope; // vol add at full utilization
    uint64 spread; // ask = px * (1 + spread), bid = px * (1 - spread)
    uint64[5] sessionVolAdd; // absolute vol add per Session (REGULAR..HALTED); HALTED unused (no quotes)
    uint128 maxTradeQty; // contracts per buy
}

/// @notice ERC-4626 option-selling vault on one clearinghouse subaccount. Shares are priced at
/// the account's live mark-to-market equity, so entries and exits can't trade against a stale
/// NAV. Takers buy options from the vault (the vault goes short within its strategy) and may sell
/// them back at the bid up to the vault's short. Assets locked behind open shorts leave through
/// requestRedeem: escrowed shares are paid out by a permissionless roll once an expiry has settled
/// and released enough of the lock.
///
/// A strategy (covered call, cash-secured put) supplies the strategy check, what locks the
/// backing, what the backing is, and how equity converts into the asset.
abstract contract OptionVaultBase is ERC4626, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    error VaultNotLive();
    error BadConfig();
    error ZeroAddress();
    error ZeroShares();
    error BadQty();
    error WrongUnderlying();
    error WrongOptionType();
    error SeriesExpired();
    error TenorTooLong();
    error StrikeNotOtm();
    error ExceedsCapacity(uint256 required, uint256 available);
    error ExceedsShort(uint256 qty, uint256 short);
    error ExceedsFreeAssets(uint256 assets, uint256 free);
    error PremiumAboveMax(uint256 premium, uint256 maxPremium);
    error PremiumBelowMin(uint256 premium, uint256 minPremium);
    error NothingToClaim();

    event Bought(address indexed taker, uint256 indexed takerId, uint32 indexed seriesId, uint256 qty, uint256 premium);
    event SoldBack(
        address indexed taker, uint256 indexed takerId, uint32 indexed seriesId, uint256 qty, uint256 premium
    );
    event RedeemRequested(
        uint256 indexed requestId, uint256 indexed epoch, address indexed owner, address receiver, uint256 shares
    );
    event Rolled(uint256 indexed epoch, uint256 assets);
    event RedeemClaimed(address indexed receiver, uint256 assets);

    /// @dev A receiver's queued shares; paid out at the rate of `epoch` once that epoch is rolled.
    struct PendingRedeem {
        uint256 epoch;
        uint256 shares;
    }

    /// @dev What an epoch's roll paid: `assets` for `shares`, split pro rata among its receivers.
    struct EpochResult {
        uint256 shares;
        uint256 assets;
    }

    // Settlement outcomes the roll tolerates: nothing to do yet, or a clearinghouse without
    // expiry settlement. Anything else bubbles up.
    bytes4 private constant NOT_IMPLEMENTED = bytes4(keccak256("NotImplemented()"));
    bytes4 private constant NOTHING_TO_SETTLE = bytes4(keccak256("NothingToSettle()"));
    bytes4 private constant POOL_NOT_READY = bytes4(keccak256("PoolNotReady()"));

    IClearinghouse public immutable ch;
    ISeriesRegistry public immutable registry;
    IMarketDataHub public immutable hub;
    IRiskParams public immutable params;
    /// @notice the stock token the vault writes options on
    address public immutable underlying;
    /// @notice the vault's clearinghouse subaccount (owned by this contract)
    uint256 public immutable vaultId;
    /// @dev 10 ** (18 - asset decimals): WAD amounts in the clearinghouse per raw asset unit
    uint256 internal immutable _assetScale;

    VaultConfig internal _cfg;

    /// @notice current redemption epoch: new requests join it, the next roll pays it
    uint256 public epoch;
    /// @notice shares held in escrow for the current epoch
    uint256 public escrowedShares;
    /// @notice assets withdrawn for rolled epochs and not yet claimed; held by this contract, not
    /// part of the clearinghouse account and so never part of totalAssets
    uint256 public reservedAssets;
    uint256 public nextRequestId;

    mapping(address receiver => PendingRedeem) private _pending;
    mapping(address receiver => uint256) private _redeemable;
    mapping(uint256 epoch => EpochResult) private _epochs;

    constructor(
        IERC20Metadata asset_,
        address underlying_,
        IClearinghouse ch_,
        ISeriesRegistry registry_,
        IMarketDataHub hub_,
        IRiskParams params_,
        VaultConfig memory cfg,
        string memory name_,
        string memory symbol_
    ) ERC20(name_, symbol_) ERC4626(asset_) {
        if (
            address(ch_) == address(0) || address(registry_) == address(0) || address(hub_) == address(0)
                || address(params_) == address(0)
        ) revert ZeroAddress();
        if (cfg.minOtm >= WAD || cfg.spread >= WAD || cfg.maxTenorDays == 0 || cfg.maxTradeQty == 0) {
            revert BadConfig();
        }
        if (!params_.underlying(underlying_).enabled) revert BadConfig();
        uint8 dec = asset_.decimals();
        if (dec > 18) revert BadConfig();

        ch = ch_;
        registry = registry_;
        hub = hub_;
        params = params_;
        underlying = underlying_;
        _assetScale = 10 ** (18 - dec);
        _cfg = cfg;

        vaultId = ch_.createSubaccount();
        IERC20(address(asset_)).forceApprove(address(ch_), type(uint256).max);
    }

    // ================================================================ strategy hooks

    /// @dev Reverts unless the vault's strategy sells `s` at `spot` (option type, moneyness).
    function _checkStrategy(Series memory s, uint256 spot) internal view virtual;

    /// @dev WAD backing locked by a short of `absQty` in `seriesId`.
    function _lockedFor(uint32 seriesId, uint256 absQty) internal view virtual returns (uint256);

    /// @dev WAD amount of the asset held in the vault's clearinghouse account.
    function _backingWad() internal view virtual returns (uint256);

    /// @dev Positive WAD USD equity converted into raw asset units, rounded down.
    function _equityToAssets(uint256 equityWad) internal view virtual returns (uint256);

    // ================================================================ views

    function config() external view returns (VaultConfig memory) {
        return _cfg;
    }

    /// @notice The underlying trades normally: its price is readable, plausible and fresh, and the
    /// hub doesn't report it HALTED.
    function isLive() public view returns (bool live) {
        try hub.spot(underlying) returns (uint256, Session, bool ok) {
            live = ok;
        } catch {}
    }

    /// @notice Live MTM equity of the clearinghouse account (kernel marks, settled values and
    /// deficits included), floored at zero and converted into the asset. Assets reserved for
    /// rolled redemptions sit in this contract, outside the account, so they are not counted.
    function totalAssets() public view override returns (uint256) {
        int256 equity = ch.accountState(vaultId).equity;
        return equity > 0 ? _equityToAssets(uint256(equity)) : 0;
    }

    /// @notice Asset units that can leave the account now without uncovering a short.
    function freeAssets() public view returns (uint256) {
        (uint256 lockedWad, uint256 backingWad,) = _exposure(0);
        return _free(lockedWad, backingWad);
    }

    /// @notice Asset units locked behind open shorts (rounded up).
    function lockedAssets() public view returns (uint256) {
        (uint256 lockedWad,,) = _exposure(0);
        return Math.ceilDiv(lockedWad, _assetScale);
    }

    /// @notice Assets `receiver` can claim now, including a rolled epoch not yet folded in.
    function redeemable(address receiver) external view returns (uint256 assets) {
        assets = _redeemable[receiver];
        PendingRedeem storage p = _pending[receiver];
        if (p.shares != 0 && p.epoch < epoch) {
            EpochResult storage r = _epochs[p.epoch];
            assets += Math.mulDiv(p.shares, r.assets, r.shares);
        }
    }

    /// @notice Shares `receiver` has queued in the current epoch.
    function pendingRedeem(address receiver) external view returns (uint256) {
        PendingRedeem storage p = _pending[receiver];
        return p.epoch == epoch ? p.shares : 0;
    }

    /// @notice Premium for `qty` contracts of `seriesId`: the ask when the taker buys, the bid when
    /// the taker sells back.
    ///   vol    = hub mark vol
    ///   m      = |ln(K / S)|
    ///   util   = locked / (locked + free), both in asset units, measured after the trade
    ///   volQ   = vol * (1 + skewSlope * m + utilSlope * util) + sessionVolAdd[session]
    ///   px     = Black-Scholes price at volQ
    ///   ask    = ceil(ceil(qty * px) * (1 + spread)), bid = floor(floor(qty * px) * (1 - spread))
    /// Utilization is taken after the trade, the state the premium pays for. At the pre-trade
    /// utilization a taker could buy at a low-utilization ask and sell straight back at the
    /// higher-utilization bid its own purchase created.
    function quote(uint32 seriesId, uint256 qty, bool takerBuys) public view returns (uint256 premium) {
        (Series memory s, uint256 spot, Session sess) = _liveSeries(seriesId);
        (uint256 lockedWad, uint256 backingWad,) = _exposure(0);
        uint256 delta = _lockedFor(seriesId, qty);
        uint256 lockedAfter = takerBuys ? lockedWad + delta : (delta < lockedWad ? lockedWad - delta : 0);
        return _premium(s, spot, sess, qty, takerBuys, lockedAfter, backingWad);
    }

    // ================================================================ ERC-4626 limits

    function maxDeposit(address) public view override returns (uint256) {
        return isLive() ? type(uint256).max : 0;
    }

    function maxMint(address) public view override returns (uint256) {
        return isLive() ? type(uint256).max : 0;
    }

    /// @notice The owner's shares at NAV, capped by the free assets. Zero while halted or while
    /// the account owes a deficit (the clearinghouse blocks withdrawals then).
    function maxWithdraw(address owner) public view override returns (uint256) {
        if (!_canExit()) return 0;
        uint256 free = freeAssets();
        uint256 own = previewRedeem(balanceOf(owner));
        return own < free ? own : free;
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        if (!_canExit()) return 0;
        uint256 cap = _convertToShares(freeAssets(), Math.Rounding.Floor);
        uint256 own = balanceOf(owner);
        return own < cap ? own : cap;
    }

    // ================================================================ ERC-4626 entry points

    function deposit(uint256 assets, address receiver) public override nonReentrant returns (uint256) {
        _requireLive();
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override nonReentrant returns (uint256) {
        _requireLive();
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner) public override nonReentrant returns (uint256) {
        _requireLive();
        return super.withdraw(assets, receiver, owner);
    }

    function redeem(uint256 shares, address receiver, address owner) public override nonReentrant returns (uint256) {
        _requireLive();
        return super.redeem(shares, receiver, owner);
    }

    // ================================================================ trading

    /// @notice The caller (owner or agent of `takerId`) buys `qty` contracts; the vault sells them.
    /// The strategy's cover rule is common to both vaults: everything locked after the sale (tokens
    /// behind calls, strike notional behind puts) must fit in the backing.
    function buy(uint32 seriesId, uint256 qty, uint256 maxPremium, uint256 takerId)
        external
        nonReentrant
        returns (uint256 premium)
    {
        (Series memory s, uint256 spot, Session sess) = _liveSeries(seriesId);
        VaultConfig storage c = _cfg;
        if (qty == 0 || qty > c.maxTradeQty) revert BadQty();
        if (s.expiry > block.timestamp + uint256(c.maxTenorDays) * 1 days) revert TenorTooLong();
        _checkStrategy(s, spot);
        (uint256 lockedWad, uint256 backingWad,) = _exposure(0);
        uint256 lockedAfter = lockedWad + _lockedFor(seriesId, qty);
        if (lockedAfter > backingWad) revert ExceedsCapacity(lockedAfter, backingWad);
        premium = _premium(s, spot, sess, qty, true, lockedAfter, backingWad);
        if (premium > maxPremium) revert PremiumAboveMax(premium, maxPremium);

        _trade(seriesId, int256(qty), premium, takerId);
        emit Bought(msg.sender, takerId, seriesId, qty, premium);
    }

    /// @notice The caller sells `qty` contracts back to the vault at the bid, at most the vault's
    /// current short in the series: the vault never goes long.
    function sellBack(uint32 seriesId, uint256 qty, uint256 minPremium, uint256 takerId)
        external
        nonReentrant
        returns (uint256 premium)
    {
        (Series memory s, uint256 spot, Session sess) = _liveSeries(seriesId);
        if (qty == 0) revert BadQty();
        (uint256 lockedWad, uint256 backingWad, uint256 short) = _exposure(seriesId);
        if (qty > short) revert ExceedsShort(qty, short);
        premium = _premium(s, spot, sess, qty, false, lockedWad - _lockedFor(seriesId, qty), backingWad);
        if (premium < minPremium) revert PremiumBelowMin(premium, minPremium);

        _trade(seriesId, -int256(qty), premium, takerId);
        emit SoldBack(msg.sender, takerId, seriesId, qty, premium);
    }

    // ================================================================ async redemption

    /// @notice Moves `shares` into escrow for the current epoch; `receiver` claims their assets
    /// after the roll that pays the epoch. Works while halted: nothing is priced here.
    function requestRedeem(uint256 shares, address receiver) external nonReentrant returns (uint256 requestId) {
        if (shares == 0) revert ZeroShares();
        if (receiver == address(0)) revert ZeroAddress();
        uint256 ep = epoch;
        PendingRedeem storage p = _pending[receiver];
        _fold(receiver, p);
        p.epoch = ep;
        p.shares += shares;
        escrowedShares += shares;
        requestId = nextRequestId++;
        _transfer(msg.sender, address(this), shares);
        emit RedeemRequested(requestId, ep, msg.sender, receiver, shares);
    }

    /// @notice Pushes everything `receiver` can claim to `receiver`. Callable by anyone.
    function claimRedeemed(address receiver) external nonReentrant returns (uint256 assets) {
        _fold(receiver, _pending[receiver]);
        assets = _redeemable[receiver];
        if (assets == 0) revert NothingToClaim();
        _redeemable[receiver] = 0;
        reservedAssets -= assets;
        IERC20(asset()).safeTransfer(receiver, assets);
        emit RedeemClaimed(receiver, assets);
    }

    /// @notice Permissionless. For each expiry in `expiries`: settles the vault's positions once
    /// the registry has the settlement price, and collects any claim. Then, if the vault owes
    /// nothing, has no claim outstanding on those expiries, is live and its free assets cover the
    /// payout, pays the current epoch at the current NAV: the escrowed shares burn and their
    /// assets move from the account into this contract for the receivers to claim.
    /// Positions still open on other expiries don't hold the epoch back: the payout is priced and
    /// capped exactly like an instant withdrawal (live MTM NAV, free assets only). Waiting for a
    /// flat book would let one dust-sized sale at the longest tenor block every queued redemption
    /// for weeks, and a vault selling overlapping expiries would never pay at all.
    function roll(uint64[] calldata expiries) external nonReentrant {
        uint256 id = vaultId;
        for (uint256 i = 0; i < expiries.length; ++i) {
            uint64 e = expiries[i];
            if (_holdsExpiry(e)) {
                (, bool settled) = registry.settlementPriceOf(underlying, e);
                if (settled) {
                    try ch.settleAccount(id, e) {}
                    catch (bytes memory err) {
                        _tolerate(err);
                    }
                }
            }
            if (ch.claimable(id, e) != 0) {
                try ch.claim(id, e) {}
                catch (bytes memory err) {
                    _tolerate(err);
                }
            }
        }
        _processEpoch(expiries);
    }

    // ================================================================ ERC-4626 internals

    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    /// @dev Pulls the asset (OZ), then books it into the vault's clearinghouse account.
    function _transferIn(address from, uint256 assets) internal override {
        super._transferIn(from, assets);
        if (assets != 0) ch.deposit(vaultId, asset(), assets);
    }

    /// @dev Only free assets leave instantly; the rest waits for a roll.
    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal
        override
    {
        uint256 free = freeAssets();
        if (assets > free) revert ExceedsFreeAssets(assets, free);
        super._withdraw(caller, receiver, owner, assets, shares);
    }

    /// @dev Straight from the clearinghouse account to the receiver.
    function _transferOut(address to, uint256 assets) internal override {
        if (assets != 0) ch.withdraw(vaultId, asset(), assets, to);
    }

    // ================================================================ internals

    function _requireLive() internal view {
        if (!isLive()) revert VaultNotLive();
    }

    function _canExit() private view returns (bool) {
        if (!isLive()) return false;
        (uint256 deficit,,) = ch.deficitOf(vaultId, 0);
        return deficit == 0;
    }

    /// @dev The series on the vault's underlying, not expired, with a live spot.
    function _liveSeries(uint32 seriesId) private view returns (Series memory s, uint256 spot, Session sess) {
        bool ok;
        try hub.spot(underlying) returns (uint256 p, Session ss, bool o) {
            (spot, sess, ok) = (p, ss, o);
        } catch {}
        if (!ok) revert VaultNotLive();
        s = registry.series(seriesId);
        if (s.underlying != underlying) revert WrongUnderlying();
        if (block.timestamp >= s.expiry) revert SeriesExpired();
    }

    /// @dev Single-option pricing runs in Solidity (BlackScholes.price, bit-identical to the risk
    /// kernel's bsQuote price): on Robinhood Chain one evaluation measured 26.9k gas here against
    /// 46.5k through an uncached call into the Stylus kernel. The kernel pays off on portfolio
    /// margin, not on one price.
    function _premium(
        Series memory s,
        uint256 spot,
        Session sess,
        uint256 qty,
        bool takerBuys,
        uint256 lockedWad,
        uint256 backingWad
    ) private view returns (uint256) {
        VaultConfig storage c = _cfg;
        uint256 volQ;
        {
            int256 lnm = F.lnWad(F.divWad(int256(uint256(s.strike)), int256(spot)));
            uint256 m = lnm < 0 ? uint256(-lnm) : uint256(lnm);
            uint256 locked = Math.ceilDiv(lockedWad, _assetScale);
            uint256 total = locked + _free(lockedWad, backingWad);
            uint256 util = total == 0 ? 0 : locked * WAD / total;
            volQ = _mulWad(hub.markVol(underlying), WAD + _mulWad(c.skewSlope, m) + _mulWad(c.utilSlope, util))
                + c.sessionVolAdd[uint8(sess)];
        }
        uint256 px =
            BlackScholes.price(spot, s.strike, s.expiry - block.timestamp, volQ, params.globals().rate, s.isCall);
        if (takerBuys) return F.mulWadUp(F.mulWadUp(qty, px), WAD + c.spread);
        return _mulWad(_mulWad(qty, px), WAD - c.spread);
    }

    function _trade(uint32 seriesId, int256 qty, uint256 premium, uint256 takerId) private {
        ch.trade(
            TradeParams({
                takerActor: msg.sender,
                makerActor: address(this),
                takerId: takerId,
                makerId: vaultId,
                seriesId: seriesId,
                qty: qty,
                premium: premium
            })
        );
    }

    /// @dev One pass over the vault's positions: WAD locked by its shorts, its WAD backing, and its
    /// short in `seriesId` (0 = none; series ids start at 1).
    function _exposure(uint32 seriesId) private view returns (uint256 lockedWad, uint256 backingWad, uint256 short) {
        Position[] memory ps = ch.positionsOf(vaultId);
        for (uint256 i = 0; i < ps.length; ++i) {
            int256 q = ps[i].qty;
            if (q >= 0) continue;
            uint256 a = uint256(-q);
            lockedWad += _lockedFor(ps[i].seriesId, a);
            if (ps[i].seriesId == seriesId) short = a;
        }
        backingWad = _backingWad();
    }

    function _free(uint256 lockedWad, uint256 backingWad) private view returns (uint256) {
        return backingWad > lockedWad ? (backingWad - lockedWad) / _assetScale : 0;
    }

    function _holdsExpiry(uint64 e) private view returns (bool) {
        Position[] memory ps = ch.positionsOf(vaultId);
        for (uint256 i = 0; i < ps.length; ++i) {
            if (registry.series(ps[i].seriesId).expiry == e) return true;
        }
        return false;
    }

    /// @dev Pays the current epoch if the vault can: no deficit, no claim outstanding on
    /// `expiries`, live, and the payout within the free assets. Otherwise the epoch stays open.
    function _processEpoch(uint64[] calldata expiries) private {
        uint256 shares = escrowedShares;
        if (shares == 0) return;
        uint256 id = vaultId;
        (uint256 deficit,,) = ch.deficitOf(id, 0);
        if (deficit != 0) return;
        for (uint256 i = 0; i < expiries.length; ++i) {
            if (ch.claimable(id, expiries[i]) != 0) return;
        }
        if (!isLive()) return;
        uint256 assets = _convertToAssets(shares, Math.Rounding.Floor);
        if (assets > freeAssets()) return;

        uint256 ep = epoch;
        _epochs[ep] = EpochResult({shares: shares, assets: assets});
        escrowedShares = 0;
        epoch = ep + 1;
        reservedAssets += assets;
        _burn(address(this), shares);
        if (assets != 0) ch.withdraw(id, asset(), assets, address(this));
        emit Rolled(ep, assets);
    }

    /// @dev Folds a rolled epoch's payout into the receiver's claimable balance.
    function _fold(address receiver, PendingRedeem storage p) private {
        uint256 sh = p.shares;
        if (sh == 0 || p.epoch >= epoch) return;
        EpochResult storage r = _epochs[p.epoch];
        _redeemable[receiver] += Math.mulDiv(sh, r.assets, r.shares);
        p.shares = 0;
    }

    function _tolerate(bytes memory err) private pure {
        bytes4 sel = err.length >= 4 ? bytes4(err) : bytes4(0);
        if (sel == NOT_IMPLEMENTED || sel == NOTHING_TO_SETTLE || sel == POOL_NOT_READY) return;
        assembly ("memory-safe") {
            revert(add(err, 0x20), mload(err))
        }
    }

    function _mulWad(uint256 a, uint256 b) internal pure returns (uint256) {
        return a * b / WAD;
    }
}
