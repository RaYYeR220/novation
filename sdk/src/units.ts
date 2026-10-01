import { formatUnits, parseUnits } from 'viem';

export const WAD = 10n ** 18n;
export const YEAR = 31_536_000n;

/** A decimal string or number into WAD. Numbers go through their shortest decimal form. */
export function toWad(v: number | string): bigint {
  return parseUnits(typeof v === 'number' ? numToString(v) : v, 18);
}

/** WAD into a float. Exact to ~15 significant digits: fine for display, never for maths on chain. */
export function fromWad(v: bigint): number {
  return Number(formatUnits(v, 18));
}

/** Raw token units into a float. */
export function fromUnits(v: bigint, decimals: number): number {
  return Number(formatUnits(v, decimals));
}

/** A decimal amount into raw token units, truncated to the token's decimals. */
export function toUnits(v: number | string, decimals: number): bigint {
  const s = typeof v === 'number' ? numToString(v) : v;
  const [i = '0', f = ''] = s.split('.');
  return parseUnits(f ? `${i}.${f.slice(0, decimals)}` : i, decimals);
}

/** Raw token amount into WAD, as the clearinghouse credits it: amount * 10^(18 - decimals). */
export function tokenToWad(amount: bigint, decimals: number): bigint {
  return amount * 10n ** BigInt(18 - decimals);
}

/** WAD into raw token units, rounded down (what a withdrawal can pay). */
export function wadToToken(wad: bigint, decimals: number): bigint {
  return wad / 10n ** BigInt(18 - decimals);
}

export function mulWad(a: bigint, b: bigint): bigint {
  return (a * b) / WAD;
}

/** ceil(a * b / 1e18) for non-negative operands (FixedPointMath.mulWadUp). */
export function mulWadUp(a: bigint, b: bigint): bigint {
  const p = a * b;
  return p === 0n ? 0n : (p - 1n) / WAD + 1n;
}

export function divWad(a: bigint, b: bigint): bigint {
  return (a * WAD) / b;
}

/** floor(sqrt(x * 1e18)) by Newton's method: FixedPointMath.sqrtWad, bit for bit. */
export function sqrtWad(x: bigint): bigint {
  const n = x * WAD;
  if (n === 0n) return 0n;
  let r = n;
  let y = (n + 1n) / 2n;
  while (y < r) {
    r = y;
    y = (n / y + y) / 2n;
  }
  return r;
}

function numToString(v: number): string {
  if (!Number.isFinite(v)) throw new RangeError(`not a finite number: ${v}`);
  const s = String(v);
  if (!/e/i.test(s)) return s;
  return v.toFixed(18).replace(/0+$/, '').replace(/\.$/, '');
}
