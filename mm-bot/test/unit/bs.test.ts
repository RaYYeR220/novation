import { describe, expect, it } from 'vitest';
import { fromWad, toWad, WAD } from '@novation/sdk';
import { bsPrice, expWad, lnWad, normCdf } from '../../src/bs';

const YEAR = 31_536_000;

/** Float Black-Scholes with an accurate erf, as an independent reference. */
function ref(S: number, K: number, tauSec: number, vol: number, r: number, isCall: boolean): number {
  const T = tauSec / YEAR;
  const N = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));
  const d1 = (Math.log(S / K) + (r + (vol * vol) / 2) * T) / (vol * Math.sqrt(T));
  const d2 = d1 - vol * Math.sqrt(T);
  return isCall ? S * N(d1) - K * Math.exp(-r * T) * N(d2) : K * Math.exp(-r * T) * N(-d2) - S * N(-d1);
}

function erf(x: number): number {
  // Maclaurin series: accurate to ~1e-13 for |x| <= 3, which is all the tests use
  const s = Math.sign(x);
  const a = Math.abs(x);
  if (a > 3) throw new RangeError('reference erf only covers |x| <= 3');
  let sum = a;
  let term = a;
  for (let n = 1; n < 200; n++) {
    term *= (-a * a) / n;
    const add = term / (2 * n + 1);
    sum += add;
    if (Math.abs(add) < 1e-17) break;
  }
  return (s * 2 * sum) / Math.sqrt(Math.PI);
}

describe('fixed-point helpers', () => {
  it('exp and ln agree with floats', () => {
    expect(expWad(0n)).toBe(WAD);
    expect(lnWad(WAD)).toBe(0n);
    for (const x of [-5, -1.25, -0.3, 0.001, 0.7, 2, 9.5]) expect(fromWad(expWad(toWad(x)))).toBeCloseTo(Math.exp(x), 9);
    for (const x of [0.01, 0.4, 1.0001, 1.5, 3, 250, 1e6]) expect(fromWad(lnWad(toWad(x)))).toBeCloseTo(Math.log(x), 9);
    expect(expWad(-42n * WAD)).toBe(0n);
    expect(() => lnWad(0n)).toThrow();
  });

  it('normal CDF is within the Abramowitz-Stegun error bound', () => {
    for (const x of [-4, -3, -1, -0.2, 0, 0.5, 1.96, 4]) {
      expect(Math.abs(fromWad(normCdf(toWad(x))) - 0.5 * (1 + erf(x / Math.SQRT2)))).toBeLessThan(1e-7);
    }
    expect(normCdf(8n * WAD)).toBe(WAD);
    expect(normCdf(-8n * WAD)).toBe(0n);
  });
});

describe('bsPrice', () => {
  const cases = [
    { S: 190, K: 190, days: 7, vol: 0.5, r: 0, call: true },
    { S: 190, K: 210, days: 7, vol: 0.5, r: 0, call: true },
    { S: 190, K: 170, days: 14, vol: 0.45, r: 0.04, call: false },
    { S: 440, K: 400, days: 3, vol: 0.9, r: 0.05, call: true },
    { S: 665, K: 700, days: 30, vol: 0.18, r: -0.01, call: false },
    { S: 230.2, K: 230, days: 1, vol: 1.5, r: 0, call: true },
  ];

  it('matches a float reference to a hundredth of a cent', () => {
    for (const c of cases) {
      const got = fromWad(bsPrice(toWad(c.S), toWad(c.K), BigInt(c.days * 86400), toWad(c.vol), toWad(c.r), c.call));
      expect(Math.abs(got - ref(c.S, c.K, c.days * 86400, c.vol, c.r, c.call))).toBeLessThan(1e-4);
    }
  });

  it('holds put-call parity', () => {
    const S = toWad(190);
    const K = toWad(200);
    const tau = 10n * 86400n;
    const r = toWad(0.03);
    const c = fromWad(bsPrice(S, K, tau, toWad(0.6), r, true));
    const p = fromWad(bsPrice(S, K, tau, toWad(0.6), r, false));
    expect(c - p).toBeCloseTo(190 - 200 * Math.exp(-0.03 * (10 / 365)), 4);
  });

  it('rises with vol and pays intrinsic at expiry', () => {
    const at = (v: number) => bsPrice(toWad(190), toWad(200), 5n * 86400n, toWad(v), 0n, true);
    expect(at(0.3)).toBeLessThan(at(0.5));
    expect(at(0.5)).toBeLessThan(at(1.2));
    expect(bsPrice(toWad(190), toWad(180), 0n, toWad(0.5), 0n, true)).toBe(toWad(10));
    expect(bsPrice(toWad(190), toWad(180), 0n, toWad(0.5), 0n, false)).toBe(0n);
    // no vol: forward intrinsic
    expect(bsPrice(toWad(190), toWad(180), 86400n, 0n, 0n, true)).toBe(toWad(10));
  });
});
