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
