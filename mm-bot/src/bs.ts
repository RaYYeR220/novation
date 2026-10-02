/**
 * Black-Scholes in WAD integers, the same algorithm as contracts/src/libraries/BlackScholes.sol
 * and FixedPointMath.sol: same constants, same order of operations, truncation toward zero.
 * bsPrice returns exactly the integer the risk kernel's bsQuote returns for the same inputs,
 * which is also the mark the clearinghouse gives a position.
 *
 * BigInt division truncates toward zero, like Solidity's signed division.
 */
import { sqrtWad, YEAR } from '@novation/sdk';

const WAD = 10n ** 18n;
const LN2 = 693147180559945309n;
const SQRT2 = 1414213562373095048n;
const INV_SQRT_2PI = 398942280401432678n;
const AS_P = 231641900000000000n;
const AS_B1 = 319381530000000000n;
const AS_B2 = -356563782000000000n;
const AS_B3 = 1781477937000000000n;
const AS_B4 = -1821255978000000000n;
const AS_B5 = 1330274429000000000n;
/** Below this sigma*sqrt(T) the option is worth its forward intrinsic value. */
const MIN_SST = 10n ** 6n;

const mulWad = (a: bigint, b: bigint) => (a * b) / WAD;
const divWad = (a: bigint, b: bigint) => (a * WAD) / b;

/** e^x for WAD x: x = k*ln2 + r with |r| <= ln2/2, Taylor to degree 12 by Horner. */
export function expWad(x: bigint): bigint {
  if (x < -41n * WAD) return 0n;
  if (x > 130n * WAD) throw new RangeError('expWad overflow');
  const k = x >= 0n ? (x + LN2 / 2n) / LN2 : (x - LN2 / 2n) / LN2;
  const r = x - k * LN2;
  let t = WAD;
  for (let n = 12n; n >= 1n; n--) t = WAD + mulWad(r, t) / n;
  return k >= 0n ? t << k : t >> -k;
}

/** ln(x) for WAD x > 0: normalise into [1, sqrt2], then 2*atanh(z) as an odd series to z^19. */
export function lnWad(x: bigint): bigint {
  if (x <= 0n) throw new RangeError('lnWad of a non-positive number');
  let k = 0n;
  let m = x;
  while (m >= 2n * WAD) {
    k++;
    m = x >> k;
  }
  while (m < WAD) {
    k--;
    m = x << -k;
  }
  if (m > SQRT2) {
    m = m / 2n;
    k += 1n;
  }
  const z = divWad(m - WAD, m + WAD);
  const z2 = mulWad(z, z);
  let s = WAD / 19n;
  for (let n = 17n; n >= 1n; n -= 2n) s = WAD / n + mulWad(z2, s);
  return k * LN2 + 2n * mulWad(z, s);
}

export function normPdf(x: bigint): bigint {
  return mulWad(INV_SQRT_2PI, expWad(-mulWad(x, x) / 2n));
}

/** Standard normal CDF, Abramowitz-Stegun 26.2.17. */
export function normCdf(x: bigint): bigint {
  if (x >= 8n * WAD) return WAD;
  if (x <= -8n * WAD) return 0n;
  const ax = x >= 0n ? x : -x;
  const t = divWad(WAD, WAD + mulWad(AS_P, ax));
  let poly = AS_B5;
  poly = AS_B4 + mulWad(t, poly);
  poly = AS_B3 + mulWad(t, poly);
  poly = AS_B2 + mulWad(t, poly);
  poly = AS_B1 + mulWad(t, poly);
  poly = mulWad(t, poly);
  const tail = mulWad(normPdf(ax), poly);
  return x >= 0n ? WAD - tail : tail;
}

/**
 * Option value per contract (WAD USD) for spot `S`, strike `K` (WAD), `tau` seconds to expiry,
 * annual `vol` and `rate` (WAD; rate signed).
 */
export function bsPrice(S: bigint, K: bigint, tau: bigint, vol: bigint, rate: bigint, isCall: boolean): bigint {
  if (tau <= 0n) {
    const iv = isCall ? S - K : K - S;
    return iv > 0n ? iv : 0n;
  }
  const T = (tau * WAD) / YEAR;
  const sqrtT = sqrtWad(T);
  const sst = mulWad(vol, sqrtT);
  const drift = mulWad(rate + mulWad(vol, vol) / 2n, T);
  const disc = rate === 0n ? WAD : expWad(-mulWad(rate, T));
  const Kd = mulWad(K, disc);
  const lnx = lnWad(divWad(S, K));
  if (sst < MIN_SST) {
    const v = isCall ? S - Kd : Kd - S;
    return v > 0n ? v : 0n;
  }
  const d1 = divWad(lnx + drift, sst);
  const d2 = d1 - sst;
  const v = isCall ? mulWad(S, normCdf(d1)) - mulWad(Kd, normCdf(d2)) : mulWad(Kd, normCdf(-d2)) - mulWad(S, normCdf(-d1));
  return v > 0n ? v : 0n;
}
