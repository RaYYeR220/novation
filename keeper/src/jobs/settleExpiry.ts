import { aggregatorAbi, fmtCloseEt, fromWad, getGlobals, getUnderlyingParams, simulateSettleExpiry, simulateSettleExpiryFallback, simulateSettleExpiryLastResort, symbolOf, type Address } from '@novation/sdk';
import { findHint, type HintResult } from '../hint';
import { chainNow, execute, feedReader, settlementOf, type Keeper } from '../keeper';

const JOB = 'settleExpiry';

/** The hint the registry would get for (underlying, expiry) at chain time `now`. */
export async function hintFor(k: Keeper, underlying: Address, expiry: number, now: number): Promise<HintResult> {
  const [p, g] = await Promise.all([getUnderlyingParams(k.ctx, underlying), getGlobals(k.ctx)]);
  const decimals = await k.client.readContract({ address: p.feed, abi: aggregatorAbi, functionName: 'decimals' });
  return findHint(feedReader(k, p.feed), expiry, now, {
    maxSettlementLag: g.maxSettlementLag,
    minPrice: p.minPrice,
    maxPrice: p.maxPrice,
    decimals: Number(decimals),
  });
}

/**
 * Settles every (underlying, expiry) that has listed series, once the expiry is settleDelaySec in
 * the past: finds the hint round (the last print at or before the close, by bisecting the feed's
 * rounds), simulates SeriesRegistry.settleExpiry with it and sends. 72 hours after a close whose
 * last print is stale or implausible, settleExpiryFallback with the first post-close round.
 */
export async function settleExpiry(k: Keeper): Promise<void> {
  const now = await chainNow(k);
  const due = new Map<string, { u: Address; expiry: number }>();
  for (const s of k.state.series.values()) {
    if (s.expiry + k.opts.settleDelaySec > now || s.expiry >= now) continue;
    due.set(`${s.underlying.toLowerCase()}:${s.expiry}`, { u: s.underlying, expiry: s.expiry });
  }
  for (const { u, expiry } of due.values()) {
    if ((await settlementOf(k, u, expiry)) !== null) continue;
    const sym = symbolOf(k.ctx.deployment, u) ?? u;
    const h = await hintFor(k, u, expiry, now);
    const base = { underlying: sym, expiry, close: fmtCloseEt(expiry), reads: h.reads };
    if (h.kind !== 'ready') {
      k.log(h.kind === 'stuck' ? 'warn' : 'info', JOB, h.kind, { ...base, reason: h.reason, until: 'until' in h ? h.until : undefined, round: h.round?.id });
      continue;
    }
    const fields = {
      ...base,
      proof: h.proof,
      hint: h.hint,
      roundUpdatedAt: h.round.updatedAt,
      answer: h.round.answer,
      nextRound: h.next?.id,
      nextUpdatedAt: h.next?.updatedAt,
    };
    k.log('info', JOB, 'hint', fields);
    const sim =
      h.method === 'settleExpiry'
        ? () => simulateSettleExpiry(k.ctx, k.account, u, expiry, h.hint)
        : h.method === 'settleExpiryFallback'
          ? () => simulateSettleExpiryFallback(k.ctx, k.account, u, expiry, h.hint)
          : () => simulateSettleExpiryLastResort(k.ctx, k.account, u, expiry, h.hint);
    const rec = await execute(k, JOB, `${h.method} ${sym} ${expiry}`, sim, fields);
    if (rec?.status === 'success') {
      const price = await settlementOf(k, u, expiry);
      k.log('info', JOB, 'settled', { ...base, price: price === null ? null : fromWad(price), hash: rec.hash });
    }
  }
}
