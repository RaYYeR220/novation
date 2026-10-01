// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IClearinghouse, TradeParams, AgentPolicy, AccountState} from "../interfaces/IClearinghouse.sol";
import {IRiskParams} from "../interfaces/IRiskParams.sol";
import {IMarketDataHub} from "../interfaces/IMarketDataHub.sol";
import {ISeriesRegistry} from "../interfaces/ISeriesRegistry.sol";
import {IRiskKernel} from "../interfaces/IRiskKernel.sol";
import {IInsuranceFund} from "../interfaces/IInsuranceFund.sol";
import {CHS, CHStorage, CHErrors, Account, Deps} from "./ClearinghouseStorage.sol";
import {MarginLogic} from "./logic/MarginLogic.sol";
import {TradeLogic} from "./logic/TradeLogic.sol";
import {AuctionHookLogic} from "./logic/AuctionHookLogic.sol";
import {Position, WAD} from "../types/Types.sol";

/// @notice Options clearinghouse: subaccounts, index-scaled USDG cash, stock-token collateral,
/// the positions ledger, portfolio-margin checks and agent policies. Immutable; all state lives
/// in one ERC-7201 struct (CHS) that the linked logic libraries operate on.
contract Clearinghouse is IClearinghouse, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    event VenueAdded(address indexed venue);
    event AuctionHouseBound(address indexed auctionHouse);
    event SetupFinalized();

    IRiskParams public immutable params;
    IMarketDataHub public immutable hub;
    ISeriesRegistry public immutable registry;
    IRiskKernel public immutable kernel;
    IInsuranceFund public immutable insurance;
    address public immutable setupAdmin;
    address public immutable usdg;
    uint256 private immutable _usdgScale; // 10 ** (18 - usdg decimals)

    constructor(
        IRiskParams params_,
        IMarketDataHub hub_,
        ISeriesRegistry registry_,
        IRiskKernel kernel_,
        IInsuranceFund insurance_,
        address setupAdmin_
    ) {
        if (
            address(params_) == address(0) || address(hub_) == address(0) || address(registry_) == address(0)
                || address(kernel_) == address(0) || address(insurance_) == address(0) || setupAdmin_ == address(0)
        ) revert CHErrors.ZeroAddress();
        params = params_;
        hub = hub_;
        registry = registry_;
        kernel = kernel_;
        insurance = insurance_;
        setupAdmin = setupAdmin_;
        address usdg_ = params_.usdg();
        usdg = usdg_;
        _usdgScale = _scaleOf(usdg_);

        CHStorage storage $ = CHS.s();
        $.nextId = 1;
        $.cashIndex = WAD;
    }

    // ================================================================ setup phase

    modifier onlySetup() {
        if (msg.sender != setupAdmin) revert CHErrors.NotSetupAdmin();
        if (CHS.s().setupFinalized) revert CHErrors.SetupAlreadyFinalized();
        _;
    }

    function addVenue(address venue) external nonReentrant onlySetup {
        if (venue == address(0)) revert CHErrors.ZeroAddress();
        CHS.s().venues[venue] = true;
        emit VenueAdded(venue);
    }

    function bindAuctionHouse(address auctionHouse_) external nonReentrant onlySetup {
        if (auctionHouse_ == address(0)) revert CHErrors.ZeroAddress();
        CHStorage storage $ = CHS.s();
        if ($.auctionHouse != address(0)) revert CHErrors.AlreadyBound();
        $.auctionHouse = auctionHouse_;
        emit AuctionHouseBound(auctionHouse_);
    }

    /// @notice Closes the setup phase for good: the venue list and the auction house are final.
    function finalizeSetup() external nonReentrant onlySetup {
        CHStorage storage $ = CHS.s();
        if ($.auctionHouse == address(0)) revert CHErrors.AuctionHouseNotBound();
        $.setupFinalized = true;
        emit SetupFinalized();
    }

    function setupFinalized() external view returns (bool) {
        return CHS.s().setupFinalized;
    }

    function auctionHouse() external view returns (address) {
        return CHS.s().auctionHouse;
    }

    // ================================================================ accounts

    function createSubaccount() external nonReentrant returns (uint256 id) {
        CHStorage storage $ = CHS.s();
        id = $.nextId++;
        $.accounts[id].owner = msg.sender;
        $.owned[msg.sender].push(id);
        emit SubaccountCreated(id, msg.sender);
    }

    function ownerOf(uint256 id) external view returns (address) {
        return CHS.s().accounts[id].owner;
    }

    function subaccountsOf(address owner) external view returns (uint256[] memory) {
        return CHS.s().owned[owner];
    }

    /// @notice The owner, or an agent whose policy has not expired. Never the zero address.
    function isAuthorized(uint256 id, address actor) external view returns (bool) {
        CHStorage storage $ = CHS.s();
        if (actor == address(0)) return false;
        return actor == $.accounts[id].owner || $.agents[id][actor].expiresAt > block.timestamp;
    }

    // ================================================================ funds

    /// @notice Anyone may fund any existing account. USDG becomes cash; an enabled underlying
    /// becomes collateral, but only while the hub can price it (hub.spot reverts NoPrice /
    /// ImplausiblePrice otherwise; a HALTED session is fine). The amount credited is what
    /// actually arrived (balance delta).
    function deposit(uint256 id, address token, uint256 amount) external nonReentrant {
        CHStorage storage $ = CHS.s();
        if ($.accounts[id].owner == address(0)) revert CHErrors.UnknownAccount(id);
        if (amount == 0) revert CHErrors.ZeroAmount();
        bool isCash = token == usdg;
        if (!isCash) {
            if (!params.underlying(token).enabled) revert CHErrors.TokenNotAllowed(token);
            hub.spot(token);
        }
        uint256 scale = isCash ? _usdgScale : _scaleOf(token);

        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 wad = (IERC20(token).balanceOf(address(this)) - before) * scale;
        if (wad == 0) revert CHErrors.ZeroAmount();

        if (isCash) CHS.credit(id, wad);
        else CHS.addCollateral(id, token, wad);
        emit Deposited(id, token, wad);
    }

    /// @notice Owner only; blocked while the account owes a deficit. An account with positions
    /// must still meet initial margin afterwards. Never blocked by a pause.
    function withdraw(uint256 id, address token, uint256 amount, address to) external nonReentrant {
        CHStorage storage $ = CHS.s();
        Account storage a = $.accounts[id];
        if (msg.sender != a.owner) revert CHErrors.NotOwner(id, msg.sender);
        if (a.deficitTotal != 0) revert CHErrors.InDeficit();
        if (amount == 0) revert CHErrors.ZeroAmount();
        if (to == address(0) || to == address(this)) revert CHErrors.InvalidRecipient();

        bool isCash = token == usdg;
        uint256 wad = amount * (isCash ? _usdgScale : _scaleOf(token));
        if (isCash) CHS.debit(id, wad);
        else CHS.removeCollateral(id, token, wad);

        if ($.positions[id].length != 0) {
            AccountState memory st = MarginLogic.accountState(_deps(), id);
            if (!st.healthy) revert CHErrors.InsufficientMargin(id, st.equity, st.im);
        }

        emit Withdrawn(id, token, wad, to);
        IERC20(token).safeTransfer(to, amount);
    }

    // ================================================================ agents

    function grantAgent(uint256 id, address agent, AgentPolicy calldata p) external nonReentrant {
        CHStorage storage $ = CHS.s();
        address owner = $.accounts[id].owner;
        if (msg.sender != owner) revert CHErrors.NotOwner(id, msg.sender);
        if (agent == address(0) || agent == owner) revert CHErrors.InvalidAgent();
        if (p.expiresAt <= block.timestamp) revert CHErrors.InvalidExpiry();
        $.agents[id][agent] = p;
        emit AgentGranted(id, agent, p);
    }

    function revokeAgent(uint256 id, address agent) external nonReentrant {
        CHStorage storage $ = CHS.s();
        if (msg.sender != $.accounts[id].owner) revert CHErrors.NotOwner(id, msg.sender);
        delete $.agents[id][agent];
        emit AgentRevoked(id, agent);
    }

    function agentPolicy(uint256 id, address agent) external view returns (AgentPolicy memory) {
        return CHS.s().agents[id][agent];
    }

    // ================================================================ trading, settlement, auction hooks

    modifier onlyVenue() {
        if (!CHS.s().venues[msg.sender]) revert CHErrors.NotVenue(msg.sender);
        _;
    }

    /// @notice Venue entry point. The venue vouches for the actors; the clearinghouse checks that
    /// each actor is the owner or a live agent of its side, then moves positions, premium and fee
    /// and checks margin and agent budgets afterwards (see TradeLogic).
    function trade(TradeParams calldata t) external nonReentrant onlyVenue returns (uint256 fee) {
        return TradeLogic.trade(_deps(), t);
    }

    function settleAccount(uint256, uint64) external pure {
        revert CHErrors.NotImplemented();
    }

    function claim(uint256, uint64) external pure {
        revert CHErrors.NotImplemented();
    }

    function socializeRemainder(uint256, uint64) external pure {
        revert CHErrors.NotImplemented();
    }

    modifier onlyAuctionHouse() {
        if (msg.sender != CHS.s().auctionHouse) revert CHErrors.NotAuctionHouse(msg.sender);
        _;
    }

    /// @notice Auction house only: moves `fractionWad` of `fromId`'s positions, collateral and cash
    /// to `toId` (see AuctionHookLogic). The auction house checks the receiver's margin.
    function transferFraction(uint256 fromId, uint256 toId, uint256 fractionWad)
        external
        nonReentrant
        onlyAuctionHouse
    {
        AuctionHookLogic.transferFraction(_deps(), fromId, toId, fractionWad);
    }

    /// @notice Auction house only: a bidder's payment between accounts.
    function transferCash(uint256 fromId, uint256 toId, uint256 amountWad) external nonReentrant onlyAuctionHouse {
        AuctionHookLogic.transferCash(fromId, toId, amountWad);
    }

    /// @notice Auction house only: collateral sold in a deficit sale.
    function transferCollateral(uint256 fromId, uint256 toId, address token, uint256 amountWad)
        external
        nonReentrant
        onlyAuctionHouse
    {
        AuctionHookLogic.transferCollateral(fromId, toId, token, amountWad);
    }

    /// @notice Auction house only: a liquidation penalty, up to the account's cash, to the
    /// InsuranceFund.
    function chargePenalty(uint256 id, uint256 amountWad) external nonReentrant onlyAuctionHouse {
        AuctionHookLogic.chargePenalty(_deps(), id, amountWad);
    }

    /// @notice Auction house only: pays a liquidation bonus from the InsuranceFund into `toId`.
    /// @return paidWad what the fund actually covered (and `toId` was credited)
    function insurancePay(uint256 toId, uint256 amountWad)
        external
        nonReentrant
        onlyAuctionHouse
        returns (uint256 paidWad)
    {
        return AuctionHookLogic.insurancePay(_deps(), toId, amountWad);
    }

    function applyDeficitProceeds(uint256, uint64) external pure {
        revert CHErrors.NotImplemented();
    }

    // ================================================================ views

    function accountState(uint256 id) external view returns (AccountState memory) {
        return MarginLogic.accountState(_deps(), id);
    }

    function marginAfter(uint256 id, uint32 seriesId, int256 qtyDelta, int256 cashDelta)
        external
        view
        returns (AccountState memory)
    {
        return MarginLogic.accountStateWith(_deps(), id, seriesId, qtyDelta, cashDelta);
    }

    function scenarioGrid(uint256 id) external view returns (int256[] memory) {
        return MarginLogic.scenarioGrid(_deps(), id);
    }

    function positionsOf(uint256 id) external view returns (Position[] memory) {
        return CHS.s().positions[id];
    }

    function cashOf(uint256 id) external view returns (uint256) {
        return CHS.cashOf(id);
    }

    function collateralOf(uint256 id, address token) external view returns (uint256) {
        return CHS.s().collateral[id][token];
    }

    function collateralTokensOf(uint256 id) external view returns (address[] memory) {
        return CHS.s().collateralTokens[id];
    }

    /// @notice Every underlying the account holds as collateral or has a position on, in
    /// RiskParams order.
    function underlyingsOf(uint256 id) external view returns (address[] memory) {
        return AuctionHookLogic.underlyingsOf(_deps(), id);
    }

    /// @return live positions whose series hasn't expired
    /// @return awaiting expired positions whose expiry the registry hasn't settled yet
    function positionStatus(uint256 id) external view returns (uint256 live, uint256 awaiting) {
        return AuctionHookLogic.positionStatus(_deps(), id);
    }

    function pool(uint64 expiry)
        external
        view
        returns (uint256 poolWad, uint256 pendingWad, uint256 unsettledShortQty)
    {
        CHStorage storage $ = CHS.s();
        return ($.pool[expiry], $.pending[expiry], $.unsettledShortQty[expiry]);
    }

    function claimable(uint256 id, uint64 expiry) external view returns (uint256) {
        return CHS.s().claimable[id][expiry];
    }

    /// @notice The account's unpaid claims over all expiries, at face. Counted in its equity.
    function claimableTotalOf(uint256 id) external view returns (uint256) {
        return CHS.s().claimableTotal[id];
    }

    /// @return total the account's deficit over all expiries
    /// @return bridged the part of the `expiry` deficit owed to the InsuranceFund
    /// @return pendingForExpiry the part of the `expiry` deficit owed to that expiry's pool
    function deficitOf(uint256 id, uint64 expiry)
        external
        view
        returns (uint256 total, uint256 bridged, uint256 pendingForExpiry)
    {
        CHStorage storage $ = CHS.s();
        return ($.accounts[id].deficitTotal, $.defBridged[id][expiry], $.defPending[id][expiry]);
    }

    function cashIndex() external view returns (uint256) {
        return CHS.s().cashIndex;
    }

    function openInterest(uint32 seriesId) external view returns (uint256) {
        return CHS.s().longOI[seriesId];
    }

    function isVenue(address venue) external view returns (bool) {
        return CHS.s().venues[venue];
    }

    // ================================================================ internal

    function _deps() internal view returns (Deps memory) {
        return Deps({
            params: params,
            hub: hub,
            registry: registry,
            kernel: kernel,
            insurance: insurance,
            auctionHouse: CHS.s().auctionHouse,
            usdg: usdg,
            usdgScale: _usdgScale
        });
    }

    function _scaleOf(address token) private view returns (uint256) {
        uint8 dec = IERC20Metadata(token).decimals();
        if (dec > 18) revert CHErrors.BadDecimals();
        return 10 ** (18 - dec);
    }
}
