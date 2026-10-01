import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { sourceNumber, type SourceId } from './sources';

/** The page column: 1280 max, 16px gutters on phones, 32px from tablet up. */
export const WRAP = 'mx-auto w-[min(1280px,calc(100%-32px))] md:w-[min(1280px,calc(100%-64px))]';

/** The hairline six-column page grid. Two columns on phones. */
export function PageGrid({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn('pointer-events-none absolute inset-0 -z-10 flex justify-center', className)}>
      <div className={cn(WRAP, 'grid h-full grid-cols-2 border-l border-navy-50/[0.06] md:grid-cols-6')}>
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className={cn('border-r border-navy-50/[0.06]', i > 1 && 'hidden md:block')} />
        ))}
      </div>
    </div>
  );
}

/** A footnote marker that points at the numbered source list. */
export function Ref({ id }: { id: SourceId }) {
  const n = sourceNumber(id);
  return (
    <sup className="ml-0.5 text-[0.62em] font-medium leading-none tracking-normal">
      <a
        href={`#source-${n}`}
        aria-label={`Source ${n}`}
        className="rounded-[2px] px-0.5 text-navy-200 no-underline transition-colors duration-(--duration-fast) hover:text-navy-50 hover:underline"
      >
        {n}
      </a>
    </sup>
  );
}

/** The `data-source` value for a figure: the id of its footnote. */
export const srcAttr = (id: SourceId) => `source-${sourceNumber(id)}`;

/** A figure that carries its source: `data-source` names the footnote. */
export function Fig({ id, children, className }: { id: SourceId; children: ReactNode; className?: string }) {
  return (
    <span data-source={srcAttr(id)} className={className}>
      {children}
    </span>
  );
}

/**
 * A section opener: the heading and its lede, over a band of the page grid that fades out downwards.
 * The band is the only place below the hero where the grid shows.
 */
export function SectionHead({ id, title, children, className }: { id: string; title: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <header className={cn('pt-s9 md:pt-s10', className)}>
      <div className="relative isolate">
        <PageGrid className="[mask-image:linear-gradient(to_bottom,black,transparent_70%)]" />
        <div className={cn(WRAP, 'reveal border-t border-navy-50/10 pt-s7')}>
          <h2 id={id} className="max-w-[20ch] text-[length:clamp(34px,4.2vw,56px)] leading-[1.04] text-navy-50">
            {title}
          </h2>
          {children ? <div className="mt-s5 max-w-[60ch] text-t17 text-pretty text-navy-200">{children}</div> : null}
        </div>
      </div>
    </header>
  );
}

/** A text link in the page's voice: underlined, navy-50 on hover, cyan focus ring from the tokens. */
export const TEXT_LINK =
  'rounded-[2px] text-navy-50 underline decoration-navy-400 decoration-1 underline-offset-[5px] transition-colors duration-(--duration-fast) hover:decoration-navy-50';
