import { getUnderlyingParams, getUnderlyingTokens, getVolState, marketDataHubAbi, simulateSyncVol, symbolOf } from '@novation/sdk';
import { parseAbi } from 'viem';
import { phaseOf } from '../hint';
import { belowReserve, chainNow, execute, feedReader, type Keeper } from '../keeper';

/** MarketDataHub.syncAndRebaseVol: folds the rest of the old phase and rebases in one call. */
const syncAndRebaseAbi = parseAbi(['function syncAndRebaseVol(address u) returns (bool rebased)']);

const JOB = 'syncVol';

/**
 * Folds new feed rounds into the hub's realized vol, per underlying, when the feed has a round the
 * hub hasn't seen. syncVol is permissionless and takes up to 64 rounds per call. When the feed has
 * moved to a new aggregator phase, syncAndRebaseVol folds what is left of the old phase and
 * re-anchors on the new one in the same transaction (the old aggregator may still be printing).
 * With syncVolEverySec set, an underlying poked (by anyone) more recently than that is left alone.
 */
export async function syncVol(k: Keeper): Promise<void> {
  const { ctx } = k;
  if (await belowReserve(k)) {
    k.log('info', JOB, 'skip', { reason: 'balance below the gas reserve: kept for settlement' });
    return;
  }
  const now = await chainNow(k);
  for (const u of await getUnderlyingTokens(ctx)) {
    const p = await getUnderlyingParams(ctx, u);
    if (!p.enabled) continue;
    const sym = symbolOf(ctx.deployment, u) ?? u;
    const [vol, latest] = await Promise.all([getVolState(ctx, u), feedReader(k, p.feed).latest()]);
    const hub = { address: ctx.deployment.hub, abi: marketDataHubAbi } as const;

    if (vol.lastRoundId === 0n) {
      await execute(k, JOB, `initVol ${sym}`, () => k.client.simulateContract({ ...hub, functionName: 'initVol', args: [u], account: k.account }), { underlying: sym });
      continue;
    }
    if (phaseOf(latest.id) !== phaseOf(vol.lastRoundId)) {
      if (phaseOf(latest.id) > phaseOf(vol.lastRoundId)) {
        // the feed moved to a new aggregator phase: fold what is left of the old phase (syncVol
        // stays in the stored phase and won't) and re-anchor on the new phase's latest round, in
        // one transaction, so the old aggregator can't print in between (up to 64 old rounds per
        // call; a longer tail takes the next tick)
        await execute(
          k,
          JOB,
          `syncAndRebaseVol ${sym}`,
          () => k.client.simulateContract({ address: hub.address, abi: syncAndRebaseAbi, functionName: 'syncAndRebaseVol', args: [u], account: k.account }),
          { underlying: sym, fromRound: vol.lastRoundId, toRound: latest.id },
        );
      }
      continue;
    }
    if (latest.id <= vol.lastRoundId) {
      k.log('debug', JOB, 'current', { underlying: sym, round: latest.id });
      continue;
    }
    const behind = latest.id - vol.lastRoundId;
    if (k.opts.syncVolEverySec > 0 && now - vol.lastPokeTs < k.opts.syncVolEverySec) {
      k.log('debug', JOB, 'rate-limited', { underlying: sym, behind, lastPokeTs: vol.lastPokeTs });
      continue;
    }
    await execute(k, JOB, `syncVol ${sym}`, () => simulateSyncVol(ctx, k.account, u), {
      underlying: sym,
      behind,
      fromRound: vol.lastRoundId,
      toRound: latest.id,
    });
  }
}
