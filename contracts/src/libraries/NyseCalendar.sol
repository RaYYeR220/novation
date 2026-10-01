// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Session} from "../types/Types.sol";

/// NYSE trading calendar: sessions, DST, holidays, early closes, weekly option expiry.
/// Civil-date math follows Howard Hinnant's days_from_civil / civil_from_days
/// (https://howardhinnant.github.io/date_algorithms.html). All Solidity integer
/// division truncates toward zero, matching the C++ these formulas were written for.
library NyseCalendar {
    error NoWeeklyExpiryFound();

    uint256 private constant SEC_OPEN = 34200; // 09:30 ET
    uint256 private constant SEC_EARLY_CLOSE = 46800; // 13:00 ET
    uint256 private constant SEC_REGULAR_CLOSE = 57600; // 16:00 ET
    uint256 private constant SEC_EXTENDED_END = 72000; // 20:00 ET

    // ---- holiday / early-close tables ----
    // Verified 2026-09-25 against the official NYSE Group press release covering
    // 2026-2028 (the primary hours-calendars page's own summarized table was
    // internally inconsistent on the Dec-2027/July early closes; this press
    // release resolved it unambiguously):
    // https://ir.theice.com/press/news-details/2025/NYSE-Group-Announces-2026-2027-and-2028-Holiday-and-Early-Closings-Calendar/default.aspx
    // Cross-checked against https://www.nyse.com/markets/hours-calendars.

    /// Full NYSE closures, yyyymmdd.
    function _isHoliday(uint32 d) private pure returns (bool) {
        uint32[20] memory hol = [
            uint32(20260101),
            20260119,
            20260216,
            20260403,
            20260525,
            20260619,
            20260703,
            20260907,
            20261126,
            20261225,
            20270101,
            20270118,
            20270215,
            20270326,
            20270531,
            20270618,
            20270705,
            20270906,
            20271125,
            20271224
        ];
        for (uint256 i = 0; i < hol.length; i++) {
            if (hol[i] == d) return true;
        }
        return false;
    }

    /// Early closes (13:00 ET), yyyymmdd.
    function _isEarlyClose(uint32 d) private pure returns (bool) {
        uint32[3] memory ec = [uint32(20261127), 20261224, 20271126];
        for (uint256 i = 0; i < ec.length; i++) {
            if (ec[i] == d) return true;
        }
        return false;
    }

    // ---- civil calendar (Howard Hinnant), day = days since 1970-01-01 ----

    function _daysFromCivil(int256 y, int256 m, int256 d) private pure returns (int256) {
        y -= m <= 2 ? int256(1) : int256(0);
        int256 era = (y >= 0 ? y : y - 399) / 400;
        int256 yoe = y - era * 400; // [0, 399]
        int256 doy = (153 * (m + (m > 2 ? int256(-3) : int256(9))) + 2) / 5 + d - 1; // [0, 365]
        int256 doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
        return era * 146097 + doe - 719468;
    }

    function _civilFromDays(int256 z) private pure returns (int256 y, uint256 m, uint256 d) {
        z += 719468;
        int256 era = (z >= 0 ? z : z - 146096) / 146097;
        int256 doe = z - era * 146097; // [0, 146096]
        int256 yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
        int256 yy = yoe + era * 400;
        int256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
        int256 mp = (5 * doy + 2) / 153; // [0, 11]
        int256 dd = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
        int256 mm = mp < 10 ? mp + 3 : mp - 9; // [1, 12]
        y = yy + (mm <= 2 ? int256(1) : int256(0));
        m = uint256(mm);
        d = uint256(dd);
    }

    /// weekday = ((day % 7) + 7 + 4) % 7; 1970-01-01 (day 0) was a Thursday.
    function _weekday(int256 day) private pure returns (uint256) {
        return uint256((day % 7) + 11) % 7;
    }

    // ---- public API ----

    /// US Eastern daylight time: second Sunday of March 07:00 UTC to first Sunday
    /// of November 06:00 UTC.
    function isDst(uint256 ts) internal pure returns (bool) {
        int256 day = int256(ts / 1 days);
        (int256 y,,) = _civilFromDays(day);

        int256 marchStart = _daysFromCivil(y, 3, 1);
        uint256 marchWd = _weekday(marchStart);
        int256 secondSundayMarch = marchStart + int256(marchWd == 0 ? 0 : 7 - marchWd) + 7;

        int256 novStart = _daysFromCivil(y, 11, 1);
        uint256 novWd = _weekday(novStart);
        int256 firstSundayNov = novStart + int256(novWd == 0 ? 0 : 7 - novWd);

        uint256 dstStart = uint256(secondSundayMarch) * 1 days + 7 hours;
        uint256 dstEnd = uint256(firstSundayNov) * 1 days + 6 hours;
        return ts >= dstStart && ts < dstEnd;
    }

    /// weekday: 0 = Sun ... 6 = Sat. day: ET days since 1970-01-01.
    function etParts(uint256 ts) internal pure returns (int256 day, uint256 secOfDay, uint256 weekday) {
        uint256 offset = isDst(ts) ? 4 hours : 5 hours;
        uint256 etTs = ts - offset;
        day = int256(etTs / 1 days);
        secOfDay = etTs % 1 days;
        weekday = _weekday(day);
    }

    function ymd(int256 day) internal pure returns (uint32) {
        (int256 y, uint256 m, uint256 d) = _civilFromDays(day);
        return uint32(uint256(y) * 10000 + m * 100 + d);
    }

    function isTradingDay(int256 day) internal pure returns (bool) {
        uint256 wd = _weekday(day);
        if (wd == 0 || wd == 6) return false;
        return !_isHoliday(ymd(day));
    }

    function closeSec(int256 day) internal pure returns (uint256) {
        return _isEarlyClose(ymd(day)) ? SEC_EARLY_CLOSE : SEC_REGULAR_CLOSE;
    }

    function closeTimestamp(int256 day) internal pure returns (uint256) {
        int256 base = day * int256(1 days) + int256(closeSec(day));
        uint256 cand = uint256(base + int256(4 hours));
        if (isDst(cand)) return cand;
        return uint256(base + int256(5 hours));
    }

    function baseSession(uint256 ts) internal pure returns (Session) {
        (int256 d, uint256 sec, uint256 wd) = etParts(ts);
        if (isTradingDay(d)) {
            uint256 close = closeSec(d);
            if (sec >= SEC_OPEN && sec < close) return Session.REGULAR;
            if (sec < SEC_OPEN) return Session.EXTENDED;
            if (sec < SEC_EXTENDED_END) return Session.EXTENDED; // close <= sec < 72000
            if (isTradingDay(d + 1)) return Session.EXTENDED;
            uint256 wdNext = _weekday(d + 1);
            return (wdNext == 0 || wdNext == 6) ? Session.WEEKEND : Session.HOLIDAY;
        }
        if (sec >= SEC_EXTENDED_END && isTradingDay(d + 1)) return Session.EXTENDED;
        return (wd == 0 || wd == 6) ? Session.WEEKEND : Session.HOLIDAY;
    }

    function isWeeklyExpiry(uint256 ts) internal pure returns (bool) {
        (int256 d, uint256 sec, uint256 wd) = etParts(ts);
        if (!isTradingDay(d)) return false;
        if (sec != closeSec(d)) return false;
        if (ts != closeTimestamp(d)) return false;
        int256 last = d + int256(5 - wd);
        for (int256 x = d + 1; x <= last; x++) {
            if (isTradingDay(x)) return false;
        }
        return true;
    }

    /// UTC timestamp of 20:00 ET on ET day `day`, where the 24/5 window opens or closes.
    function eveningTs(int256 day) internal pure returns (uint256) {
        int256 base = day * int256(1 days) + int256(SEC_EXTENDED_END);
        uint256 cand = uint256(base + int256(4 hours));
        if (isDst(cand)) return cand;
        return uint256(base + int256(5 hours));
    }

    /// Seconds of [from, to) inside the 24/5 window, i.e. where baseSession is REGULAR or EXTENDED,
    /// counted up to `cap` (the walk stops there). The window only opens or closes at 20:00 ET:
    /// from 20:00 ET on the day before ET day d until 20:00 ET on d, it is open iff d is a trading
    /// day. The walk visits one such day per step and stops once `cap` is reached, so it takes a
    /// handful of steps (a closed stretch is at most a long weekend) whatever the span.
    function tradableSeconds(uint256 from, uint256 to, uint256 cap) internal pure returns (uint256 acc) {
        if (to <= from) return 0;
        (int256 d,,) = etParts(from);
        if (from >= eveningTs(d)) ++d;
        while (from < to && acc < cap) {
            uint256 end = eveningTs(d);
            if (end > to) end = to;
            if (isTradingDay(d)) acc += end - from;
            from = end;
            ++d;
        }
        if (acc > cap) acc = cap;
    }

    /// Smallest t > ts with isWeeklyExpiry(t). Walks forward day by day, at most 14 days.
    function nextWeeklyExpiry(uint256 ts) internal pure returns (uint256) {
        (int256 d,,) = etParts(ts);
        for (uint256 i = 0; i < 14; i++) {
            int256 day = d + int256(i);
            if (!isTradingDay(day)) continue;
            uint256 ct = closeTimestamp(day);
            if (ct > ts && isWeeklyExpiry(ct)) return ct;
        }
        revert NoWeeklyExpiryFound();
    }
}
