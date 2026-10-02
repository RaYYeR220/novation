import { erc20Abi } from 'viem';
import { fromWad, getCash, getDeficit, getSocializedDebt, simulateRepayDeficit, tokenOf } from '@novation/sdk';
import { belowReserve, chainNow, execute, type Keeper } from '../keeper';

/**
 * Whether a repayDeficit is worth sending. `stuck` is the part of the debt no repay can take:
 * residual socialized debt is repaid in whole USDG units only, so a sub-unit remainder of it stays
 * for good. A repay goes out when the cash covers everything else; not again within `backoffSec`
 * of one that left the debt where it was; and a repeat for the same account not while the keeper
 * is below its gas reserve.
 */
export function shouldRepay(a: {
  total: bigint;
  social: bigint;
  cash: bigint;
  unit: bigint;
  now: number;
  /** When a repay of this account last left its debt unchanged. */
  lastStall?: number;
  backoffSec: number;
  /** The keeper has repaid this account before. */
  repeat: boolean;
  belowReserve: boolean;
}): { send: boolean; reason?: string } {
  const repayable = a.total - (a.social % a.unit);
  if (repayable <= 0n) return { send: false, reason: 'only a sub-unit of socialized debt is left, which no repay can take' };
  if (a.cash < repayable) return { send: false, reason: 'cash does not cover the debt' };
  if (a.lastStall !== undefined && a.now - a.lastStall < a.backoffSec) return { send: false, reason: 'the last repay changed nothing: backing off' };
  if (a.repeat && a.belowReserve) return { send: false, reason: 'balance below the gas reserve: a repeat repay waits' };
  return { send: true };
}

let unitCache: bigint | undefined;

/** One whole USDG unit in WAD (10^(18 - decimals)). */
async function usdgUnit(k: Keeper): Promise<bigint> {
  if (unitCache === undefined) {
    const d = await k.client.readContract({ address: tokenOf(k.ctx.deployment, 'USDG'), abi: erc20Abi, functionName: 'decimals' });
    unitCache = 10n ** BigInt(18 - d);
  }
  return unitCache;
}

/**
 * Applies an account's own cash to what it owes when the cash covers it. Cash that arrives by a
 * deposit or a claim sits next to the deficit until someone calls repayDeficit (permissionless and
 * equity-neutral); until then the account can't withdraw or open, and a vault can't pay its queue.
 * Gated by shouldRepay. True when nothing repayable is left afterwards.
 */
export async function repayIfCovered(k: Keeper, job: string, id: bigint): Promise<boolean> {
  const [{ total }, cash, social, unit] = await Promise.all([getDeficit(k.ctx, id), getCash(k.ctx, id), getSocializedDebt(k.ctx, id), usdgUnit(k)]);
  const stuck = social % unit;
  if (total <= stuck) return true;
  const now = await chainNow(k);
  const repeat = k.state.repaid.has(id);
  const go = shouldRepay({
    total,
    social,
    cash,
    unit,
    now,
    lastStall: k.state.repayStall.get(id),
    backoffSec: k.opts.restartBackoffSec,
    repeat,
    belowReserve: repeat && (await belowReserve(k)),
  });
  if (!go.send) {
    k.log('debug', job, 'skip', { label: `repayDeficit ${id}`, reason: go.reason, owed: fromWad(total), cash: fromWad(cash) });
    return false;
  }
  const rec = await execute(k, job, `repayDeficit ${id}`, () => simulateRepayDeficit(k.ctx, k.account, id), { id, owed: fromWad(total), cash: fromWad(cash) });
  if (rec?.status !== 'success') return false;
  k.state.repaid.add(id);
  const after = (await getDeficit(k.ctx, id)).total;
  if (after >= total) k.state.repayStall.set(id, now);
  else k.state.repayStall.delete(id);
  return after <= stuck;
}
