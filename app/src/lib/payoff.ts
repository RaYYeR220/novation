import { bsPrice, intrinsic } from './kernel';

/** One leg of a book on a single underlying. `cost` is per contract: today's mark for a held position, the fill for the ticket. */
export interface PayoffLeg {
  strike: number;
  isCall: boolean;
  expiry: number;
  qty: number;
  cost: number;
}

export interface PayoffBook {
  legs: PayoffLeg[];
  /** Stock tokens held as collateral, marked against `spot`. */
  tokenQty: number;
  spot: number;
  /** Mark vol, for legs that outlive the horizon. */
  vol: number;
  /** Fixed cash cost, e.g. the ticket's fee. */
  fee?: number;
}

/** A leg's value at `horizon` if the underlying prints `price`: intrinsic once expired, Black-Scholes before. */
export function legValue(leg: PayoffLeg, price: number, horizon: number, vol: number): number {
  return horizon >= leg.expiry
    ? intrinsic(price, leg.strike, leg.isCall)
    : bsPrice(price, leg.strike, leg.expiry - horizon, vol, leg.isCall);
}

/** P&L at `horizon` against today's marks (the kernel's convention: re-priced value minus mark). */
export function payoffAt(book: PayoffBook, price: number, horizon: number): number {
  let pnl = book.tokenQty * (price - book.spot) - (book.fee ?? 0);
  for (const leg of book.legs) pnl += leg.qty * (legValue(leg, price, horizon, book.vol) - leg.cost);
  return pnl;
}

/** `n` evenly spaced prices across spot·(1 ± span), plus every strike inside so the kinks are exact. */
export function priceAxis(spot: number, span: number, n: number, strikes: readonly number[] = []): number[] {
  const lo = spot * (1 - span);
  const hi = spot * (1 + span);
  const xs = Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
  for (const k of strikes) if (k > lo && k < hi) xs.push(k);
  return [...new Set(xs)].sort((a, b) => a - b);
}

/** Prices where the curve crosses zero, by linear interpolation between samples. */
export function breakevens(xs: readonly number[], ys: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < xs.length; i++) {
    const y0 = ys[i - 1] as number;
    const y1 = ys[i] as number;
    const x0 = xs[i - 1] as number;
    const x1 = xs[i] as number;
    if (y0 === 0 && (i === 1 || (ys[i - 2] as number) !== 0)) out.push(x0);
    else if ((y0 < 0 && y1 > 0) || (y0 > 0 && y1 < 0)) out.push(x0 + ((x1 - x0) * -y0) / (y1 - y0));
  }
  if (ys.length > 0 && ys[ys.length - 1] === 0 && (ys[ys.length - 2] ?? 1) !== 0) out.push(xs[xs.length - 1] as number);
  return out;
}
