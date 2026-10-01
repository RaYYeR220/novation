import { getUnderlyingParams, getUnderlyingTokens, getVolState, marketDataHubAbi, simulateSyncVol, symbolOf } from '@novation/sdk';
import { lastRoundOfPhase, packRound, phaseOf } from '../hint';
import { chainNow, execute, feedReader, type Keeper } from '../keeper';

const JOB = 'syncVol';

/**
 * Folds new feed rounds into the hub's realized vol, per underlying, when the feed has a round the
 * hub hasn't seen. syncVol is permissionless and takes up to 64 rounds per call. When the feed has
 * moved to a new aggregator phase, rebaseVol re-anchors it instead (once the old phase is done).
 * With syncVolEverySec set, an underlying poked (by anyone) more recently than that is left alone.
 */
export async function syncVol(k: Keeper): Promise<void> {
  const { ctx } = k;
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
        // stays in the stored phase and won't), then re-anchor on the new phase's latest round
        const phase = phaseOf(vol.lastRoundId);
        const last = packRound(phase, await lastRoundOfPhase(feedReader(k, p.feed), phase));
        if (last > vol.lastRoundId) {
          const ids: bigint[] = [];
          for (let id = vol.lastRoundId + 1n; id <= last && ids.length < 64; id++) ids.push(id);
          await execute(k, JOB, `pokeVol ${sym}`, () => k.client.simulateContract({ ...hub, functionName: 'pokeVol', args: [u, ids], account: k.account }), {
            underlying: sym,
            fromRound: ids[0],
            toRound: ids[ids.length - 1],
          });
          if (ids[ids.length - 1]! < last) continue;
        }
        await execute(k, JOB, `rebaseVol ${sym}`, () => k.client.simulateContract({ ...hub, functionName: 'rebaseVol', args: [u], account: k.account }), {
          underlying: sym,
          fromRound: last,
          toRound: latest.id,
        });
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
