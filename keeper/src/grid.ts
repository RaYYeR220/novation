import { WAD } from '@novation/sdk';

/** The strike-step rounding the seed script uses: (k + step/2) / step * step. */
export function toGrid(k: bigint, step: bigint): bigint {
  return ((k + step / 2n) / step) * step;
}

/**
 * The weekly strike grid around `spot` (WAD): spot * (1 +- p%) for each p, rounded to the strike
 * step, the same grid the seed script lists. Strikes the registry would refuse (zero, or further
 * than maxStrikeDeviation from spot) are dropped. Ascending, no duplicates.
 */
export function gridStrikes(spot: bigint, step: bigint, pcts: readonly number[], maxStrikeDeviation: bigint): bigint[] {
  const out = new Set<bigint>();
  for (const p of pcts) {
    const pp = BigInt(p);
    for (const k of [toGrid((spot * (100n + pp)) / 100n, step), toGrid((spot * (100n - pp)) / 100n, step)]) {
      if (k <= 0n) continue;
      const diff = k > spot ? k - spot : spot - k;
      if (diff > (spot * maxStrikeDeviation) / WAD) continue;
      out.add(k);
    }
  }
  return [...out].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
