import { fromWad, getClaimable, getPool, simulateClaim, simulateVaultRoll } from '@novation/sdk';
import { execute, type Keeper } from '../keeper';

const JOB = 'claim';

/**
 * Pays every receiver's claim into its cash once its expiry's pool is ready (no short of the
 * expiry left unsettled, nothing pending). Clearinghouse.claim is permissionless, so the keeper
 * claims for everyone; a vault's claim goes through its roll, which also pays its queue.
 */
export async function claim(k: Keeper): Promise<void> {
  for (const c of [...k.state.claims]) {
    const [idS, eS] = c.split(':');
    const id = BigInt(idS!);
    const expiry = Number(eS);
    const amount = await getClaimable(k.ctx, id, expiry);
    if (amount === 0n) {
      k.state.claims.delete(c);
      continue;
    }
    const pool = await getPool(k.ctx, expiry);
    if (pool.unsettledShortQty !== 0n || pool.pending !== 0n) {
      k.log('info', JOB, 'wait', { id, expiry, amount: fromWad(amount), reason: 'pool not ready', unsettledShortQty: fromWad(pool.unsettledShortQty), pending: fromWad(pool.pending) });
      continue;
    }
    const vault = k.state.vaultIds.get(id);
    const fields = { id, expiry, amount: fromWad(amount), ...(vault ? { vault } : {}) };
    const rec = vault
      ? await execute(k, JOB, `roll vault ${id} ${expiry} (claim)`, () => simulateVaultRoll(k.ctx, k.account, vault, [expiry]), fields)
      : await execute(k, JOB, `claim ${id} ${expiry}`, () => simulateClaim(k.ctx, k.account, id, expiry), fields);
    if (rec?.status === 'success') k.state.claims.delete(c);
  }
}
