// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

uint256 constant WAD = 1e18;
uint256 constant YEAR = 31_536_000;
uint256 constant MAX_POSITIONS = 256;
uint256 constant MAX_UNDERLYINGS = 8;
uint256 constant PRICE_POINTS = 13;
uint256 constant VOL_POINTS = 3;
uint256 constant SCENARIOS = 39;
uint256 constant BASE_SCENARIO = 19; // vol index 1 (base vol), price index 6 (no move)

enum Session { REGULAR, EXTENDED, WEEKEND, HOLIDAY, HALTED }

struct Series {
    address underlying; // stock token address (raw token = contract unit)
    uint64 expiry;      // unix seconds; NyseCalendar.isWeeklyExpiry(expiry) == true
    bool isCall;
    uint128 strike;     // WAD USD per raw token
}

struct Position {
    uint32 seriesId;    // ids start at 1
    int128 qty;         // WAD contracts; > 0 long, < 0 short
}

// ---- Kernel ABI: flat arrays of static tuples, every field 256-bit for ABI robustness ----
struct KParams {
    uint256 nowTs;
    int256 rate;                   // WAD annual
    uint256 diversificationCredit; // WAD fraction
    uint256 shortOptionMinPct;     // WAD fraction
}

struct KUnderlying {
    uint256 spot;       // WAD
    uint256 vol;        // WAD fraction
    uint256 shockRange; // WAD fraction, <= 0.9e18
    uint256 volUp;      // WAD fraction
    uint256 volDown;    // WAD fraction, < 1e18
    int256 tokenQty;    // WAD raw tokens held as collateral (>= 0)
}

struct KPosition {
    uint256 u;          // index into KUnderlying[]
    bool isCall;
    uint256 expiry;
    uint256 strike;     // WAD
    int256 qty;         // WAD
}

struct KMarginOut {
    int256 mtm;            // token value + option marks (WAD USD)
    uint256 lossIM;        // max(lossCorr, (1-credit)*lossIndep) + shortMin
    uint256 lossCorr;
    uint256 lossIndep;
    uint256 shortMin;
    uint256 worstScenario; // argmin of the correlated portfolio PnL (first on ties)
}
