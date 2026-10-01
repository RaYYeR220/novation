import { fromWad, getPositions, simulateSettleAccount, simulateVaultRoll, type Address } from '@novation/sdk';
import { settledPayoff } from '../payoff';
import { chainNow, execute, settlementOf, type Keeper } from '../keeper';

const JOB = 'settleAccount';

export interface SettleTask {
  id: bigint;
  expiry: number;
  /** Net payoff, WAD: < 0 a payer, >= 0 a receiver. */
  net: bigint;
  /** Set when the account is a vault's: the vault's roll settles it (and pays its queue). */
  vault?: Address;
}

/**
 * Every (account, expiry) with expired positions whose underlyings the registry has all settled,
 * payers first (most negative net first), then receivers.
 */
export async function settleTasks(k: Keeper, now: number): Promise<SettleTask[]> {
  const tasks: SettleTask[] = [];
  for (const id of k.state.accounts) {
    const ps = (await getPositions(k.ctx, id, k.state.series)).filter((p) => p.expiry <= now);
    const byExpiry = new Map<number, typeof ps>();
    for (const p of ps) byExpiry.set(p.expiry, [...(byExpiry.get(p.expiry) ?? []), p]);
    for (const [expiry, list] of byExpiry) {
      let net = 0n;
      let ready = true;
      for (const p of list) {
        const price = await settlementOf(k, p.underlying, expiry);
        if (price === null) {
          ready = false;
          break;
        }
        net += settledPayoff(p, price, p.qty);
      }
      if (!ready) continue;
      const vault = k.state.vaultIds.get(id);
      tasks.push({ id, expiry, net, ...(vault ? { vault } : {}) });
    }
  }
  return tasks.sort((a, b) => (a.net < b.net ? -1 : a.net > b.net ? 1 : a.expiry - b.expiry || Number(a.id - b.id)));
}

/**
 * Closes the expired positions of every account the keeper has seen trade, through the expiry's
 * pool: payers pay in first, then receivers get their claims. settleAccount is permissionless.
 * A vault's account is settled by the vault's own roll, which also collects its claim and pays
 * its redemption queue.
 */
export async function settleAccounts(k: Keeper): Promise<void> {
  const now = await chainNow(k);
  for (const t of await settleTasks(k, now)) {
    const fields = { id: t.id, expiry: t.expiry, net: fromWad(t.net), role: t.net < 0n ? 'payer' : 'receiver', ...(t.vault ? { vault: t.vault } : {}) };
    if (t.vault) {
      const v = t.vault;
      await execute(k, JOB, `roll vault ${t.id} ${t.expiry}`, () => simulateVaultRoll(k.ctx, k.account, v, [t.expiry]), fields);
    } else {
      await execute(k, JOB, `settleAccount ${t.id} ${t.expiry}`, () => simulateSettleAccount(k.ctx, k.account, t.id, t.expiry), fields);
    }
  }
}
