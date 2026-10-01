// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IClearinghouse, TradeParams, AccountState} from "../interfaces/IClearinghouse.sol";
import {ISeriesRegistry} from "../interfaces/ISeriesRegistry.sol";
import {IMarketDataHub} from "../interfaces/IMarketDataHub.sol";
import {IRiskParams, GlobalParams, UnderlyingParams} from "../interfaces/IRiskParams.sol";
import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";
import {VaultPricing} from "./VaultPricing.sol";
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
    uint128 maxTradeQty; // contracts per buy, >= the clearinghouse's minTradeQty
    uint16 maxOpenSeries; // series the vault may be short at once, e.g. 24
    uint64 minDelta; // offer band: the vault sells only if |delta| at mark vol is within
    uint64 maxDelta; //   [minDelta, maxDelta], e.g. 0.05e18 .. 0.5e18
    uint128 minNewSeriesQty; // smallest sale that opens a series the vault isn't short in, e.g. 1e18
}

/// @notice ERC-4626 option-selling vault on one clearinghouse subaccount. Shares are priced at
/// the account's live mark-to-market equity, so entries and exits can't trade against a stale
/// NAV. Takers buy options from the vault (the vault goes short within its strategy) and may sell
/// them back at the bid up to the vault's short; the bid never exceeds the vault's own mark, so a
/// buyback can't move depositors' equity to the seller. Assets locked behind open shorts leave
/// through requestRedeem: escrowed shares are paid out by a permissionless roll once an expiry has
/// settled and released enough of the lock. Shares can't leave within EXIT_COOLDOWN of arriving.
///
/// A strategy (covered call, cash-secured put) supplies the strategy check, what locks the
/// backing, what the backing is, and how equity converts into the asset.
abstract contract OptionVaultBase is ERC4626, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    error VaultNotLive();
    error BadConfig();
    error ZeroAddress();
    error BadReceiver();
    error ZeroShares();
    error BadQty();
    error WrongUnderlying();
    error WrongOptionType();
    error SeriesExpired();
    error TenorTooLong();
    error StrikeNotOtm();
    error TooManySeries();
    error OutsideOfferBand(uint256 absDelta);
    error BelowMinNewSeries();
    error VolNotCurrent();
    error DustPosition(uint256 id, int256 qty); // same selector as the clearinghouse's
    error VaultInDeficit();
    error ExitCooldown(address owner, uint256 until);
    error ExceedsCapacity(uint256 required, uint256 available);
    error ExceedsShort(uint256 qty, uint256 short);
    error ExceedsFreeAssets(uint256 assets, uint256 free);
    error PremiumAboveMax(uint256 premium, uint256 maxPremium);
    error PremiumBelowMin(uint256 premium, uint256 minPremium);
    error BelowMinOut(uint256 tokens, uint256 cash);
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
    /// @notice The USDG part of an in-kind exit (CoveredCallVault), in raw USDG units.
    event CashLegPaid(address indexed receiver, uint256 amount);

    /// @dev A receiver's queued shares; paid out at the rate of `epoch` once that epoch is rolled.
    struct PendingRedeem {
        uint256 epoch;
        uint256 shares;
    }

    /// @dev What an epoch's roll paid: `assets` (and `cash`, raw USDG units, for an in-kind exit)
    /// for `shares`, split pro rata among its receivers.
    struct EpochResult {
        uint256 shares;
        uint256 assets;
        uint256 cash;
    }

    /// @dev The vault's book as one trade sees it.
    struct Book {
        uint256 lockedWad; // backing locked by the open shorts
        uint256 backingWad; // collateral tokens or cash in the account
        uint256 short; // short in the traded series
        uint256 open; // series with an open short
        uint256 queued; // asset units owed to the redemption queue (rounded up)
    }

    /// @notice Shares can't be withdrawn, redeemed or queued for redemption until this long after
    /// their owner last received shares: a deposit can't lift the backing for one trade and leave
    /// before the next.
    uint256 public constant EXIT_COOLDOWN = 1 hours;

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
    address internal immutable _usdg;
    /// @dev 10 ** (18 - USDG decimals)
    uint256 internal immutable _usdgScale;

    VaultConfig internal _cfg;

    /// @notice current redemption epoch: new requests join it, the next roll pays it
    uint256 public epoch;
    /// @notice shares held in escrow for the current epoch
    uint256 public escrowedShares;
    /// @notice assets withdrawn for rolled epochs and not yet claimed; held by this contract, not
    /// part of the clearinghouse account and so never part of totalAssets
    uint256 public reservedAssets;
    /// @notice the USDG side of reservedAssets (raw units), for in-kind exits
    uint256 public reservedCash;
    uint256 public nextRequestId;
    /// @notice when each holder's shares count as received (see _update)
    mapping(address holder => uint256) public lastReceive;

    mapping(address receiver => PendingRedeem) private _pending;
    mapping(address receiver => uint256) private _redeemable;
    mapping(address receiver => uint256) private _redeemableCash;
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
        uint256 minTradeQty = params_.globals().minTradeQty;
        if (
            cfg.minOtm >= WAD || cfg.spread >= WAD || cfg.maxTenorDays == 0 || cfg.maxOpenSeries == 0
                || cfg.maxTradeQty < minTradeQty || cfg.minDelta > cfg.maxDelta || cfg.maxDelta > WAD
                || cfg.minNewSeriesQty < minTradeQty || cfg.minNewSeriesQty > cfg.maxTradeQty
        ) revert BadConfig();
        if (!params_.underlying(underlying_).enabled) revert BadConfig();
        uint8 dec = asset_.decimals();
        if (dec > 18) revert BadConfig();

        ch = ch_;
        registry = registry_;
        hub = hub_;
        params = params_;
        underlying = underlying_;
        _assetScale = 10 ** (18 - dec);
        address usdg_ = params_.usdg();
        _usdg = usdg_;
        _usdgScale = 10 ** (18 - IERC20Metadata(usdg_).decimals());
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

    /// @dev Positive WAD USD equity converted into raw asset units, rounded down; 0 if it can't be
    /// priced.
    function _equityToAssets(uint256 equityWad) internal view virtual returns (uint256);

    /// @dev How an exit worth `assets` (asset units, at NAV) is paid: `tokens` of the asset and
    /// `cash` raw USDG units. By default all in the asset.
    function _split(uint256 assets) internal view virtual returns (uint256 tokens, uint256 cash) {
        return (assets, 0);
    }

    /// @dev The exit value (asset units, at NAV) whose asset part is at least `tokens` (inverse of
    /// _split, rounded up). By default `tokens` itself.
    function _grossUp(uint256 tokens) internal view virtual returns (uint256) {
        return tokens;
    }

    // ================================================================ views

    function config() external view returns (VaultConfig memory) {
        return _cfg;
    }

    /// @notice The underlying trades normally: its price is readable, plausible and fresh, the hub
    /// doesn't report it HALTED, and its mark vol (which the vault prices and marks at) was updated
    /// within its volStaleness and has folded in the feed's latest round. Every operation syncs
    /// the vol first (hub.syncVol), so a view can read false here while the next operation runs.
    function isLive() public view returns (bool ok) {
        (,, ok) = _liveSpot();
    }

    /// @notice Live MTM equity of the clearinghouse account (kernel marks, settled values, pending
    /// claims and deficits included), floored at zero and converted into the asset; 0 if the
    /// account can't be priced right now. Assets reserved for rolled redemptions sit in this
    /// contract, outside the account, so they are not counted.
    function totalAssets() public view override returns (uint256) {
        try ch.accountState(vaultId) returns (AccountState memory st) {
            return st.equity > 0 ? _equityToAssets(uint256(st.equity)) : 0;
        } catch {
            return 0;
        }
    }

    /// @notice Asset units that can leave instantly: what the open shorts don't lock, less what the
    /// redemption queue is owed.
    function freeAssets() public view returns (uint256) {
        Book memory b = _book(0);
        return _sub(_free(b.lockedWad, b.backingWad), b.queued);
    }

    /// @notice Asset units locked behind open shorts (rounded up).
    function lockedAssets() public view returns (uint256) {
        return Math.ceilDiv(_book(0).lockedWad, _assetScale);
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

    /// @notice The USDG (raw units) `receiver` can claim now alongside redeemable(), for in-kind
    /// exits.
    function redeemableCash(address receiver) external view returns (uint256 cash) {
        cash = _redeemableCash[receiver];
        PendingRedeem storage p = _pending[receiver];
        if (p.shares != 0 && p.epoch < epoch) {
            EpochResult storage r = _epochs[p.epoch];
            cash += Math.mulDiv(p.shares, r.cash, r.shares);
        }
    }

    /// @notice Shares `receiver` has queued in the current epoch.
    function pendingRedeem(address receiver) external view returns (uint256) {
        PendingRedeem storage p = _pending[receiver];
        return p.epoch == epoch ? p.shares : 0;
    }

    /// @notice Premium for `qty` contracts of `seriesId`: the ask when the taker buys, the bid when
    /// the taker sells back.
    ///   vol    = hub mark vol (what NAV marks the vault's shorts at)
    ///   m      = |ln(K / S)|
    ///   util   = locked / (locked + free), both in asset units, measured after the trade, with
    ///            the redemption queue's claim taken out of free
    ///   volQ   = vol * (1 + skewSlope * m + utilSlope * util) + sessionVolAdd[session]
    ///   ask    = ceil(ceil(qty * px(volQ)) * (1 + spread))
    ///   bid    = floor(floor(qty * min(px(volQ), px(vol))) * (1 - spread))
    /// Utilization is taken after the trade, the state the premium pays for. The bid is capped at
    /// the mark: volQ >= vol, and a buyback above the price NAV carries the short at would hand
    /// depositors' equity to the seller (e.g. buy one series cheaply, fill the vault with another
    /// to raise utilization, sell the first back). Reverts like the trade would on the vault side:
    /// a bid beyond the vault's short, or a result that leaves the vault a dust position.
    function quote(uint32 seriesId, uint256 qty, bool takerBuys) public view returns (uint256 premium) {
        (Series memory s, uint256 spot, Session sess) = _liveSeries(seriesId);
        Book memory b = _book(seriesId);
        GlobalParams memory g = params.globals();
        uint256 lockedAfter;
        if (takerBuys) {
            lockedAfter = b.lockedWad + _lockedFor(seriesId, qty);
        } else {
            if (qty > b.short) revert ExceedsShort(qty, b.short);
            lockedAfter = b.lockedWad - _lockedFor(seriesId, qty);
        }
        _checkDust(b.short, qty, takerBuys, g.minTradeQty);
        return _premium(s, spot, sess, qty, takerBuys, lockedAfter, b, g.rate);
    }

    // ================================================================ ERC-4626 limits

    /// @notice Unlimited while live, except: nothing while the account owes a deficit, and nothing
    /// into a vault whose shares are worth nothing (or can't be priced).
    function maxDeposit(address) public view override returns (uint256) {
        return _canEnter() ? type(uint256).max : 0;
    }

    function maxMint(address) public view override returns (uint256) {
        return _canEnter() ? type(uint256).max : 0;
    }

    /// @notice The asset the owner's shares redeem for, capped by the free assets. Zero while
    /// halted, while the account owes a deficit (the clearinghouse blocks withdrawals then), while
    /// it holds an expired position not yet settled (roll settles it) and during the owner's exit
    /// cooldown.
    function maxWithdraw(address owner) public view override returns (uint256) {
        if (!_canExit(owner)) return 0;
        uint256 own = previewRedeem(balanceOf(owner));
        uint256 free = freeAssets();
        return own < free ? own : free;
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        if (!_canExit(owner)) return 0;
        uint256 own = balanceOf(owner);
        uint256 free = freeAssets();
        if (previewRedeem(own) <= free) return own;
        uint256 cap = _convertToShares(_grossUp(free), Math.Rounding.Floor);
        return cap < own ? cap : own;
    }

    // ================================================================ ERC-4626 previews

    /// @notice The asset `shares` redeem for now: their value at NAV less the USDG part of an
    /// in-kind exit (see previewRedeemInKind). redeem returns, and the Withdraw event logs, exactly
    /// the asset that moves; any USDG part comes on top (CashLegPaid).
    function previewRedeem(uint256 shares) public view override returns (uint256 tokens) {
        (tokens,) = _split(_convertToAssets(shares, Math.Rounding.Floor));
    }

    /// @notice The shares withdraw(assets) burns: enough that the asset part of their value is
    /// `assets`. The receiver gets exactly `assets` plus any USDG part on top.
    function previewWithdraw(uint256 assets) public view override returns (uint256) {
        return _convertToShares(_grossUp(assets), Math.Rounding.Ceil);
    }

    /// @notice Both parts of redeeming `shares` now: `tokens` of the asset and `cash` raw USDG
    /// units (cash is 0 for a vault whose asset is USDG).
    function previewRedeemInKind(uint256 shares) external view returns (uint256 tokens, uint256 cash) {
        return _split(_convertToAssets(shares, Math.Rounding.Floor));
    }

    // ================================================================ ERC-4626 entry points

    function deposit(uint256 assets, address receiver) public override nonReentrant returns (uint256) {
        _syncVol();
        _requireLive();
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override nonReentrant returns (uint256) {
        _syncVol();
        _requireLive();
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner) public override nonReentrant returns (uint256) {
        _syncVol();
        _requireLive();
        _requireCooledDown(owner);
        return super.withdraw(assets, receiver, owner);
    }

    /// @notice ERC-4626 redeem. Returns the asset sent (previewRedeem); an in-kind exit also sends
    /// USDG, which redeemInKind returns and bounds explicitly.
    function redeem(uint256 shares, address receiver, address owner) public override nonReentrant returns (uint256) {
        _syncVol();
        _requireLive();
        _requireCooledDown(owner);
        return super.redeem(shares, receiver, owner);
    }

    /// @notice Redeems `shares` and returns both parts of the exit, `tokens` of the asset and
    /// `cash` raw USDG units, reverting unless each meets its minimum (slippage on both legs).
    function redeemInKind(uint256 shares, address receiver, address owner, uint256 minTokens, uint256 minCash)
        external
        nonReentrant
        returns (uint256 tokens, uint256 cash)
    {
        _syncVol();
        _requireLive();
        _requireCooledDown(owner);
        uint256 maxShares = maxRedeem(owner);
        if (shares > maxShares) revert ERC4626ExceededMaxRedeem(owner, shares, maxShares);
        (tokens, cash) = _split(_convertToAssets(shares, Math.Rounding.Floor));
        if (tokens < minTokens || cash < minCash) revert BelowMinOut(tokens, cash);
        _withdraw(_msgSender(), receiver, owner, tokens, shares);
    }

    // ================================================================ trading

    /// @notice The caller (owner or agent of `takerId`) buys `qty` contracts; the vault sells them.
    /// The strategy's cover rule is common to both vaults: everything locked after the sale (tokens
    /// behind calls, strike notional behind puts) plus what the redemption queue is owed must fit
    /// in the backing.
    function buy(uint32 seriesId, uint256 qty, uint256 maxPremium, uint256 takerId)
        external
        nonReentrant
        returns (uint256 premium)
    {
        _syncVol();
        (Series memory s, uint256 spot, Session sess) = _liveSeries(seriesId);
        VaultConfig storage c = _cfg;
        if (qty == 0 || qty > c.maxTradeQty) revert BadQty();
        if (s.expiry > block.timestamp + uint256(c.maxTenorDays) * 1 days) revert TenorTooLong();
        _checkStrategy(s, spot);
        GlobalParams memory g = params.globals();
        _checkOfferBand(s, spot, g.rate);
        Book memory b = _book(seriesId);
        if (b.short == 0) {
            if (b.open >= c.maxOpenSeries) revert TooManySeries();
            if (qty < c.minNewSeriesQty) revert BelowMinNewSeries();
        }
        _checkDust(b.short, qty, true, g.minTradeQty);
        uint256 lockedAfter = b.lockedWad + _lockedFor(seriesId, qty);
        uint256 required = lockedAfter + b.queued * _assetScale;
        if (required > b.backingWad) revert ExceedsCapacity(required, b.backingWad);
        premium = _premium(s, spot, sess, qty, true, lockedAfter, b, g.rate);
        if (premium > maxPremium) revert PremiumAboveMax(premium, maxPremium);

        _trade(seriesId, int256(qty), premium, takerId);
        emit Bought(msg.sender, takerId, seriesId, qty, premium);
    }

    /// @notice The caller sells `qty` contracts back to the vault at the bid, at most the vault's
    /// current short in the series (the vault never goes long) and never leaving it a dust
    /// position. Not while the account owes a deficit.
    function sellBack(uint32 seriesId, uint256 qty, uint256 minPremium, uint256 takerId)
        external
        nonReentrant
        returns (uint256 premium)
    {
        _syncVol();
        (Series memory s, uint256 spot, Session sess) = _liveSeries(seriesId);
        if (qty == 0) revert BadQty();
        (uint256 deficit,,) = ch.deficitOf(vaultId, 0);
        if (deficit != 0) revert VaultInDeficit();
        Book memory b = _book(seriesId);
        if (qty > b.short) revert ExceedsShort(qty, b.short);
        GlobalParams memory g = params.globals();
        _checkDust(b.short, qty, false, g.minTradeQty);
        premium = _premium(s, spot, sess, qty, false, b.lockedWad - _lockedFor(seriesId, qty), b, g.rate);
        if (premium < minPremium) revert PremiumBelowMin(premium, minPremium);

        _trade(seriesId, -int256(qty), premium, takerId);
        emit SoldBack(msg.sender, takerId, seriesId, qty, premium);
    }

    // ================================================================ async redemption

    /// @notice Moves `shares` into escrow for the current epoch; `receiver` claims their assets
    /// after the roll that pays the epoch. Nothing is priced here, so it reads no price and doesn't
    /// sync the vol: it works while halted and while the feed has rounds the vol can't fold in (a
    /// bad round, a phase change), so a holder can always queue an exit. From then on the queue's
    /// claim is reserved: instant withdrawals and new sales can't use it.
    function requestRedeem(uint256 shares, address receiver) external nonReentrant returns (uint256 requestId) {
        if (shares == 0) revert ZeroShares();
        if (receiver == address(0)) revert ZeroAddress();
        if (receiver == address(this)) revert BadReceiver();
        _requireCooledDown(msg.sender);
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

    /// @notice Pushes the asset `receiver` can claim to `receiver`. Callable by anyone. The USDG
    /// part of an in-kind exit is claimed on its own (claimRedeemedCash), so a token that can't
    /// reach the receiver (paused, blocklisted) never holds up the other.
    function claimRedeemed(address receiver) external nonReentrant returns (uint256 assets) {
        _fold(receiver, _pending[receiver]);
        assets = _redeemable[receiver];
        if (assets == 0) revert NothingToClaim();
        _redeemable[receiver] = 0;
        reservedAssets -= assets;
        emit RedeemClaimed(receiver, assets);
        IERC20(asset()).safeTransfer(receiver, assets);
    }

    /// @notice Pushes the USDG part `receiver` can claim (raw units) to `receiver`. Callable by
    /// anyone.
    function claimRedeemedCash(address receiver) external nonReentrant returns (uint256 cash) {
        _fold(receiver, _pending[receiver]);
        cash = _redeemableCash[receiver];
        if (cash == 0) revert NothingToClaim();
        _redeemableCash[receiver] = 0;
        reservedCash -= cash;
        emit CashLegPaid(receiver, cash);
        IERC20(_usdg).safeTransfer(receiver, cash);
    }

    /// @notice Permissionless. For each expiry in `expiries`: settles the vault's positions once
    /// the registry has the settlement price, and collects any claim. If the account owes a
    /// deficit, its cash (premiums, or USDG anyone paid in) repays it (ch.repayDeficit; a failure
    /// there doesn't stop the roll). Then, if the vault owes nothing, has no claim outstanding on
    /// those expiries, is live and its unlocked assets cover the payout, pays the current epoch at
    /// the current NAV: the escrowed shares burn and their assets move from the account into this
    /// contract for the receivers to claim.
    /// Positions still open on other expiries don't hold the epoch back: the payout is priced and
    /// capped exactly like an instant withdrawal (live MTM NAV, unlocked assets only). Waiting for
    /// a flat book would let one dust-sized sale at the longest tenor block every queued
    /// redemption for weeks, and a vault selling overlapping expiries would never pay at all.
    function roll(uint64[] calldata expiries) external nonReentrant {
        // best effort: a sync failure mustn't block settlement; the payout below then waits
        try hub.syncVol(underlying) {} catch {}
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
        if (_inDeficit()) {
            try ch.repayDeficit(id) {} catch {}
        }
        _processEpoch(expiries);
    }

    // ================================================================ ERC-4626 / ERC-20 internals

    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    /// @dev Stamps every receipt of shares (mint or transfer) for the exit cooldown. The stamp is
    /// the balance-weighted time of receipt: a fresh holder gets now, while a dust transfer or a
    /// tiny deposit made for someone else barely moves an existing holder's clock, so nobody can
    /// keep another holder's shares locked. The escrow (this contract) isn't stamped.
    function _update(address from, address to, uint256 value) internal override {
        if (to != address(0) && to != address(this) && value != 0) {
            uint256 bal = balanceOf(to);
            lastReceive[to] =
                bal == 0 ? block.timestamp : (bal * lastReceive[to] + value * block.timestamp) / (bal + value);
        }
        super._update(from, to, value);
    }

    /// @dev Pulls the asset (OZ), then books it into the vault's clearinghouse account.
    function _transferIn(address from, uint256 assets) internal override {
        super._transferIn(from, assets);
        if (assets != 0) ch.deposit(vaultId, asset(), assets);
    }

    /// @dev `assets` is the asset part (previewRedeem of `shares`, or what withdraw asked for, at
    /// most that); the USDG part of the burned shares' value goes along (_split). Only free assets
    /// leave instantly, the rest waits for a roll.
    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal
        override
    {
        (, uint256 cash) = _split(_convertToAssets(shares, Math.Rounding.Floor));
        uint256 free = freeAssets();
        if (assets > free) revert ExceedsFreeAssets(assets, free);
        super._withdraw(caller, receiver, owner, assets, shares);
        if (cash != 0) {
            emit CashLegPaid(receiver, cash);
            ch.withdraw(vaultId, _usdg, cash, receiver);
        }
    }

    /// @dev Straight from the clearinghouse account to the receiver.
    function _transferOut(address to, uint256 assets) internal override {
        if (assets != 0) ch.withdraw(vaultId, asset(), assets, to);
    }

    // ================================================================ internals

    function _requireLive() internal view {
        if (!isLive()) revert VaultNotLive();
    }

    function _requireCooledDown(address owner) private view {
        uint256 until = lastReceive[owner] + EXIT_COOLDOWN;
        if (block.timestamp < until) revert ExitCooldown(owner, until);
    }

    function _inDeficit() private view returns (bool) {
        (uint256 deficit,,) = ch.deficitOf(vaultId, 0);
        return deficit != 0;
    }

    function _canEnter() private view returns (bool) {
        if (!isLive() || _inDeficit()) return false;
        return totalSupply() == 0 || totalAssets() != 0;
    }

    function _canExit(address owner) private view returns (bool) {
        if (!isLive() || _inDeficit() || _holdsExpired()) return false;
        if (block.timestamp < lastReceive[owner] + EXIT_COOLDOWN) return false;
        return totalAssets() != 0;
    }

    /// @dev Spot and session of the underlying; ok only if the hub reports it tradeable and its
    /// mark vol is fresh. Never reverts.
    function _liveSpot() private view returns (uint256 spot, Session sess, bool ok) {
        try hub.spot(underlying) returns (uint256 p, Session ss, bool o) {
            (spot, sess, ok) = (p, ss, o);
        } catch {}
        if (!ok) return (spot, sess, false);
        UnderlyingParams memory up = params.underlying(underlying);
        (,, uint80 lastId,,, uint64 lastPokeTs) = hub.volState(underlying);
        ok = uint256(lastPokeTs) + up.volStaleness >= block.timestamp && _latestRound(up.feed) == lastId;
    }

    /// @dev Folds every pending feed round into the hub's vol (permissionless), then requires the
    /// vol state to be at the feed's latest round: the mark vol this operation prices and marks at
    /// can't move again within the transaction (a later poke has nothing left to fold in).
    function _syncVol() private {
        hub.syncVol(underlying);
        (,, uint80 lastId,,,) = hub.volState(underlying);
        if (_latestRound(params.underlying(underlying).feed) != lastId) revert VolNotCurrent();
    }

    function _latestRound(address feed) private view returns (uint80 id) {
        try IAggregatorV3(feed).latestRoundData() returns (uint80 r, int256, uint256, uint256, uint80) {
            id = r;
        } catch {}
    }

    /// @dev The vault only sells options whose |delta| at the mark vol lies in the offer band: no
    /// near-worthless lottery tickets that cost a taker nothing and pin a series slot, and no
    /// near-the-money risk beyond the strategy's intent.
    function _checkOfferBand(Series memory s, uint256 spot, int256 rate) private view {
        uint256 a =
            VaultPricing.absDelta(spot, s.strike, s.expiry - block.timestamp, hub.markVol(underlying), rate, s.isCall);
        VaultConfig storage c = _cfg;
        if (a < c.minDelta || a > c.maxDelta) revert OutsideOfferBand(a);
    }

    /// @dev The series on the vault's underlying, not expired, with a live spot.
    function _liveSeries(uint32 seriesId) private view returns (Series memory s, uint256 spot, Session sess) {
        bool ok;
        (spot, sess, ok) = _liveSpot();
        if (!ok) revert VaultNotLive();
        s = registry.series(seriesId);
        if (s.underlying != underlying) revert WrongUnderlying();
        if (block.timestamp >= s.expiry) revert SeriesExpired();
    }

    /// @dev The vault's position in a series after the trade must be flat or at least
    /// minTradeQty (the clearinghouse refuses dust positions too; this makes the quote say so).
    function _checkDust(uint256 short, uint256 qty, bool vaultSells, uint256 minQty) private view {
        uint256 after_ = vaultSells ? short + qty : short - qty;
        if (after_ != 0 && after_ < minQty) revert DustPosition(vaultId, -int256(after_));
    }

    /// @dev Single-option pricing runs in Solidity, in the linked VaultPricing library (see there);
    /// the kernel pays off on portfolio margin, not on one price.
    function _premium(
        Series memory s,
        uint256 spot,
        Session sess,
        uint256 qty,
        bool takerBuys,
        uint256 lockedAfterWad,
        Book memory b,
        int256 rate
    ) private view returns (uint256) {
        VaultConfig storage c = _cfg;
        uint256 utilTerm;
        {
            uint256 locked = Math.ceilDiv(lockedAfterWad, _assetScale);
            uint256 total = locked + _sub(_free(lockedAfterWad, b.backingWad), b.queued);
            uint256 util = total == 0 ? 0 : locked * WAD / total;
            utilTerm = _mulWad(c.utilSlope, util);
        }
        uint256 px = VaultPricing.unitPrice(
            spot,
            s.strike,
            s.expiry - block.timestamp,
            hub.markVol(underlying),
            c.skewSlope,
            utilTerm,
            c.sessionVolAdd[uint8(sess)],
            rate,
            s.isCall,
            takerBuys
        );
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

    /// @dev One pass over the vault's positions (its short in `seriesId`, 0 = none since series
    /// ids start at 1), its backing, and the redemption queue's claim at the current NAV.
    function _book(uint32 seriesId) private view returns (Book memory b) {
        Position[] memory ps = ch.positionsOf(vaultId);
        for (uint256 i = 0; i < ps.length; ++i) {
            int256 q = ps[i].qty;
            if (q >= 0) continue;
            uint256 a = uint256(-q);
            b.lockedWad += _lockedFor(ps[i].seriesId, a);
            ++b.open;
            if (ps[i].seriesId == seriesId) b.short = a;
        }
        b.backingWad = _backingWad();
        uint256 escrowed = escrowedShares;
        if (escrowed != 0) b.queued = _convertToAssets(escrowed, Math.Rounding.Ceil);
    }

    function _free(uint256 lockedWad, uint256 backingWad) private view returns (uint256) {
        return backingWad > lockedWad ? (backingWad - lockedWad) / _assetScale : 0;
    }

    /// @dev The account still carries a position whose series has expired: its payoff isn't in
    /// the expiry pool yet. Exits wait for settleAccount (roll does it), so an exit can't take
    /// cash that an in-the-money short owes its buyers and leave the stayers a bigger deficit.
    function _holdsExpired() private view returns (bool) {
        (uint256 live,) = ch.positionStatus(vaultId);
        return live != ch.positionsOf(vaultId).length;
    }

    function _holdsExpiry(uint64 e) private view returns (bool) {
        Position[] memory ps = ch.positionsOf(vaultId);
        for (uint256 i = 0; i < ps.length; ++i) {
            if (registry.series(ps[i].seriesId).expiry == e) return true;
        }
        return false;
    }

    /// @dev Pays the current epoch if the vault can: no deficit, no claim outstanding on
    /// `expiries`, live, and the payout within the unlocked assets (the queue's own reservation is
    /// what is being paid). Otherwise the epoch stays open.
    function _processEpoch(uint64[] calldata expiries) private {
        uint256 shares = escrowedShares;
        if (shares == 0) return;
        uint256 id = vaultId;
        if (_inDeficit() || _holdsExpired()) return;
        for (uint256 i = 0; i < expiries.length; ++i) {
            if (ch.claimable(id, expiries[i]) != 0) return;
        }
        if (!isLive()) return;
        uint256 assets = _convertToAssets(shares, Math.Rounding.Floor);
        if (assets == 0) return;
        (uint256 tokens, uint256 cash) = _split(assets);
        Book memory b = _book(0);
        if (tokens > _free(b.lockedWad, b.backingWad)) return;

        uint256 ep = epoch;
        _epochs[ep] = EpochResult({shares: shares, assets: tokens, cash: cash});
        escrowedShares = 0;
        epoch = ep + 1;
        reservedAssets += tokens;
        reservedCash += cash;
        _burn(address(this), shares);
        emit Rolled(ep, tokens);
        if (tokens != 0) ch.withdraw(id, asset(), tokens, address(this));
        if (cash != 0) ch.withdraw(id, _usdg, cash, address(this));
    }

    /// @dev Folds a rolled epoch's payout into the receiver's claimable balance.
    function _fold(address receiver, PendingRedeem storage p) private {
        uint256 sh = p.shares;
        if (sh == 0 || p.epoch >= epoch) return;
        EpochResult storage r = _epochs[p.epoch];
        _redeemable[receiver] += Math.mulDiv(sh, r.assets, r.shares);
        _redeemableCash[receiver] += Math.mulDiv(sh, r.cash, r.shares);
        p.shares = 0;
    }

    function _tolerate(bytes memory err) private pure {
        bytes4 sel = err.length >= 4 ? bytes4(err) : bytes4(0);
        if (sel == NOT_IMPLEMENTED || sel == NOTHING_TO_SETTLE || sel == POOL_NOT_READY) return;
        assembly ("memory-safe") {
            revert(add(err, 0x20), mload(err))
        }
    }

    function _sub(uint256 a, uint256 b) private pure returns (uint256) {
        return a > b ? a - b : 0;
    }

    function _mulWad(uint256 a, uint256 b) internal pure returns (uint256) {
        return a * b / WAD;
    }
}
