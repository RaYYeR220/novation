import { fromWad, getCash, getDeficit, simulateRepayDeficit } from '@novation/sdk';
import { execute, type Keeper } from '../keeper';

/**
 * Applies an account's own cash to what it owes when the cash covers all of it. Cash that arrives
 * by a deposit or a claim sits next to the deficit until someone calls repayDeficit (it is
 * permissionless and equity-neutral); until then the account can't withdraw or open, and a vault
 * can't pay its queue. True when the account owes nothing afterwards.
 */
export async function repayIfCovered(k: Keeper, job: string, id: bigint): Promise<boolean> {
  const [{ total }, cash] = await Promise.all([getDeficit(k.ctx, id), getCash(k.ctx, id)]);
  if (total === 0n) return true;
  if (cash < total) return false;
  const rec = await execute(k, job, `repayDeficit ${id}`, () => simulateRepayDeficit(k.ctx, k.account, id), { id, owed: fromWad(total), cash: fromWad(cash) });
  if (rec?.status !== 'success') return false;
  return (await getDeficit(k.ctx, id)).total === 0n;
}
