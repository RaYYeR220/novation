// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {Position} from "../types/Types.sol";

struct TradeParams {
    address takerActor; // who acts for takerId (msg.sender at the venue)
    address makerActor; // who acts for makerId (RFQ signer or the vault itself)
    uint256 takerId;
    uint256 makerId;
    uint32 seriesId;
    int256 qty;         // WAD, taker perspective: > 0 taker buys (goes long), < 0 taker sells
    uint256 premium;    // WAD USDG total: paid by taker if qty > 0, else paid by maker
}

struct AgentPolicy {
    uint128 maxWorstLoss;       // WAD USD cap on post-trade lossIM
    uint128 maxPremiumPerTrade; // WAD USD
    uint64 allowedMask;         // bit i => underlying with RiskParams index i allowed
    uint64 expiresAt;           // unix seconds
}

struct AccountState {
    uint256 cash;          // WAD USDG (index-scaled)
    int256 mtm;            // kernel mtm
    int256 settledValue;   // expired + settled positions not yet settleAccount-ed (rounded against the account) + unpaid claims at face
    uint256 deficit;       // WAD owed
    int256 equity;         // cash + mtm + settledValue - deficit
    uint256 im;            // kernel lossIM
    uint256 mm;            // ceil(im * mmRatio)
    uint256 worstScenario;
    bool healthy;          // equity >= im
    bool liquidatable;     // equity < mm
}

interface IClearinghouse {
    event SubaccountCreated(uint256 indexed id, address indexed owner);
    event Deposited(uint256 indexed id, address indexed token, uint256 amountWad);
    event Withdrawn(uint256 indexed id, address indexed token, uint256 amountWad, address to);
    event AgentGranted(uint256 indexed id, address indexed agent, AgentPolicy policy);
    event AgentRevoked(uint256 indexed id, address indexed agent);
    event Traded(uint256 indexed takerId, uint256 indexed makerId, uint32 indexed seriesId, int256 qty, uint256 premium, uint256 fee, address takerActor, address makerActor);
    event AccountSettled(uint256 indexed id, uint64 indexed expiry, int256 net, uint256 paidFromCash, uint256 bridged, uint256 unfunded);
    event Claimed(uint256 indexed id, uint64 indexed expiry, uint256 amount);
    event DeficitReduced(uint256 indexed id, uint64 indexed expiry, uint256 toPending, uint256 toInsurance);
    event LossSocialized(uint64 indexed expiry, uint256 amount, uint256 newIndex);

    // accounts
    function createSubaccount() external returns (uint256 id);
    function ownerOf(uint256 id) external view returns (address);
    function subaccountsOf(address owner) external view returns (uint256[] memory);
    function isAuthorized(uint256 id, address actor) external view returns (bool);
    // funds
    function deposit(uint256 id, address token, uint256 amount) external;
    function withdraw(uint256 id, address token, uint256 amount, address to) external;
    // agents
    function grantAgent(uint256 id, address agent, AgentPolicy calldata p) external;
    function revokeAgent(uint256 id, address agent) external;
    function agentPolicy(uint256 id, address agent) external view returns (AgentPolicy memory);
    // trading (venues only)
    function trade(TradeParams calldata t) external returns (uint256 fee);
    // settlement
    function settleAccount(uint256 id, uint64 expiry) external;
    function claim(uint256 id, uint64 expiry) external;
    function socializeRemainder(uint256 id, uint64 expiry) external;
    function repayDeficit(uint256 id) external;
    // auction-house hooks
    function transferFraction(uint256 fromId, uint256 toId, uint256 fractionWad) external;
    function transferCash(uint256 fromId, uint256 toId, uint256 amountWad) external;
    function transferCollateral(uint256 fromId, uint256 toId, address token, uint256 amountWad) external;
    function chargePenalty(uint256 id, uint256 amountWad) external;
    function insurancePay(uint256 toId, uint256 amountWad) external returns (uint256 paidWad);
    function applyDeficitProceeds(uint256 id, uint64 expiry) external;
    // views
    function accountState(uint256 id) external view returns (AccountState memory);
    function marginAfter(uint256 id, uint32 seriesId, int256 qtyDelta, int256 cashDelta) external view returns (AccountState memory);
    function scenarioGrid(uint256 id) external view returns (int256[] memory);
    function positionsOf(uint256 id) external view returns (Position[] memory);
    function cashOf(uint256 id) external view returns (uint256);
    function collateralOf(uint256 id, address token) external view returns (uint256);
    function pool(uint64 expiry) external view returns (uint256 poolWad, uint256 pendingWad, uint256 unsettledShortQty);
    function claimable(uint256 id, uint64 expiry) external view returns (uint256);
    function claimableTotalOf(uint256 id) external view returns (uint256);
    function underlyingsOf(uint256 id) external view returns (address[] memory); // collateral tokens + option underlyings
    function positionStatus(uint256 id) external view returns (uint256 live, uint256 awaiting); // unexpired; expired awaiting settlement
    function liquidationState(uint256 id) external view returns (AccountState memory st, uint256 live, uint256 awaiting); // accountState + positionStatus in one pass
    function accountStateChecked(uint256 id) external view returns (AccountState memory st, address volBehind); // accountState + an underlying whose vol isn't current
    function deficitOf(uint256 id, uint64 expiry) external view returns (uint256 total, uint256 bridged, uint256 pendingForExpiry);
    function socializedDebtOf(uint256 id) external view returns (uint256);
    function cashIndex() external view returns (uint256);
    function openInterest(uint32 seriesId) external view returns (uint256);
    function isVenue(address venue) external view returns (bool);
}
