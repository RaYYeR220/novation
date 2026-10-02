/**
 * Mirror of contracts/src/libraries/NyseCalendar.sol (and tools/ref/nyse.py): sessions, DST,
 * holidays, early closes and the weekly option expiry, the close of the last trading day of each
 * Monday-Friday week. Same tables and the same truncating integer maths, so callers label exactly
 * the expiries the SeriesRegistry accepts.
 */
import type { Session } from './types';

const DAY = 86400;
const SEC_OPEN = 34200; // 09:30 ET
const SEC_EARLY_CLOSE = 46800; // 13:00 ET
const SEC_REGULAR_CLOSE = 57600; // 16:00 ET
const SEC_EXTENDED_END = 72000; // 20:00 ET

/** Full NYSE closures, yyyymmdd (NYSE 2026-2028 holiday release). */
const HOLIDAYS = new Set([
  20260101, 20260119, 20260216, 20260403, 20260525, 20260619, 20260703, 20260907, 20261126, 20261225, 20270101,
  20270118, 20270215, 20270326, 20270531, 20270618, 20270705, 20270906, 20271125, 20271224,
]);
/** 13:00 ET early closes, yyyymmdd. */
const EARLY_CLOSES = new Set([20261127, 20261224, 20271126]);

const tdiv = (a: number, b: number) => Math.trunc(a / b);

function daysFromCivil(y0: number, m: number, d: number): number {
  const y = y0 - (m <= 2 ? 1 : 0);
  const era = tdiv(y >= 0 ? y : y - 399, 400);
  const yoe = y - era * 400;
  const doy = tdiv(153 * (m + (m > 2 ? -3 : 9)) + 2, 5) + d - 1;
  const doe = yoe * 365 + tdiv(yoe, 4) - tdiv(yoe, 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z0: number): [number, number, number] {
  const z = z0 + 719468;
  const era = tdiv(z >= 0 ? z : z - 146096, 146097);
  const doe = z - era * 146097;
  const yoe = tdiv(doe - tdiv(doe, 1460) + tdiv(doe, 36524) - tdiv(doe, 146096), 365);
  const doy = doe - (365 * yoe + tdiv(yoe, 4) - tdiv(yoe, 100));
  const mp = tdiv(5 * doy + 2, 153);
  const d = doy - tdiv(153 * mp + 2, 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
}

/** 0 = Sunday ... 6 = Saturday; day 0 (1970-01-01) was a Thursday. */
function weekday(day: number): number {
  return ((day % 7) + 11) % 7;
}

/** US Eastern daylight time: second Sunday of March 07:00 UTC to first Sunday of November 06:00 UTC. */
export function isDst(ts: number): boolean {
  const [y] = civilFromDays(Math.floor(ts / DAY));
  const march = daysFromCivil(y, 3, 1);
  let wd = weekday(march);
  const secondSundayMarch = march + (wd === 0 ? 0 : 7 - wd) + 7;
  const nov = daysFromCivil(y, 11, 1);
  wd = weekday(nov);
  const firstSundayNov = nov + (wd === 0 ? 0 : 7 - wd);
  return ts >= secondSundayMarch * DAY + 7 * 3600 && ts < firstSundayNov * DAY + 6 * 3600;
}

/** Eastern-time day number, seconds into that day, and weekday. */
export function etParts(ts: number): { day: number; sec: number; weekday: number } {
  const et = ts - (isDst(ts) ? 4 : 5) * 3600;
  const day = Math.floor(et / DAY);
  return { day, sec: et - day * DAY, weekday: weekday(day) };
}

export function ymd(day: number): number {
  const [y, m, d] = civilFromDays(day);
  return y * 10000 + m * 100 + d;
}

export function isTradingDay(day: number): boolean {
  const wd = weekday(day);
  return wd !== 0 && wd !== 6 && !HOLIDAYS.has(ymd(day));
}

export function closeSec(day: number): number {
  return EARLY_CLOSES.has(ymd(day)) ? SEC_EARLY_CLOSE : SEC_REGULAR_CLOSE;
}

export function closeTimestamp(day: number): number {
  const base = day * DAY + closeSec(day);
  const cand = base + 4 * 3600;
  return isDst(cand) ? cand : base + 5 * 3600;
}

/** The calendar session before any HALT override (MarketDataHub adds those). */
export function baseSession(ts: number): Exclude<Session, 'HALTED'> {
  const { day, sec, weekday: wd } = etParts(ts);
  if (isTradingDay(day)) {
    if (sec >= SEC_OPEN && sec < closeSec(day)) return 'REGULAR';
    if (sec < SEC_OPEN || sec < SEC_EXTENDED_END || isTradingDay(day + 1)) return 'EXTENDED';
    const next = weekday(day + 1);
    return next === 0 || next === 6 ? 'WEEKEND' : 'HOLIDAY';
  }
  if (sec >= SEC_EXTENDED_END && isTradingDay(day + 1)) return 'EXTENDED';
  return wd === 0 || wd === 6 ? 'WEEKEND' : 'HOLIDAY';
}

/** The close of the last trading day of its Monday-Friday week. */
export function isWeeklyExpiry(ts: number): boolean {
  const { day, sec, weekday: wd } = etParts(ts);
  if (!isTradingDay(day) || sec !== closeSec(day) || ts !== closeTimestamp(day)) return false;
  for (let x = day + 1; x <= day + (5 - wd); x++) if (isTradingDay(x)) return false;
  return true;
}

/** Smallest weekly expiry strictly after `ts`. */
export function nextWeeklyExpiry(ts: number): number {
  const { day } = etParts(ts);
  for (let i = 0; i < 14; i++) {
    const d = day + i;
    if (!isTradingDay(d)) continue;
    const ct = closeTimestamp(d);
    if (ct > ts && isWeeklyExpiry(ct)) return ct;
  }
  throw new RangeError('no weekly expiry within 14 days');
}

/** The next `n` weekly expiries after `ts`. */
export function weeklyExpiries(ts: number, n: number): number[] {
  const out: number[] = [];
  let t = ts;
  for (let i = 0; i < n; i++) {
    t = nextWeeklyExpiry(t);
    out.push(t);
  }
  return out;
}

const etFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

/** "Fri, Oct 2, 16:00 ET" (or 13:00 ET on an early close), from the calendar rather than the host clock. */
export function fmtCloseEt(ts: number): string {
  const { day, sec } = etParts(ts);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${etFmt.format(new Date(day * DAY * 1000))}, ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ET`;
}

/** "Fri, Sep 25, 16:04 ET": any instant in New York time, from the calendar's own DST rule. */
export function fmtEt(ts: number, opts: { weekday?: boolean; seconds?: boolean } = {}): string {
  const { day, sec } = etParts(ts);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const date = (opts.weekday === false ? etDateFmt : etFmt).format(new Date(day * DAY * 1000));
  const clock = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}${opts.seconds ? `:${String(s).padStart(2, '0')}` : ''}`;
  return `${date}, ${clock} ET`;
}

const etDateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
