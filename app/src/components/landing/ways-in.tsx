import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { fmtNumber } from '@/lib/format';
import { AgentGlyph, RfqGlyph, VaultGlyph } from './glyphs';
import { Fig, Ref, SectionHead, TEXT_LINK, WRAP } from './parts';

export interface WaysInProps {
  /** The demo agent's budget and what it has used, in USDG. */
  agent: { label: string; budget: number; used: number };
}

interface Way {
  name: string;
  line: string;
  body: ReactNode;
  glyph: ReactNode;
  href: string;
  link: string;
}

export function WaysIn({ agent }: WaysInProps) {
  const ways: Way[] = [
    {
      name: 'Vaults',
      line: 'Earn premium on stock tokens you already hold.',
      body: (
        <>
          Covered-call and put-write vaults write options against deposited stock tokens or USDG. Deposits and withdrawals price at live{' '}
          <span className="whitespace-nowrap">mark-to-market</span>, so nobody enters or leaves at a stale value.
        </>
      ),
      glyph: <VaultGlyph />,
      href: '/app/earn',
      link: 'See the vaults',
    },
    {
      name: 'RFQ desk',
      line: 'Market makers quote; the clearinghouse enforces.',
      body: 'Quotes are signed EIP-712 messages. When a taker fills one, both sides pass the margin check inside the same transaction, or nothing moves.',
      glyph: <RfqGlyph />,
      href: '/app/trade',
      link: 'Trade on the desk',
    },
    {
      name: 'Agents',
      line: 'A risk budget, not a spending limit.',
      body: (
        <>
          Grant an agent a maximum scenario loss on your account. The demo’s {agent.label} has{' '}
          <Fig id="demo">{fmtNumber(agent.used, 0)}</Fig> of a <Fig id="demo">{fmtNumber(agent.budget, 0)}</Fig> USDG budget in use; a ticket
          that would push the worst case past it reverts on-chain.
          <Ref id="demo" />
        </>
      ),
      glyph: <AgentGlyph used={agent.used / agent.budget} />,
      href: '/app/agents',
      link: 'Set an agent’s budget',
    },
  ];

  return (
    <section aria-labelledby="ways-in">
      <SectionHead id="ways-in" title="Three ways in" />
      <ol className={cn(WRAP, 'mt-s8 md:mt-s9')}>
        {ways.map((w, i) => (
          <li
            key={w.name}
            className="reveal relative grid grid-cols-[96px_1fr] gap-x-s5 py-s6 md:grid-cols-6 md:gap-x-0 md:py-s7"
            style={{ '--off': `calc(${i} * 100% / 6)` } as CSSProperties}
          >
            {/* the rule steps in a column per way, so the list reads as a staircase */}
            <span aria-hidden="true" className="absolute top-0 right-0 left-0 h-px bg-navy-50/10 md:left-(--off)" />
            <div className={cn('pt-1', i === 1 && 'md:col-start-2', i === 2 && 'md:col-start-3')}>{w.glyph}</div>
            <div className="md:col-span-3 md:pl-s5">
              <h3 className="text-[length:clamp(26px,2.8vw,36px)] leading-[1.08] text-navy-50">{w.name}</h3>
              <p className="mt-s2 text-t17 font-medium text-navy-50">{w.line}</p>
              <p className="mt-s3 max-w-[54ch] text-t15 text-navy-200">{w.body}</p>
              <Link href={w.href} className={cn(TEXT_LINK, 'mt-s4 inline-block text-t15 font-medium')}>
                {w.link}
              </Link>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
