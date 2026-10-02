import { formatEther } from 'viem';
import { refresh, resolvePending, type Keeper } from '../keeper';
import { why } from '../log';
import { claim } from './claim';
import { liquidations } from './liquidations';
import { listSeries } from './listSeries';
import { roll } from './roll';
import { settleAccounts } from './settleAccounts';
import { settleExpiry } from './settleExpiry';
import { syncVol } from './syncVol';

/**
 * The jobs in tick order: settlement first, then the optional upkeep (vol, listing) that the gas
 * reserve can hold back. The vol sync runs before liquidations, so the margin it reads (and an
 * auction it starts) is at the current vol, not the volCap fallback of a round not yet folded in.
 */
export const JOBS = { settleExpiry, settleAccounts, claim, roll, syncVol, liquidations, listSeries } as const;
export type JobName = keyof typeof JOBS;
export const JOB_NAMES = Object.keys(JOBS) as JobName[];


/**
 * One pass of every enabled job, in order. The state is refreshed from the chain before each job
 * (new series, new events), so a settlement sent by one job is seen by the next. A job that throws
 * is logged and the tick moves on. Returns the transactions sent.
 */
export async function tick(k: Keeper, jobs: readonly JobName[] = JOB_NAMES) {
  const t0 = Date.now();
  const first = k.txs.length;
  // a transaction left open by an earlier tick is logged as soon as it lands
  if (k.state.pending.size) await resolvePending(k).catch((e) => k.log('warn', 'tick', 'pending check failed', { reason: why(e) }));
  const balance = await k.client.getBalance({ address: k.account.address });
  // the same threshold that pauses the optional work: a warning the moment it stops
  if (balance < k.opts.gasReserve) {
    k.log('warn', 'tick', 'low balance', { keeper: k.account.address, eth: formatEther(balance), reserve: formatEther(k.opts.gasReserve), reason: 'below the gas reserve: vol sync, listing and queue rolls are paused' });
  }
  for (const name of JOB_NAMES) {
    if (!jobs.includes(name)) continue;
    try {
      await refresh(k);
      await JOBS[name](k);
    } catch (e) {
      k.log('error', name, 'failed', { reason: why(e) });
    }
  }
  const sent = k.txs.slice(first);
  k.log('info', 'tick', 'done', {
    ms: Date.now() - t0,
    txs: sent.length,
    gasUsed: sent.reduce((a, t) => a + t.gasUsed, 0n),
    eth: formatEther(balance),
    accounts: k.state.accounts.size,
    series: k.state.series.size,
  });
  return sent;
}
