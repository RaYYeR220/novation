import Link from 'next/link';
import type { ScenarioGrid } from '@/lib/client/types';
import { cn } from '@/lib/cn';
import { CrownMark } from './glyphs';
import { HeroCrown } from './hero-crown';
import { PageGrid, Ref, TEXT_LINK, WRAP } from './parts';
import { LINKS } from './site';

/** The one primary action of the page: the E3 key with its ringed dot. */
export const CTA =
  'inline-flex h-13 items-center gap-s3 whitespace-nowrap rounded-control bg-navy-50 pl-s5 pr-[26px] text-base font-semibold text-navy-950 ' +
  'transition-[background-color,box-shadow] duration-(--duration-fast) hover:bg-navy-0 hover:shadow-[inset_0_-2px_0_var(--color-navy-200)] active:bg-navy-200 active:shadow-none';

export function CtaDot() {
  return (
    <span
      aria-hidden="true"
      className="relative inline-block size-3.5 shrink-0 rounded-full border-2 border-current after:absolute after:inset-0.5 after:rounded-full after:bg-current"
    />
  );
}

export const US_NOTE = 'Stock tokens are not available to US persons.';

const NAV = [
  { href: '#how-it-works', label: 'How it clears' },
  { href: '#gas', label: 'Gas' },
  { href: '#when-it-breaks', label: 'Defaults' },
  { href: '#sources', label: 'Sources' },
];

function LandingHeader() {
  return (
    <header className={cn(WRAP, 'relative z-10 flex h-16 shrink-0 items-center justify-between border-b border-navy-50/[0.06]')}>
      <Link href="/" className="-ml-1 flex items-center gap-s3 rounded-control px-1 py-1" aria-label="Novation, home">
        <CrownMark size={26} />
        <span className="font-display text-[22px] font-bold tracking-[-0.01em]">Novation</span>
      </Link>
      <nav aria-label="Sections" className="hidden md:block">
        <ul className="flex items-center gap-s6 text-t13 text-navy-200">
          {NAV.map((n) => (
            <li key={n.href}>
              <a href={n.href} className="rounded-[2px] py-1 transition-colors duration-(--duration-fast) hover:text-navy-50">
                {n.label}
              </a>
            </li>
          ))}
          {LINKS.github ? (
            <li>
              <a href={LINKS.github} className="rounded-[2px] py-1 transition-colors duration-(--duration-fast) hover:text-navy-50">
                GitHub
              </a>
            </li>
          ) : null}
        </ul>
      </nav>
    </header>
  );
}

export interface HeroProps {
  grids: { REGULAR: ScenarioGrid; WEEKEND: ScenarioGrid };
  ims: { REGULAR: number; WEEKEND: number };
}

export function Hero({ grids, ims }: HeroProps) {
  return (
    <section aria-labelledby="claim" className="relative isolate flex flex-col lg:h-svh lg:max-h-[1120px] lg:min-h-[660px]">
      <PageGrid />
      <LandingHeader />
      <div className={cn(WRAP, 'flex flex-1 flex-col lg:min-h-0')}>
        <h1
          id="claim"
          className="pt-s6 md:pt-s7 lg:pt-[clamp(36px,7.5vh,96px)] text-[length:clamp(40px,min(6.2vw,10.6vh),92px)] leading-[0.98] text-navy-50"
        >
          The other side of every trade, <span className="lg:block">
            <span className="whitespace-nowrap">stress-tested</span> first.
          </span>
        </h1>

        <div className="mt-s5 grid grid-cols-1 gap-s4 pb-s7 md:mt-s6 md:gap-s6 lg:mt-[clamp(24px,4vh,48px)] lg:min-h-0 lg:flex-1 lg:grid-cols-6 lg:grid-rows-[minmax(0,1fr)] lg:gap-0 lg:pb-s5">
          <div className="lg:col-span-2 lg:pr-s7">
            <p className="max-w-[40ch] text-t17 text-pretty text-navy-200 md:text-t20 md:leading-[1.5]">
              Novation clears options on Robinhood Chain stock tokens, re-pricing both sides’ whole books across 39 scenarios{' '}
              <span className="whitespace-nowrap">on-chain</span> before any trade settles in USDG.
            </p>
            <div className="mt-s6 flex flex-wrap items-center gap-x-s6 gap-y-s4">
              <Link href="/app/trade" className={CTA}>
                <CtaDot />
                Open the app
              </Link>
              <a href={LINKS.riskModel || '#how-it-works'} className={cn(TEXT_LINK, 'text-t15 font-medium')}>
                Read the risk model
              </a>
            </div>
            <p className="mt-s5 text-t13 text-navy-200">
              {US_NOTE}
              <Ref id="issuer" />
            </p>
          </div>

          <div className="hero-crown relative -mx-s2 h-[calc((min(100vw,640px)-16px)/1.5+64px)] md:mx-0 lg:col-span-4 lg:h-auto lg:min-h-0">
            <HeroCrown grids={grids} ims={ims} className="h-full" />
          </div>
        </div>
      </div>
    </section>
  );
}
