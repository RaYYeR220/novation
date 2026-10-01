import Link from 'next/link';
import { Lamp } from '@/components/ui/lamp';
import type { ProtocolStats } from '@/lib/client/types';
import { cn } from '@/lib/cn';
import { fmtNumber, fmtUsd } from '@/lib/format';
import { CTA, CtaDot, US_NOTE } from './hero';
import { CrownMark } from './glyphs';
import { Ref, TEXT_LINK, WRAP, srcAttr } from './parts';
import { DEPLOYMENT, LINKS } from './site';
import { SOURCES } from './sources';

const snapshotFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

/** The protocol's own numbers in one quiet row: the only table-like data on the page. */
export function ProtocolStrip({ stats, asOf, demo }: { stats: ProtocolStats; asOf: number; demo: boolean }) {
  const items = [
    { label: 'Open interest', value: fmtUsd(stats.openInterestUsd, 0) },
    { label: 'Vault deposits', value: fmtUsd(stats.vaultTvlUsd, 0) },
    { label: 'Insurance fund', value: fmtUsd(stats.insuranceFundUsd, 0) },
    { label: 'Premium, 7 days', value: fmtUsd(stats.premium7dUsd, 0) },
    { label: 'Liquidations, 7 days', value: fmtNumber(stats.liquidations7d, 0) },
    { label: 'Loss socialized', value: fmtUsd(stats.socializedUsd, 0) },
  ];
  return (
    <section aria-labelledby="protocol" className={cn(WRAP, 'mt-s10 border-y border-navy-50/10 py-s6')} data-source={demo ? srcAttr('demo') : undefined}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-s6 gap-y-s2">
        <h2 id="protocol" className="font-text text-t15 font-semibold tracking-normal text-navy-50">
          Protocol
        </h2>
        <p className="flex items-center gap-s2 text-t13 text-navy-200">
          <Lamp tone={demo ? 'navy-200' : 'cyan'} state={demo ? 'ring' : 'lit'} size={6} />
          {demo ? `Demo snapshot, ${snapshotFmt.format(new Date(asOf * 1000))} UTC` : `As of ${snapshotFmt.format(new Date(asOf * 1000))} UTC`}
          {demo ? <Ref id="demo" /> : null}
        </p>
      </div>
      <dl className="mt-s5 grid grid-cols-2 gap-x-s5 gap-y-s5 sm:grid-cols-3 lg:grid-cols-6">
        {items.map((it) => (
          <div key={it.label}>
            <dt className="text-t13 text-navy-200">{it.label}</dt>
            <dd className="mt-1 text-t17 font-semibold text-navy-50">{it.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function Sources() {
  return (
    <section aria-labelledby="sources" className={cn(WRAP, 'mt-s9')}>
      <h2 id="sources" className="font-text text-t15 font-semibold tracking-normal text-navy-50">
        Sources
      </h2>
      <ol className="mt-s4 grid gap-x-s8 gap-y-s4 md:grid-cols-2">
        {SOURCES.map((s, i) => (
          <li key={s.id} id={`source-${i + 1}`} className="grid scroll-mt-s8 grid-cols-[24px_1fr] text-t13 text-navy-200">
            <span className="text-navy-200">{i + 1}</span>
            <span>
              {s.text}{' '}
              {s.links.map((l, k) => (
                <span key={l.href}>
                  <a href={l.href} className={cn(TEXT_LINK, 'break-words text-navy-200 hover:text-navy-50')}>
                    {l.label}
                  </a>
                  {k < s.links.length - 1 ? ', ' : null}
                </span>
              ))}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function Footer() {
  const status = DEPLOYMENT === 'mainnet' ? 'Live on Robinhood Chain' : 'Robinhood Chain testnet';
  return (
    <footer className="relative mt-s10 border-t border-navy-50/10 bg-navy-950">
      <div className={cn(WRAP, 'grid gap-s8 py-s9 md:grid-cols-6 md:gap-0')}>
        <div className="md:col-span-4">
          <p className="max-w-[18ch] font-display text-[length:clamp(32px,4vw,52px)] leading-[1.05] text-navy-50">
            See the margin before you sign.
          </p>
          <div className="mt-s6 flex flex-wrap items-center gap-x-s6 gap-y-s4">
            <Link href="/app/trade" className={CTA}>
              <CtaDot />
              Open the app
            </Link>
            <p className="text-t13 text-navy-200">{US_NOTE}</p>
          </div>
        </div>
        <nav aria-label="Elsewhere" className="md:col-span-2">
          <ul className="grid gap-s3 text-t15">
            {LINKS.github ? (
              <li>
                <a href={LINKS.github} className={TEXT_LINK}>
                  GitHub
                </a>
              </li>
            ) : null}
            {LINKS.docs ? (
              <li>
                <a href={LINKS.docs} className={TEXT_LINK}>
                  Docs
                </a>
              </li>
            ) : null}
            <li>
              <a href={LINKS.x} className={TEXT_LINK}>
                X, @rayyer_220
              </a>
            </li>
          </ul>
        </nav>
      </div>
      <div className={cn(WRAP, 'flex flex-col gap-s4 border-t border-navy-50/10 py-s5 text-t13 text-navy-200 md:flex-row md:items-center md:justify-between')}>
        <p className="flex items-center gap-s3">
          <CrownMark size={18} />
          <span>Stock tokens are not available to US persons. Novation is software, not investment advice.</span>
        </p>
        <p className="inline-flex w-max items-center gap-s2 rounded-control border border-navy-700 px-s3 py-1.5 text-t12 font-medium text-navy-50">
          <Lamp tone={DEPLOYMENT === 'mainnet' ? 'cyan' : 'navy-200'} size={6} />
          {status}
        </p>
      </div>
    </footer>
  );
}
