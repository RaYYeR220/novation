import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Fig, Ref, SectionHead, WRAP } from './parts';

interface Statement {
  claim: ReactNode;
  detail: ReactNode;
}

const STATEMENTS: Statement[] = [
  {
    claim: (
      <>
        <Fig id="tokens">195</Fig> stock tokens are live on Robinhood Chain.
        <Ref id="tokens" /> None of them can be hedged with an option on-chain.
      </>
    ),
    detail: 'A holder can sell the token or keep it. There is no on-chain put to cap the downside and no call to write against it for income.',
  },
  {
    claim: (
      <>
        Stock tokens are about <Fig id="tvl">$125M</Fig> of the chain’s <Fig id="tvl">$1.0B</Fig> in value locked.
        <Ref id="tvl" />
      </>
    ),
    detail: 'Little of it does any work beyond being held or swapped: there is nowhere on the chain to write an option against a token, or to post it as margin for one.',
  },
  {
    claim: (
      <>
        The stock market closes on Friday. The tokens keep trading.
        <Ref id="feeds" />
      </>
    ),
    detail: (
      <>
        The Chainlink equity feeds publish nothing from Friday afternoon until{' '}
        <Fig id="feeds">Sunday 20:00 ET</Fig>. Any margin system on this chain has to price that gap before it opens, not after.
      </>
    ),
  },
];

export function Problem() {
  return (
    <section aria-labelledby="problem">
      <SectionHead
        id="problem"
        title={
          <>
            The tokens are <span className="whitespace-nowrap">on-chain</span>. The hedges are not.
          </>
        }
      />
      <ol className={cn(WRAP, 'mt-s8 md:mt-s9')}>
        {STATEMENTS.map((s, i) => (
          <li key={i} className="reveal grid grid-cols-[40px_1fr] border-t border-navy-50/10 py-s6 md:grid-cols-6 md:py-s7">
            <span aria-hidden="true" className="pt-1.5 font-display text-t20 leading-none text-navy-200 md:pt-2.5">
              {i + 1}
            </span>
            <div className="md:col-span-4">
              <p className="max-w-[30ch] font-display text-[length:clamp(24px,2.6vw,34px)] leading-[1.2] tracking-[-0.01em] text-navy-50">
                {s.claim}
              </p>
              <p className="mt-s4 max-w-[56ch] text-t15 text-navy-200 md:text-t17">{s.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
