import type { ReactNode } from 'react';
import { WaterfallDiagram } from '@/components/charts/WaterfallDiagram';
import { Lamp } from '@/components/ui/lamp';
import { cn } from '@/lib/cn';
import { fmtNumber } from '@/lib/format';
import { Fig, Ref, SectionHead, TEXT_LINK, WRAP } from './parts';
import { PROOF_TX, txUrl } from './site';

export interface BreaksProps {
  /** Demo account 7's initial margin in a regular session and over a weekend. */
  ims: { REGULAR: number; WEEKEND: number };
  /** The refused agent ticket. */
  agent: { label: string; worstLoss: number; budget: number };
}

interface Refusal {
  name: string;
  body: ReactNode;
  proof: string;
}

export function Breaks({ ims, agent }: BreaksProps) {
  const refusals: Refusal[] = [
    {
      name: 'Weekend widening',
      body: (
        <>
          From Friday 20:00 ET to Sunday 20:00 ET every shock is 1.75× wider. The same demo book needs{' '}
          <Fig id="demo">{fmtNumber(ims.REGULAR)}</Fig> USDG of initial margin on a weekday and <Fig id="demo">{fmtNumber(ims.WEEKEND)}</Fig> over
          the weekend, so a trade that clears on Friday can be refused on Saturday.
          <Ref id="demo" />
        </>
      ),
      proof: PROOF_TX.weekend,
    },
    {
      name: 'Corporate-action halt',
      body: 'When the token issuer pauses its oracle for a split or a dividend, the underlying is halted. Opening trades revert; trades that only reduce risk still clear.',
      proof: PROOF_TX.corporateAction,
    },
    {
      name: 'Stale-feed halt',
      body: 'A price older than its session’s limit halts the underlying the same way, and auctions on it wait for a fresh round.',
      proof: PROOF_TX.staleFeed,
    },
    {
      name: 'Over-budget agent',
      body: (
        <>
          {agent.label} tried to sell 60 NVDA 200 calls for account 7. The worst case after the trade was{' '}
          <Fig id="demo">{fmtNumber(agent.worstLoss)}</Fig> USDG against a <Fig id="demo">{fmtNumber(agent.budget)}</Fig> budget. It reverted
          with AgentRiskBudgetExceeded.
          <Ref id="demo" />
        </>
      ),
      proof: PROOF_TX.agentBudget,
    },
  ];

  return (
    <section aria-labelledby="when-it-breaks">
      <SectionHead id="when-it-breaks" title="When something breaks">
        <p>Most failures are refused before they can happen. The ones that get through walk a fixed order, on-chain.</p>
      </SectionHead>
      <div className={cn(WRAP, 'mt-s8 grid gap-s9 md:mt-s9 lg:grid-cols-6 lg:gap-0')}>
        <div className="reveal lg:col-span-3 lg:pr-s8">
          <h3 className="text-[26px] leading-[1.15] text-navy-50">If an account defaults</h3>
          <WaterfallDiagram className="mt-s6" />
        </div>
        <div className="reveal lg:col-span-3 lg:border-l lg:border-navy-50/10 lg:pl-s8">
          <h3 className="text-[26px] leading-[1.15] text-navy-50">Refused before it can break</h3>
          <ul className="mt-s6">
            {refusals.map((r) => (
              <li key={r.name} className="border-t border-navy-50/10 py-s5 first:border-t-0 first:pt-s1">
                <p className="flex items-center gap-s3 text-t17 font-semibold text-navy-50">
                  <Lamp tone="loss-3" size={8} />
                  {r.name}
                </p>
                <p className="mt-s2 max-w-[52ch] text-t15 text-navy-200">{r.body}</p>
                {r.proof ? (
                  <a href={txUrl(r.proof)} className={cn(TEXT_LINK, 'mt-s3 inline-block text-t13 font-medium')}>
                    Proof transaction
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
