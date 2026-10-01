"""Python mirror of contracts/src/libraries/NyseCalendar.sol.

Same tables, same Hinnant civil-date algorithms, same truncating integer division, so the app
fixtures list exactly the weekly expiries the SeriesRegistry accepts. Run this file to check it
against the vectors in contracts/test/calendar/NyseCalendar.t.sol.
"""

DAY = 86400
SEC_OPEN = 34200  # 09:30 ET
SEC_EARLY_CLOSE = 46800  # 13:00 ET
SEC_REGULAR_CLOSE = 57600  # 16:00 ET
SEC_EXTENDED_END = 72000  # 20:00 ET

# Full NYSE closures and 13:00 early closes, yyyymmdd (NYSE 2026-2028 holiday release).
HOLIDAYS = {
    20260101, 20260119, 20260216, 20260403, 20260525, 20260619, 20260703, 20260907, 20261126, 20261225,
    20270101, 20270118, 20270215, 20270326, 20270531, 20270618, 20270705, 20270906, 20271125, 20271224,
}
EARLY_CLOSES = {20261127, 20261224, 20271126}

REGULAR, EXTENDED, WEEKEND, HOLIDAY = "REGULAR", "EXTENDED", "WEEKEND", "HOLIDAY"


def _tdiv(a: int, b: int) -> int:
    """Solidity / C++ integer division: truncates toward zero."""
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b >= 0) else -q


def _days_from_civil(y: int, m: int, d: int) -> int:
    y -= 1 if m <= 2 else 0
    era = _tdiv(y if y >= 0 else y - 399, 400)
    yoe = y - era * 400
    doy = _tdiv(153 * (m + (-3 if m > 2 else 9)) + 2, 5) + d - 1
    doe = yoe * 365 + _tdiv(yoe, 4) - _tdiv(yoe, 100) + doy
    return era * 146097 + doe - 719468


def _civil_from_days(z: int):
    z += 719468
    era = _tdiv(z if z >= 0 else z - 146096, 146097)
    doe = z - era * 146097
    yoe = _tdiv(doe - _tdiv(doe, 1460) + _tdiv(doe, 36524) - _tdiv(doe, 146096), 365)
    yy = yoe + era * 400
    doy = doe - (365 * yoe + _tdiv(yoe, 4) - _tdiv(yoe, 100))
    mp = _tdiv(5 * doy + 2, 153)
    dd = doy - _tdiv(153 * mp + 2, 5) + 1
    mm = mp + 3 if mp < 10 else mp - 9
    return yy + (1 if mm <= 2 else 0), mm, dd


def _weekday(day: int) -> int:
    """0 = Sunday ... 6 = Saturday; day 0 (1970-01-01) was a Thursday."""
    r = day - _tdiv(day, 7) * 7  # Solidity %: sign follows the dividend
    return (r + 11) % 7


def is_dst(ts: int) -> bool:
    """US Eastern daylight time: second Sunday of March 07:00 UTC to first Sunday of November 06:00 UTC."""
    y, _, _ = _civil_from_days(ts // DAY)
    march = _days_from_civil(y, 3, 1)
    wd = _weekday(march)
    second_sunday_march = march + (0 if wd == 0 else 7 - wd) + 7
    nov = _days_from_civil(y, 11, 1)
    wd = _weekday(nov)
    first_sunday_nov = nov + (0 if wd == 0 else 7 - wd)
    return second_sunday_march * DAY + 7 * 3600 <= ts < first_sunday_nov * DAY + 6 * 3600


def et_parts(ts: int):
    et = ts - (4 * 3600 if is_dst(ts) else 5 * 3600)
    day = et // DAY
    return day, et % DAY, _weekday(day)


def ymd(day: int) -> int:
    y, m, d = _civil_from_days(day)
    return y * 10000 + m * 100 + d


def is_trading_day(day: int) -> bool:
    wd = _weekday(day)
    return wd not in (0, 6) and ymd(day) not in HOLIDAYS


def close_sec(day: int) -> int:
    return SEC_EARLY_CLOSE if ymd(day) in EARLY_CLOSES else SEC_REGULAR_CLOSE


def close_timestamp(day: int) -> int:
    base = day * DAY + close_sec(day)
    cand = base + 4 * 3600
    return cand if is_dst(cand) else base + 5 * 3600


def base_session(ts: int) -> str:
    d, sec, wd = et_parts(ts)
    if is_trading_day(d):
        if SEC_OPEN <= sec < close_sec(d):
            return REGULAR
        if sec < SEC_OPEN or sec < SEC_EXTENDED_END or is_trading_day(d + 1):
            return EXTENDED
        return WEEKEND if _weekday(d + 1) in (0, 6) else HOLIDAY
    if sec >= SEC_EXTENDED_END and is_trading_day(d + 1):
        return EXTENDED
    return WEEKEND if wd in (0, 6) else HOLIDAY


def is_weekly_expiry(ts: int) -> bool:
    """The close of the last trading day of its Monday-Friday week."""
    d, sec, wd = et_parts(ts)
    if not is_trading_day(d) or sec != close_sec(d) or ts != close_timestamp(d):
        return False
    return not any(is_trading_day(x) for x in range(d + 1, d + (5 - wd) + 1))


def next_weekly_expiry(ts: int) -> int:
    d, _, _ = et_parts(ts)
    for i in range(14):
        day = d + i
        if not is_trading_day(day):
            continue
        ct = close_timestamp(day)
        if ct > ts and is_weekly_expiry(ct):
            return ct
    raise ValueError("no weekly expiry within 14 days")


def weekly_expiries(ts: int, n: int):
    out = []
    for _ in range(n):
        ts = next_weekly_expiry(ts)
        out.append(ts)
    return out


def self_check():
    """The vectors from contracts/test/calendar/NyseCalendar.t.sol."""
    assert base_session(1790344800) == REGULAR
    assert base_session(1790434800) == WEEKEND
    assert base_session(1790555400) == EXTENDED
    assert is_weekly_expiry(1790366400)
    assert not is_weekly_expiry(1790366400 + 1)
    assert not is_weekly_expiry(1790366400 - DAY)
    assert is_weekly_expiry(1775160000)  # Good Friday 2026: Thursday close
    assert is_weekly_expiry(1795802400)  # Black Friday 2026: 13:00 early close
    assert not is_dst(1772953199) and is_dst(1772953200)
    assert is_dst(1793512799) and not is_dst(1793512800)
    assert next_weekly_expiry(1790344800) == 1790366400


if __name__ == "__main__":
    self_check()
    print("NyseCalendar mirror: all contract vectors pass")
    print(weekly_expiries(1790697600, 4))
