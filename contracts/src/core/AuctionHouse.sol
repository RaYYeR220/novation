// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IAuctionHouse} from "../interfaces/IAuctionHouse.sol";
import {IClearinghouse, AccountState} from "../interfaces/IClearinghouse.sol";
import {IRiskParams, GlobalParams} from "../interfaces/IRiskParams.sol";
import {IMarketDataHub} from "../interfaces/IMarketDataHub.sol";
import {FixedPointMath as F} from "../libraries/FixedPointMath.sol";
import {Session, WAD} from "../types/Types.sol";

/// @notice Dutch auctions on the clearinghouse.
///
/// Liquidation. Anyone starts one on an account below maintenance margin. For auctionDuration
/// the discount ramps linearly from startDiscount to maxDiscount; after that the auction is over
/// and anyone may start a new one if the account is still liquidatable. A bid takes over a
/// fraction of the account's book (positions, collateral, cash). If the book is worth something,
/// the bidder pays for its share less the discount and the account pays a penalty to the
/// InsuranceFund; if not, the fund pays the bidder to take it. The bidder must meet initial margin
/// afterwards, and the account must not be left riskier (initial margin may not rise). The
/// auction ends once the account is healthy again or has no positions left. A bid moves its
/// fraction of at most the first 128 positions (storage order) so that it fits a block on a full
/// 256-position book; the difference to the fraction is settled at mark like any lot rounding.
///
/// Deficit sale. The clearinghouse starts one when settlement leaves an account owing an expiry
/// pool or the fund. Bidders buy the account's stock collateral at spot less the discount; the
/// clearinghouse applies the proceeds to the pool first, then to the fund.
///
/// No fire sales without live prices: every bid (and the start of a liquidation) needs a REGULAR
/// or EXTENDED session and a usable price for every underlying involved, so auctions pause over
/// weekends, holidays, halts and oracle outages, including a collateral-only token's. Nor on
/// a book the registry hasn't priced yet: a liquidation needs a live (unexpired) position and
/// waits while any expired series of the account awaits its settlement price.
///
/// Known limit: the discount clock is wall time. It keeps running while bids are paused (a closed
/// session, a halt), so an auction started shortly before a pause resumes at a higher discount
/// (up to maxDiscount for a deficit sale; a liquidation that ran out must be restarted, from
/// startDiscount).
contract AuctionHouse is IAuctionHouse, ReentrancyGuardTransient {
    using SafeCast for uint256;

    error ZeroAddress();
    error NotClearinghouse();
    error NotLiquidatable();
    error MarketClosed();
    error AuctionActive();
    error AuctionNotActive();
    error SaleNotActive();
    error NotBidder(uint256 bidderId, address caller);
    error SelfBid();
    error BidderInDeficit();
    error BidderUnhealthy();
    error BadFraction();
    error FractionTooLarge();
    error PayAboveMax(int256 paid, int256 maxPay);
    error ExceedsCollateral();
    error ExceedsDeficit();
    error BidRaisesRisk(uint256 imAfter, uint256 imBefore);

    /// @dev Settlement differences this small are rounding of the marks (a few wei per position),
    /// not lots: they are dropped so that an account without cash can still be taken over.
    int256 private constant RESIDUE_DUST = 1e6;

    event DeficitSaleEnded(uint256 indexed id, uint64 indexed expiry);

    IClearinghouse public immutable ch;
    IRiskParams public immutable params;
    IMarketDataHub public immutable hub;

    mapping(uint256 id => uint64) public liquidationStartedAt;
    mapping(uint256 id => mapping(uint64 expiry => uint64)) public saleStartedAt;

    constructor(IClearinghouse ch_, IRiskParams params_, IMarketDataHub hub_) {
        if (address(ch_) == address(0) || address(params_) == address(0) || address(hub_) == address(0)) {
            revert ZeroAddress();
        }
        ch = ch_;
        params = params_;
        hub = hub_;
    }

    // ================================================================ liquidation

    /// @notice Starts (or, once the previous one has run its course, restarts) the liquidation of
    /// an account that is below maintenance margin and has live positions.
    function startLiquidation(uint256 id) external nonReentrant {
        uint256 t0 = liquidationStartedAt[id];
        if (t0 != 0 && block.timestamp <= t0 + params.globals().auctionDuration) revert AuctionActive();
        _requireAccountTradable(id);
        _requireLiveBook(id);
        if (!ch.accountState(id).liquidatable) revert NotLiquidatable();
        liquidationStartedAt[id] = uint64(block.timestamp);
        emit LiquidationStarted(id, uint64(block.timestamp));
    }

    /// @notice Takes over `fractionWad` of the account's book into `bidderId` (the caller's).
    /// At most maxFractionPerBid per bid, unless equity <= dustEquity.
    /// @param maxPayWad the most the bidder will pay; a negative value means it wants to be paid at
    /// least that much
    /// @return paidWad what the bidder paid into the account; negative when the bidder was paid
    /// (by the InsuranceFund for an insolvent book, or by the account for a lot rounded its way)
    function bidLiquidation(uint256 id, uint256 fractionWad, uint256 bidderId, int256 maxPayWad)
        external
        nonReentrant
        returns (int256 paidWad)
    {
        _requireBidder(id, bidderId);
        if (fractionWad == 0 || fractionWad > WAD) revert BadFraction();
        GlobalParams memory g = params.globals();
        (uint256 d, bool active) = _liquidationDiscount(id, g);
        if (!active) revert AuctionNotActive();
        _requireAccountTradable(id);
        _requireLiveBook(id);
        AccountState memory st = ch.accountState(id);
        if (!st.liquidatable) revert NotLiquidatable();
        if (fractionWad > g.maxFractionPerBid && st.equity > uint256(g.dustEquity).toInt256()) {
            revert FractionTooLarge();
        }

        (int256 value, uint256 claims) = _transferableEquity(st, id);
        ch.transferFraction(id, bidderId, fractionWad);
        AccountState memory moved = ch.accountState(id);
        // a bid must not leave the account riskier (e.g. take its hedges whole and few liabilities)
        if (moved.im > st.im) revert BidRaisesRisk(moved.im, st.im);
        // Positions move in whole lots (no sub-minimum lots), so the bidder can get a little more or
        // less than its fraction. That difference is settled between the account and the bidder at
        // mark, on top of the price below, so the bidder's gain is the discount on its fraction
        // whatever the lots: no choice of fraction takes value without the matching liabilities,
        // and the InsuranceFund never pays for lots. If the account can't pay its side, the bid
        // reverts.
        int256 extra = (st.equity - moved.equity) - F.mulWad(fractionWad.toInt256(), value);
        if (extra <= RESIDUE_DUST && extra >= -RESIDUE_DUST) extra = 0;
        if (value > 0) {
            // the bidder pays for its share of the book, less the discount (rounded up)
            paidWad = F.mulWadUp(F.mulWadUp(fractionWad, uint256(value)), WAD - d).toInt256() + extra;
            if (paidWad > maxPayWad) revert PayAboveMax(paidWad, maxPayWad);
            _settle(id, bidderId, paidWad);
            ch.chargePenalty(id, _mulWad(g.liquidationPenalty, _mulWad(fractionWad, uint256(value))));
        } else {
            // the book is worth nothing or less: the fund pays the bidder to take its fraction, for
            // the part of the loss the account's own claims don't cover, plus the discount on
            // maintenance; the lot difference stays between the account and the bidder
            int256 net = value + claims.toInt256();
            uint256 shortfall = net < 0 ? uint256(-net) : 0;
            _settle(id, bidderId, extra);
            uint256 bonus = _mulWad(fractionWad, shortfall + _mulWad(d, st.mm));
            paidWad = extra - ch.insurancePay(bidderId, bonus).toInt256();
            if (paidWad > maxPayWad) revert PayAboveMax(paidWad, maxPayWad);
        }
        if (!ch.accountState(bidderId).healthy) revert BidderUnhealthy();

        emit LiquidationBid(id, bidderId, fractionWad, paidWad, d);
        // payments only changed the account's cash: equity moves with it, margin doesn't
        int256 equityNow = moved.equity - moved.cash.toInt256() + ch.cashOf(id).toInt256();
        if (equityNow >= moved.im.toInt256() || ch.positionsOf(id).length == 0) {
            delete liquidationStartedAt[id];
            emit LiquidationEnded(id);
        }
    }

    /// @return discountWad the current discount (0 if never started, maxDiscount once over)
    /// @return active whether bids are accepted (within auctionDuration of the start)
    function liquidationDiscount(uint256 id) external view returns (uint256 discountWad, bool active) {
        return _liquidationDiscount(id, params.globals());
    }

    // ================================================================ deficit sales

    /// @notice Clearinghouse only, when settlement leaves `id` owing for `expiry`. Only records the
    /// start: it runs inside the clearinghouse's settleAccount, and a failure here would stop the
    /// payer from settling (and freeze every claim on the expiry). So it reads nothing, calls
    /// nothing and can't fail for the clearinghouse: any account, any number of expiries, and a
    /// repeat call while the sale runs keeps the original start (the discount keeps ramping). No
    /// reentrancy guard for the same reason; it makes no external call.
    function startDeficitSale(uint256 id, uint64 expiry) external {
        if (msg.sender != address(ch)) revert NotClearinghouse();
        if (saleStartedAt[id][expiry] != 0) return;
        saleStartedAt[id][expiry] = uint64(block.timestamp);
        emit DeficitSaleStarted(id, expiry, uint64(block.timestamp));
    }

    /// @notice Buys `tokenWad` of the account's `token` collateral into `bidderId` (the caller's)
    /// at spot less the discount; the payment goes to the account's `expiry` deficit. A bid can't
    /// buy more than the remaining debt needs (net of the account's cash).
    /// @return paidWad what the bidder paid (rounded up)
    function bidDeficit(uint256 id, uint64 expiry, address token, uint256 tokenWad, uint256 bidderId, uint256 maxPayWad)
        external
        nonReentrant
        returns (uint256 paidWad)
    {
        _requireBidder(id, bidderId);
        (uint256 d, bool active) = _deficitDiscount(id, expiry, params.globals());
        if (!active) revert SaleNotActive();
        uint256 price = _mulWad(_requireTradable(token), WAD - d);
        paidWad = F.mulWadUp(tokenWad, price);
        if (paidWad > maxPayWad) revert PayAboveMax(paidWad.toInt256(), maxPayWad.toInt256());
        if (tokenWad > ch.collateralOf(id, token)) revert ExceedsCollateral();
        (, uint256 bridged, uint256 pending) = ch.deficitOf(id, expiry);
        uint256 owed = bridged + pending;
        uint256 cash = ch.cashOf(id);
        if (tokenWad > F.divWadUp(owed > cash ? owed - cash : 0, price)) revert ExceedsDeficit();

        ch.transferCash(bidderId, id, paidWad);
        ch.transferCollateral(id, bidderId, token, tokenWad);
        ch.applyDeficitProceeds(id, expiry);
        if (!ch.accountState(bidderId).healthy) revert BidderUnhealthy();

        emit DeficitBid(id, bidderId, token, tokenWad, paidWad);
        (, bridged, pending) = ch.deficitOf(id, expiry);
        if (bridged == 0 && pending == 0) {
            delete saleStartedAt[id][expiry];
            emit DeficitSaleEnded(id, expiry);
        }
    }

    /// @return discountWad the current discount (it stays at maxDiscount after auctionDuration)
    /// @return active whether the sale is running
    function deficitDiscount(uint256 id, uint64 expiry) external view returns (uint256 discountWad, bool active) {
        return _deficitDiscount(id, expiry, params.globals());
    }

    // ================================================================ internal

    /// @dev What a takeover can move: equity before the deficit (it stays with the account, and a
    /// payment into the account goes towards it) and without unpaid settlement claims (they stay
    /// with the account too). Returns that value and the claims.
    function _transferableEquity(AccountState memory st, uint256 id)
        internal
        view
        returns (int256 value, uint256 claims)
    {
        claims = ch.claimableTotalOf(id);
        value = st.equity + st.deficit.toInt256() - claims.toInt256();
    }

    /// @dev A positive amount goes from the bidder to the account, a negative one the other way.
    function _settle(uint256 id, uint256 bidderId, int256 amount) private {
        if (amount > 0) ch.transferCash(bidderId, id, uint256(amount));
        else if (amount < 0) ch.transferCash(id, bidderId, uint256(-amount));
    }

    /// @dev The caller owns `bidderId`, which isn't the auctioned account and owes no deficit.
    function _requireBidder(uint256 id, uint256 bidderId) private view {
        if (ch.ownerOf(bidderId) != msg.sender) revert NotBidder(bidderId, msg.sender);
        if (bidderId == id) revert SelfBid();
        (uint256 owed,,) = ch.deficitOf(bidderId, 0);
        if (owed != 0) revert BidderInDeficit();
    }

    /// @dev At least one unexpired position, and no expired series still waiting for the
    /// registry's settlement price.
    function _requireLiveBook(uint256 id) private view {
        (uint256 live, uint256 awaiting) = ch.positionStatus(id);
        if (live == 0 || awaiting != 0) revert NotLiquidatable();
    }

    function _requireAccountTradable(uint256 id) private view {
        address[] memory us = ch.underlyingsOf(id);
        for (uint256 i = 0; i < us.length; ++i) {
            _requireTradable(us[i]);
        }
    }

    /// @dev Spot of `u` if its session is REGULAR or EXTENDED and the hub's price is usable;
    /// anything else, including a reverting price, is MarketClosed.
    function _requireTradable(address u) private view returns (uint256) {
        try hub.spot(u) returns (uint256 price, Session s, bool ok) {
            if (ok && (s == Session.REGULAR || s == Session.EXTENDED)) return price;
        } catch {}
        revert MarketClosed();
    }

    function _liquidationDiscount(uint256 id, GlobalParams memory g)
        private
        view
        returns (uint256 discountWad, bool active)
    {
        uint256 t0 = liquidationStartedAt[id];
        if (t0 == 0) return (0, false);
        uint256 elapsed = block.timestamp - t0;
        return (_ramp(g, elapsed), elapsed <= g.auctionDuration);
    }

    function _deficitDiscount(uint256 id, uint64 expiry, GlobalParams memory g)
        private
        view
        returns (uint256 discountWad, bool active)
    {
        uint256 t0 = saleStartedAt[id][expiry];
        if (t0 == 0) return (0, false);
        return (_ramp(g, block.timestamp - t0), true);
    }

    /// @dev startDiscount + (maxDiscount - startDiscount) * min(elapsed, duration) / duration
    function _ramp(GlobalParams memory g, uint256 elapsed) private pure returns (uint256) {
        uint256 duration = g.auctionDuration;
        if (elapsed > duration) elapsed = duration;
        return g.startDiscount + (uint256(g.maxDiscount) - g.startDiscount) * elapsed / duration;
    }

    function _mulWad(uint256 a, uint256 b) private pure returns (uint256) {
        return a * b / WAD;
    }
}
