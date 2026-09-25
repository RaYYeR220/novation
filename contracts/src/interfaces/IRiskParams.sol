// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

struct UnderlyingParams {
    bool enabled;
    uint8 index;              // assigned by addUnderlying (0..63); ignored on input
    address feed;             // Chainlink proxy; immutable after add
    uint128 strikeStep;       // WAD
    uint64 volFloor;          // WAD
    uint64 volCap;            // WAD
    uint64 lambda;            // WAD per-round EWMA decay
    uint64 shockK;            // WAD sigma multiple
    uint64 minShock;          // WAD
    uint64 horizonDays;       // plain integer days
    uint64 volUp;             // WAD
    uint64 volDown;            // WAD
    uint64 multExtended;      // WAD
    uint64 multWeekend;       // WAD
    uint64 multHoliday;       // WAD
    uint64 multHalted;        // WAD
    uint128 maxOpenInterest;  // WAD contracts per series
    uint32 maxStaleRegular;   // seconds
    uint32 maxStaleExtended;  // seconds
    uint32 maxStaleClosed;    // seconds
    uint32 volStaleness;      // seconds
    uint128 minPrice;         // WAD USD per raw token, plausibility band
    uint128 maxPrice;         // WAD USD per raw token, plausibility band
}

struct GlobalParams {
    uint64 mmRatio;               // WAD
    uint64 diversificationCredit; // WAD
    uint64 shortOptionMinPct;     // WAD
    uint64 feeRate;               // WAD fraction of notional (|qty| * spot)
    uint64 feeCapOfPremium;       // WAD fraction of premium
    uint64 insuranceShare;        // WAD fraction of fees to InsuranceFund (rest to treasury)
    uint64 startDiscount;         // WAD
    uint64 maxDiscount;           // WAD
    uint64 maxFractionPerBid;     // WAD
    uint64 liquidationPenalty;    // WAD fraction of transferred positive equity
    uint32 auctionDuration;       // seconds
    uint32 maxSettlementLag;      // seconds
    uint32 haltWindow;            // seconds
    uint32 maxWeeksOut;           // weeks
    uint64 maxStrikeDeviation;    // WAD
    int64 rate;                   // WAD annual
    uint128 minTradeQty;          // WAD contracts
    uint128 dustEquity;           // WAD USD
}

interface IRiskParams {
    event UnderlyingAdded(address indexed token, uint8 index);
    event UnderlyingUpdated(address indexed token);
    event GlobalsUpdated();
    event OpeningPaused(bool paused);

    function usdg() external view returns (address);
    function sequencerUptimeFeed() external view returns (address);
    function treasury() external view returns (address);
    function underlying(address token) external view returns (UnderlyingParams memory);
    function underlyingAt(uint8 index) external view returns (address);
    function underlyingCount() external view returns (uint256);
    function globals() external view returns (GlobalParams memory);
    function openingPaused() external view returns (bool);

    function addUnderlying(address token, UnderlyingParams calldata p) external; // timelock only
    function setUnderlying(address token, UnderlyingParams calldata p) external; // timelock only; feed + index unchanged
    function setGlobals(GlobalParams calldata g) external;                        // timelock only
    function pauseOpening() external;                                             // guardian or timelock
    function unpauseOpening() external;                                           // guardian or timelock
}
