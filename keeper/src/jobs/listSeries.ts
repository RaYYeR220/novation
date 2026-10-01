import { fromWad, getGlobals, getSpot, getUnderlyingParams, getUnderlyingTokens, simulateListSeries, symbolOf, weeklyExpiries } from '@novation/sdk';
import { gridStrikes } from '../grid';
import { chainNow, execute, why, type Keeper } from '../keeper';

const JOB = 'listSeries';

const key = (u: string, expiry: number, strike: bigint, isCall: boolean) => `${u.toLowerCase()}:${expiry}:${strike}:${isCall}`;

/**
 * Keeps the weekly grid listed: for the next `expiriesAhead` weekly expiries (within the
 * registry's maxWeeksOut, skipping one that closes within minListTenorSec), a call and a put at
 * spot * (1 +- p%) on the strike step for each grid percentage, the seed script's grid. Strikes
 * beyond maxStrikeDeviation are skipped, as the
 * registry would refuse them, and so is an underlying the hub reports HALTED. Only missing series
 * are sent; listing is permissionless.
 */
export async function listSeries(k: Keeper): Promise<void> {
  const { ctx, state } = k;
  const now = await chainNow(k);
  const g = await getGlobals(ctx);
  const expiries = weeklyExpiries(now, k.opts.expiriesAhead).filter((e) => e <= now + g.maxWeeksOut * 7 * 86400 && e - now >= k.opts.minListTenorSec);
  const listed = new Set([...state.series.values()].map((s) => key(s.underlying, s.expiry, s.strike, s.isCall)));

  for (const u of await getUnderlyingTokens(ctx)) {
    const p = await getUnderlyingParams(ctx, u);
    if (!p.enabled) continue;
    const sym = symbolOf(ctx.deployment, u) ?? u;
    let spot: bigint;
    try {
      const s = await getSpot(ctx, u);
      if (!s.ok) {
        k.log('info', JOB, 'skip', { underlying: sym, reason: 'HALTED' });
        continue;
      }
      spot = s.price;
    } catch (e) {
      k.log('info', JOB, 'skip', { underlying: sym, reason: why(e) });
      continue;
    }
    const strikes = gridStrikes(spot, p.strikeStep, k.opts.gridPcts, g.maxStrikeDeviation);
    let missing = 0;
    for (const expiry of expiries) {
      for (const strike of strikes) {
        for (const isCall of [true, false]) {
          if (listed.has(key(u, expiry, strike, isCall))) continue;
          missing++;
          const rec = await execute(k, JOB, `list ${sym} ${expiry} ${isCall ? 'C' : 'P'}${fromWad(strike)}`, () => simulateListSeries(ctx, k.account, u, expiry, strike, isCall), {
            underlying: sym,
            expiry,
            strike: fromWad(strike),
            isCall,
          });
          if (rec?.status === 'success') listed.add(key(u, expiry, strike, isCall));
        }
      }
    }
    k.log('debug', JOB, 'grid', { underlying: sym, spot: fromWad(spot), strikes: strikes.map(fromWad), expiries, missing });
  }
}
