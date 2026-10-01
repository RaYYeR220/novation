import { WAD, type SeriesInfo } from '@novation/sdk';

/**
 * Payoff.settled: `qty` contracts of `s` at settlement price `price`, rounded against the holder
 * (a long gets the floor, a short owes the ceiling). WAD in, WAD out.
 */
export function settledPayoff(s: Pick<SeriesInfo, 'isCall' | 'strike'>, price: bigint, qty: bigint): bigint {
  const k = s.strike;
  const payoff = s.isCall ? (price > k ? price - k : 0n) : k > price ? k - price : 0n;
  if (qty > 0n) return (qty * payoff) / WAD;
  const p = -qty * payoff;
  return p === 0n ? 0n : -((p - 1n) / WAD + 1n);
}
