import type { AccountState } from './client/types';
import { meterState, niceCeil, type MeterState } from '@/components/ui/meter';

/** A figure before and after a ticket. */
export interface Figure {
  now: number;
  after: number;
  change: number;
}

export interface MarginDelta {
  equity: Figure;
  im: Figure;
  mm: Figure;
  /** Equity above initial margin: what is left for new trades. */
  free: Figure;
  /** IM as a share of equity. Infinity when equity is zero or less. */
  usage: { now: number; after: number };
  zone: { now: MeterState; after: MeterState };
  /** Whether the ticket moves the account into a worse or better margin zone. */
  shift: 'better' | 'same' | 'worse';
}

const figure = (now: number, after: number): Figure => ({ now, after, change: after - now });
const usage = (s: AccountState) => (s.equity > 0 ? s.im / s.equity : Infinity);
const RANK: Record<MeterState, number> = { clear: 0, restricted: 1, liquidatable: 2 };

export function marginDelta(now: AccountState, after: AccountState): MarginDelta {
  const zNow = meterState(now.equity, now.im, now.mm);
  const zAfter = meterState(after.equity, after.im, after.mm);
  return {
    equity: figure(now.equity, after.equity),
    im: figure(now.im, after.im),
    mm: figure(now.mm, after.mm),
    free: figure(now.equity - now.im, after.equity - after.im),
    usage: { now: usage(now), after: usage(after) },
    zone: { now: zNow, after: zAfter },
    shift: RANK[zAfter] > RANK[zNow] ? 'worse' : RANK[zAfter] < RANK[zNow] ? 'better' : 'same',
  };
}

/** One scale end for every lane, so now and after are read against the same ruler. */
export function sharedScale(...states: (AccountState | undefined)[]): number {
  const top = Math.max(0, ...states.flatMap((s) => (s ? [s.equity, s.im, s.mm] : [])));
  return niceCeil(top * 1.08);
}

/** Position of `v` on a 0..top ruler, in percent, clamped. */
export function toPct(v: number, top: number): number {
  if (!(top > 0)) return 0;
  return Math.min(100, Math.max(0, (v / top) * 100));
}

/** Cash moved by a ticket: a buy pays premium and fee; a sale receives premium and pays fee. */
export function cashDelta(premium: number, fee: number, qtyDelta: number): number {
  return (qtyDelta < 0 ? premium : -premium) - fee;
}

/** Premium per contract. */
export function perContract(premium: number, qtyDelta: number): number {
  return qtyDelta === 0 ? 0 : premium / Math.abs(qtyDelta);
}
