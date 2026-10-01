import { getDeficit, optionVaultAbi, simulateVaultRoll } from '@novation/sdk';
import { chainNow, execute, type Keeper } from '../keeper';

const JOB = 'roll';

/**
 * Pays vault redemption queues. A vault's roll is permissionless: it settles and claims the
 * expiries it is given, then pays the current epoch at NAV if its unlocked assets cover it. The
 * settle and claim jobs already roll a vault whenever one of its expiries settles; this job rolls a
 * vault with shares queued (and no deficit), at most once per rollEverySec, so a queue that
 * couldn't be paid at settlement (assets still locked) is retried as positions expire.
 */
export async function roll(k: Keeper): Promise<void> {
  const now = await chainNow(k);
  for (const [vaultId, v] of k.state.vaultIds) {
    const vc = { address: v, abi: optionVaultAbi } as const;
    const [escrowed, live] = await Promise.all([
      k.client.readContract({ ...vc, functionName: 'escrowedShares' }),
      k.client.readContract({ ...vc, functionName: 'isLive' }),
    ]);
    if (escrowed === 0n) continue;
    const last = k.state.lastRoll.get(v) ?? 0;
    if (now - last < k.opts.rollEverySec) continue;
    const deficit = (await getDeficit(k.ctx, vaultId)).total;
    if (deficit !== 0n) {
      k.log('info', JOB, 'wait', { vault: v, vaultId, escrowed, reason: 'vault owes a deficit' });
      continue;
    }
    k.state.lastRoll.set(v, now);
    await execute(k, JOB, `roll vault ${vaultId}`, () => simulateVaultRoll(k.ctx, k.account, v, []), { vault: v, vaultId, escrowed, live });
  }
}
