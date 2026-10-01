import type { Session } from './client/types';

const num = (d: number) => new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

export function fmtNumber(v: number, d = 2): string {
  return num(d).format(v).replace('-', '−');
}

export function fmtSigned(v: number, d = 2): string {
  if (v === 0) return num(d).format(0);
  return (v < 0 ? '−' : '+') + num(d).format(Math.abs(v));
}

export function fmtUsd(v: number, d = 2): string {
  return (v < 0 ? '−$' : '$') + num(d).format(Math.abs(v));
}

export function fmtPct(v: number, d = 1): string {
  return fmtNumber(v * 100, d) + '%';
}

export const SESSION_LABEL: Record<Session, string> = {
  REGULAR: 'Regular',
  EXTENDED: 'Extended',
  WEEKEND: 'Weekend',
  HOLIDAY: 'Holiday',
  HALTED: 'Halted',
};

const DAY = 86400;
const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const dateLongFmt = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

/** A fee to the cent; a positive fee under a cent reads "<0.01" rather than rounding to nothing. */
export function fmtFee(v: number): string {
  return v > 0 && v < 0.01 ? '<0.01' : fmtNumber(v);
}

/** Whole strikes print bare (200); fractional ones keep two decimals (202.50). */
export function fmtStrike(k: number): string {
  return Number.isInteger(k) ? fmtNumber(k, 0) : fmtNumber(k, 2);
}

/** "Oct 6", in UTC so server and browser agree. */
export function fmtExpiry(ts: number): string {
  return dateFmt.format(new Date(ts * 1000));
}

/** "Tue, Oct 6, 16:00 UTC". */
export function fmtExpiryLong(ts: number): string {
  return `${dateLongFmt.format(new Date(ts * 1000))} UTC`;
}

/** Days to expiry, rounded down: "6d"; "<1d" inside the last day; "expired" after it. */
export function fmtDays(expiry: number, asOf: number): string {
  const d = (expiry - asOf) / DAY;
  if (d <= 0) return 'expired';
  if (d < 1) return '<1d';
  return `${Math.floor(d)}d`;
}

/** "NVDA 200 call". */
export function fmtSeries(s: { underlying: string; strike: number; isCall: boolean }): string {
  return `${s.underlying} ${fmtStrike(s.strike)} ${s.isCall ? 'call' : 'put'}`;
}

/** "200C" for dense rows. */
export function fmtSeriesShort(s: { strike: number; isCall: boolean }): string {
  return `${fmtStrike(s.strike)}${s.isCall ? 'C' : 'P'}`;
}

/** A shock as a signed percent: "+11.5%", "−5.8%", "0%". */
export function fmtShock(f: number, d = 1): string {
  if (Math.abs(f) < 0.5 * 10 ** -(d + 2)) return '0%';
  return fmtSigned(f * 100, d) + '%';
}

/** "0x4a1c…9e2f". */
export function fmtAddress(a: string): string {
  return a.length <= 12 ? a : `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** "20 s", "14 min", "2 h 10 min", "37 h 52 min", "3 d 4 h". */
export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 72 * 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.floor(s / 86400);
  const h = Math.round((s % 86400) / 3600);
  return h ? `${d} d ${h} h` : `${d} d`;
}

/** "11 min ago", "2 h ago", "20 d ago"; "in 35 min" for the future. */
export function fmtAgo(ts: number, now: number): string {
  const d = now - ts;
  if (Math.abs(d) < 60) return 'just now';
  const t = fmtDuration(Math.abs(d)).replace(/ \d+ (min|h)$/, '');
  return d > 0 ? `${t} ago` : `in ${t}`;
}

/** A token amount: up to `d` decimals, trailing zeros trimmed ("40", "4.0595"). */
export function fmtQty(v: number, d = 4): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: d }).format(v).replace('-', '−');
}
