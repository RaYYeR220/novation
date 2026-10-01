import type { Address } from 'viem';
import { seriesRegistryAbi } from './abi/index';
import type { NovationContext, SeriesInfo } from './types';

const r = (ctx: NovationContext) => ({ address: ctx.deployment.registry, abi: seriesRegistryAbi }) as const;

export async function getSeriesCount(ctx: NovationContext): Promise<number> {
  return Number(await ctx.client.readContract({ ...r(ctx), functionName: 'seriesCount' }));
}

export async function getSeries(ctx: NovationContext, id: number): Promise<SeriesInfo> {
  const s = await ctx.client.readContract({ ...r(ctx), functionName: 'series', args: [id] });
  return { id, underlying: s.underlying, expiry: Number(s.expiry), isCall: s.isCall, strike: s.strike };
}

/** Series id for (underlying, expiry, strike, type), or 0 if not listed. */
export async function findSeriesId(ctx: NovationContext, underlying: Address, expiry: number, strike: bigint, isCall: boolean): Promise<number> {
  return Number(await ctx.client.readContract({ ...r(ctx), functionName: 'seriesId', args: [underlying, BigInt(expiry), strike, isCall] }));
}

/**
 * Every listed series (ids start at 1), optionally on one underlying and/or unexpired at `now`.
 * Series never change once listed, so `cache` (keyed by id) can be shared across calls.
 */
export async function listSeries(
  ctx: NovationContext,
  opts: { underlying?: Address; liveAt?: number; cache?: Map<number, SeriesInfo> } = {},
): Promise<SeriesInfo[]> {
  const n = await getSeriesCount(ctx);
  const cache = opts.cache;
  const all = await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      const id = i + 1;
      const hit = cache?.get(id);
      if (hit) return hit;
      const s = await getSeries(ctx, id);
      cache?.set(id, s);
      return s;
    }),
  );
  const u = opts.underlying?.toLowerCase();
  return all.filter((s) => (!u || s.underlying.toLowerCase() === u) && (opts.liveAt === undefined || s.expiry > opts.liveAt));
}

/** Distinct expiries of the listed series, ascending. */
export function expiriesOf(series: SeriesInfo[]): number[] {
  return [...new Set(series.map((s) => s.expiry))].sort((a, b) => a - b);
}

export async function getExpiries(ctx: NovationContext, opts: { underlying?: Address; liveAt?: number } = {}): Promise<number[]> {
  return expiriesOf(await listSeries(ctx, opts));
}

/** The registry's settlement price for (underlying, expiry): WAD, and whether it is set. */
export async function getSettlementPrice(ctx: NovationContext, underlying: Address, expiry: number): Promise<{ price: bigint; settled: boolean }> {
  const [price, settled] = await ctx.client.readContract({ ...r(ctx), functionName: 'settlementPriceOf', args: [underlying, BigInt(expiry)] });
  return { price, settled };
}
