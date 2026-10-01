/**
 * A float twin of the risk kernel (KernelReference.sol / tools/ref/kernel_ref.py), same algorithm,
 * double precision instead of WAD integers. The demo client uses it for tickets the fixtures don't
 * carry and to re-price the after-trade grid; the chart uses Black-Scholes for later expiries.
 * It uses the kernel's CDF approximation, so results agree with the integer kernel to rounding
 * (about 1e-9 USDG per contract on the demo books). The chain stays the authority.
 */
import type { Session } from './client/types';
import { CELLS, PRICE_POINTS, VOL_POINTS } from './scenario';

export const YEAR = 31_536_000;

/** Risk defaults from the spec (§5.2) and the session multipliers (§5.1). */
export const RISK = {
  shockK: 3,
  horizonDays: 2,
  minShock: 0.1,
  maxShock: 0.9,
  volUp: 0.4,
  volDown: 0.3,
  diversificationCredit: 0.3,
  shortOptionMinPct: 0.01,
  mmRatio: 0.75,
  rate: 0,
} as const;

export const SESSION_MULT: Record<Session, number> = {
  REGULAR: 1,
  EXTENDED: 1.2,
  WEEKEND: 1.75,
  HOLIDAY: 1.75,
  HALTED: 2.5,
};

/** `max(minShock, shockK·σ·√(horizon/365)) × sessionMult`, capped at 0.9, as the Clearinghouse computes it. */
export function shockRange(vol: number, session: Session = 'REGULAR'): number {
  const base = Math.max(RISK.minShock, RISK.shockK * vol * Math.sqrt(RISK.horizonDays / 365));
  return Math.min(RISK.maxShock, base * SESSION_MULT[session]);
}

/**
 * Standard normal CDF, the kernel's own approximation: Abramowitz-Stegun 26.2.17 (absolute error
 * under 7.5e-8), clamped to 0 and 1 beyond ±8. Using the same formula keeps the twin within
 * rounding of the integer kernel instead of within the approximation's error.
 */
export function normCdf(x: number): number {
  if (x >= 8) return 1;
  if (x <= -8) return 0;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.2316419 * a);
  const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const tail = (Math.exp((-a * a) / 2) / Math.sqrt(2 * Math.PI)) * poly;
  return x >= 0 ? 1 - tail : tail;
}

export function intrinsic(spot: number, strike: number, isCall: boolean): number {
  return Math.max(0, isCall ? spot - strike : strike - spot);
}

/** European Black-Scholes price. `tau` in seconds; at or after expiry the option is worth its intrinsic value. */
export function bsPrice(spot: number, strike: number, tau: number, vol: number, isCall: boolean, rate: number = RISK.rate): number {
  if (tau <= 0) return intrinsic(spot, strike, isCall);
  const T = tau / YEAR;
  const kd = strike * Math.exp(-rate * T);
  const sst = vol * Math.sqrt(T);
  // The kernel treats σ√T under 1e-12 as zero vol: the discounted intrinsic value.
  if (sst < 1e-12) return Math.max(0, isCall ? spot - kd : kd - spot);
  const d1 = (Math.log(spot / strike) + (rate + (vol * vol) / 2) * T) / sst;
  const d2 = d1 - sst;
  const v = isCall ? spot * normCdf(d1) - kd * normCdf(d2) : kd * normCdf(-d2) - spot * normCdf(-d1);
  return Math.max(0, v);
}

export interface KUnderlying {
  spot: number;
  vol: number;
  shockRange: number;
  volUp: number;
  volDown: number;
  tokenQty: number;
}

export interface KPosition {
  /** Index into the underlyings array. */
  u: number;
  isCall: boolean;
  expiry: number;
  strike: number;
  qty: number;
}

export interface KParams {
  now: number;
  rate: number;
  diversificationCredit: number;
  shortOptionMinPct: number;
}

export interface KMargin {
  mtm: number;
  lossIM: number;
  lossCorr: number;
  lossIndep: number;
  shortMin: number;
  /** argmin of the correlated grid, first on ties. */
  worstScenario: number;
  /** Correlated portfolio PnL per scenario, index v * 13 + j. */
  grid: number[];
}

export const defaultParams = (now: number): KParams => ({
  now,
  rate: RISK.rate,
  diversificationCredit: RISK.diversificationCredit,
  shortOptionMinPct: RISK.shortOptionMinPct,
});

