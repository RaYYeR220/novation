import type { ReactNode } from 'react';
import { refusalCopy } from '@/components/app/refusal-card';
import { Lamp } from '@/components/ui/lamp';
import type { AgentGrant, FeedRefusal } from '@/lib/client/types';
import { fmtAddress, fmtAgo, fmtNumber } from '@/lib/format';
import { fmtEt } from '@/lib/nyse';
import { explorerTx } from '@/lib/wallet/chains';

/** A link to the refused transaction. Demo hashes are a repeated byte and say so. */
export function TxLink({ hash, demo }: { hash: string; demo: boolean }) {
  return (
    <a
      href={explorerTx(hash)}
      target="_blank"
      rel="noreferrer"
      className="rounded-[2px] text-t13 text-navy-50 underline decoration-navy-400 underline-offset-4 transition-colors duration-(--duration-fast) ui-hover:decoration-cyan"
    >
      Transaction {fmtAddress(hash)}
      {demo && <span className="text-navy-200"> (demo hash, not on chain)</span>}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function who(r: FeedRefusal, agents: AgentGrant[]): string {
  const agent = r.agent ? agents.find((a) => a.agent.toLowerCase() === r.agent!.toLowerCase())?.label ?? fmtAddress(r.agent) : undefined;
  if (r.account !== undefined) return `Account ${r.account}${agent ? `, signed by ${agent}` : ''}`;
  if (r.vault) return `Vault ${fmtAddress(r.vault)}`;
  return 'A wallet';
}

function haltLine(r: FeedRefusal & { haltReason?: string; effectiveAt?: number }): ReactNode {
  if (r.haltReason === 'multiplier' && r.effectiveAt)
    return <>NVDA was halted: its multiplier change took effect {fmtEt(r.effectiveAt)}, and the hub halts from 24 h before until 1 h after.</>;
  return null;
}

/** Refusals across the protocol, newest first: what was tried, which rule refused it, and the numbers. */
export function RefusalFeed({ items, agents, asOf, demo }: { items: FeedRefusal[]; agents: AgentGrant[]; asOf: number; demo: boolean }) {
  return (
    <ol className="grid" aria-label="Refusals, newest first">
      {items.map((r) => {
        const agent = r.agent ? agents.find((a) => a.agent.toLowerCase() === r.agent!.toLowerCase())?.label : undefined;
        const c = refusalCopy(r, who(r, agents), agent);
        const halt = haltLine(r as FeedRefusal & { haltReason?: string; effectiveAt?: number });
        return (
          <li key={`${r.at}-${r.code}`} data-code={r.code} className="relative grid gap-s2 border-l border-navy-700 pb-s6 pl-s5 last:pb-0 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-s5">
            <span aria-hidden="true" className="absolute -left-[5px] top-1.5 size-[9px] rounded-full bg-loss-3 ring-4 ring-navy-900" />
            <p className="grid content-start gap-0.5 text-t13 tabular-nums">
              <span className="text-navy-50">{fmtEt(r.at)}</span>
              <span className="text-navy-200">{fmtAgo(r.at, asOf)}</span>
            </p>
            <div className="grid min-w-0 gap-s2">
              <p className="flex flex-wrap items-center gap-x-s3 gap-y-1 text-t12 text-navy-200">
                <span className="flex items-center gap-s2 font-semibold text-navy-50">
                  <Lamp tone="loss-3" size={6} />
                  Refused
                </span>
                <span className="font-medium">{r.code}</span>
                {r.detail && <span>{r.detail}</span>}
              </p>
              <h3 className="font-display text-[20px] leading-snug font-normal text-balance text-navy-50">{c.reason}</h3>
              <p className="max-w-[78ch] text-t13 text-pretty text-navy-200">{halt ?? c.context}</p>
              {c.breach && (
                <dl className="flex flex-wrap gap-x-s6 gap-y-s1 text-t13 tabular-nums">
                  {[
                    { k: c.breach.attempted.label, v: c.breach.attempted.value },
                    { k: c.breach.limit.label, v: c.breach.limit.value },
                    { k: c.breach.gapLabel ?? 'Over by', v: c.breach.attempted.value - c.breach.limit.value },
                  ].map((x, i) => (
                    <div key={x.k} className="flex items-baseline gap-s2">
                      <dt className="text-navy-200">{x.k}</dt>
                      <dd className={i === 2 ? 'font-medium text-loss-1' : 'font-medium text-navy-50'}>
                        {fmtNumber(x.v)}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              {r.txHash && <TxLink hash={r.txHash} demo={demo} />}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
