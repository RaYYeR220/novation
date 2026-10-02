import { getDeficit, getSpot, getUnderlyingParams, getVolState, optionVaultAbi, simulateVaultRoll, type Address } from '@novation/sdk';
import { phaseOf } from '../hint';
import { belowReserve, chainNow, execute, feedReader, type Keeper } from '../keeper';
import { repayIfCovered } from './deficit';

const JOB = 'roll';

/**
 * Whether the vault will be live inside its own roll, which syncs vol first: it is live now, or its
 * market is open (REGULAR or EXTENDED: vaults close over weekends and holidays) and the feed has
 * rounds (in the stored phase, at most 64) for the sync to fold.
 */
async function liveForRoll(k: Keeper, v: Address): Promise<boolean> {
  const vc = { address: v, abi: optionVaultAbi } as const;
  if (await k.client.readContract({ ...vc, functionName: 'isLive' })) return true;
  const u = await k.client.readContract({ ...vc, functionName: 'underlying' });
  const spot = await getSpot(k.ctx, u).catch(() => null);
  // vaults are closed over weekends and holidays: a roll pays its queue only in an open session
  if (!spot?.ok || (spot.session !== 'REGULAR' && spot.session !== 'EXTENDED')) return false;
  const [vol, p] = await Promise.all([getVolState(k.ctx, u), getUnderlyingParams(k.ctx, u)]);
  const latest = await feedReader(k, p.feed).latest();
  return phaseOf(latest.id) === phaseOf(vol.lastRoundId) && latest.id > vol.lastRoundId && latest.id - vol.lastRoundId <= 64n;
}

/**
 * Pays vault redemption queues. A vault's roll is permissionless: it settles and claims the
 * expiries it is given, then pays the current epoch at NAV if its unlocked assets cover it. The
 * settle and claim jobs already roll a vault whenever one of its expiries settles; this job rolls a
 * vault with shares queued only when the roll would pay them: no deficit, live (after the roll's
 * own vol sync) and enough unlocked assets (freeAssets, which is net of the queue, above zero). A
 * roll that would do nothing is never sent; after a roll it sent, the job waits rollEverySec (an
 * hour by default) before rolling the same vault again, and nothing is sent while the balance is
 * below the gas reserve. A vault whose cash already covers a deficit gets it applied first (repayDeficit).
 */
export async function roll(k: Keeper): Promise<void> {
  const now = await chainNow(k);
  for (const [vaultId, v] of k.state.vaultIds) {
    const vc = { address: v, abi: optionVaultAbi } as const;
    const base = { vault: v, vaultId };
    if ((await getDeficit(k.ctx, vaultId)).total !== 0n && !(await repayIfCovered(k, JOB, vaultId))) {
      k.log('debug', JOB, 'wait', { ...base, reason: 'vault owes a deficit its cash does not cover' });
      continue;
    }
    const escrowed = await k.client.readContract({ ...vc, functionName: 'escrowedShares' });
    if (escrowed === 0n) continue;
    const last = k.state.lastRoll.get(v) ?? 0;
    if (now - last < k.opts.rollEverySec) continue;
    if (await belowReserve(k)) {
      k.log('info', JOB, 'skip', { ...base, reason: 'balance below the gas reserve: kept for settlement' });
      continue;
    }
    const [assets, free] = await Promise.all([
      k.client.readContract({ ...vc, functionName: 'convertToAssets', args: [escrowed] }),
      k.client.readContract({ ...vc, functionName: 'freeAssets' }),
    ]);
    if (assets === 0n) continue;
    if (!(await liveForRoll(k, v))) {
      k.log('info', JOB, 'wait', { ...base, escrowed, reason: 'vault not live (closed for the weekend or a holiday, halted, or its vol is stale with nothing to sync)' });
      continue;
    }
    if (free === 0n) {
      k.log('info', JOB, 'wait', { ...base, escrowed, assets, reason: 'queue not payable yet: its assets are locked behind open shorts' });
      continue;
    }
    const rec = await execute(k, JOB, `roll vault ${vaultId}`, () => simulateVaultRoll(k.ctx, k.account, v, []), { ...base, escrowed, assets, free });
    if (rec) k.state.lastRoll.set(v, now);
  }
}