/** Mirrors KernelReference.margin: 13 price points × 3 vol points per underlying, aligned across underlyings. */
export function kernelMargin(p: KParams, us: readonly KUnderlying[], ps: readonly KPosition[]): KMargin {
  const nu = us.length;
  const pnl = Array.from({ length: nu }, () => new Array<number>(CELLS).fill(0));
  const sj: number[][] = [];
  const vols: number[][] = [];
  let mtm = 0;

  us.forEach((u, i) => {
    if (u.shockRange > RISK.maxShock || u.volDown >= 1) throw new RangeError('shock range out of bounds');
    const row: number[] = [];
    for (let j = 0; j < PRICE_POINTS; j++) row.push(u.spot * (1 + ((j - 6) * u.shockRange) / 6));
    sj.push(row);
    vols.push([u.vol * (1 - u.volDown), u.vol, u.vol * (1 + u.volUp)]);
    mtm += u.tokenQty * u.spot;
    const cells = pnl[i]!;
    for (let s = 0; s < CELLS; s++) cells[s]! += u.tokenQty * (row[s % PRICE_POINTS]! - u.spot);
  });

  let shortMin = 0;
  for (const pos of ps) {
    const u = us[pos.u];
    if (!u) throw new RangeError(`underlying index ${pos.u}`);
    const cells = pnl[pos.u]!;
    const prices = sj[pos.u]!;
    if (pos.qty < 0) shortMin += -pos.qty * u.spot * p.shortOptionMinPct;
    const tau = pos.expiry > p.now ? pos.expiry - p.now : 0;
    const mark = bsPrice(u.spot, pos.strike, tau, u.vol, pos.isCall, p.rate);
    mtm += pos.qty * mark;
    for (let v = 0; v < VOL_POINTS; v++) {
      const vol = vols[pos.u]![v]!;
      for (let j = 0; j < PRICE_POINTS; j++) {
        const px = bsPrice(prices[j]!, pos.strike, tau, vol, pos.isCall, p.rate);
        cells[v * PRICE_POINTS + j]! += pos.qty * (px - mark);
      }
    }
  }

  const grid = new Array<number>(CELLS).fill(0);
  for (const cells of pnl) for (let s = 0; s < CELLS; s++) grid[s]! += cells[s]!;
  let worstScenario = 0;
  let minSum = nu > 0 ? Infinity : 0;
  if (nu > 0) {
    for (let s = 0; s < CELLS; s++) {
      if (grid[s]! < minSum) {
        minSum = grid[s]!;
        worstScenario = s;
      }
    }
  }
  let lossIndep = 0;
  for (const cells of pnl) {
    const mn = Math.min(...cells);
    if (mn < 0) lossIndep += -mn;
  }
  const lossCorr = minSum < 0 ? -minSum : 0;
  const base = Math.max(lossCorr, lossIndep * (1 - p.diversificationCredit));
  return { mtm, lossIM: base + shortMin, lossCorr, lossIndep, shortMin, worstScenario, grid };
}

/** An account's book in kernel form. Underlyings appear in first-seen order: collateral, then positions. */
export interface KBook {
  symbols: string[];
  us: KUnderlying[];
  ps: KPosition[];
}

interface BookSeries {
  underlying: string;
  strike: number;
  expiry: number;
  isCall: boolean;
  qty: number;
}

interface BookUnderlying {
  symbol: string;
  spot: number;
  markVol: number;
  session: Session;
}

export function buildBook(
  positions: readonly BookSeries[],
  collateral: Readonly<Record<string, number>>,
  underlyings: readonly BookUnderlying[],
): KBook {
  const book: KBook = { symbols: [], us: [], ps: [] };
  const index = (symbol: string): number => {
    const at = book.symbols.indexOf(symbol);
    if (at >= 0) return at;
    const u = underlyings.find((x) => x.symbol === symbol);
    if (!u) throw new Error(`unknown underlying ${symbol}`);
    book.symbols.push(symbol);
    book.us.push({
      spot: u.spot,
      vol: u.markVol,
      shockRange: shockRange(u.markVol, u.session),
      volUp: RISK.volUp,
      volDown: RISK.volDown,
      tokenQty: 0,
    });
    return book.symbols.length - 1;
  };
  for (const [symbol, qty] of Object.entries(collateral)) {
    if (qty !== 0) book.us[index(symbol)]!.tokenQty += qty;
  }
  for (const p of positions) {
    if (p.qty === 0) continue;
    book.ps.push({ u: index(p.underlying), isCall: p.isCall, expiry: p.expiry, strike: p.strike, qty: p.qty });
  }
  return book;
}

/** The same book with `qtyDelta` more of one series (merged into an existing position when there is one). */
export function withTrade(
  book: KBook,
  series: Omit<BookSeries, 'qty'>,
  qtyDelta: number,
  underlyings: readonly BookUnderlying[],
): KBook {
  const next: KBook = { symbols: [...book.symbols], us: book.us.map((u) => ({ ...u })), ps: book.ps.map((p) => ({ ...p })) };
  let u = next.symbols.indexOf(series.underlying);
  if (u < 0) {
    const grown = buildBook([{ ...series, qty: 1 }], {}, underlyings);
    next.symbols.push(series.underlying);
    next.us.push(grown.us[0]!);
    u = next.symbols.length - 1;
  }
  const held = next.ps.find(
    (p) => p.u === u && p.isCall === series.isCall && p.expiry === series.expiry && p.strike === series.strike,
  );
  if (held) held.qty += qtyDelta;
  else next.ps.push({ u, isCall: series.isCall, expiry: series.expiry, strike: series.strike, qty: qtyDelta });
  next.ps = next.ps.filter((p) => p.qty !== 0);
  return next;
}
