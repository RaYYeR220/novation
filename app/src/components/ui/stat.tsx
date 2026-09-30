import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Skeleton } from './skeleton';

export interface StatDelta {
  /** Signed change. Drives the arrow and the tone. */
  value: number;
  /** Formatted change, e.g. "+1,085.35". */
  text: string;
  /** What the change is measured against, e.g. "after this trade". */
  label?: string;
  /** Which direction is good news. Margin going up is bad; equity going up is good. */
  good?: 'up' | 'down';
}

export interface StatProps {
  label: ReactNode;
  /** Formatted value. `null` renders a dash and says "not available". */
  value: string | null;
  unit?: string;
  delta?: StatDelta;
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  /** Extra context under the value (source, as-of time). */
  footnote?: ReactNode;
  className?: string;
}

function Arrow({ up }: { up: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 8 8" className={cn('size-2 shrink-0', !up && 'rotate-180')}>
      <path d="M4 1 7.5 6.5h-7Z" fill="currentColor" />
    </svg>
  );
}

function Delta({ delta }: { delta: StatDelta }) {
  const good = delta.good ?? 'up';
  const dir = delta.value > 0 ? 'up' : delta.value < 0 ? 'down' : 'flat';
  const tone = dir === 'flat' ? 'text-navy-200' : dir === good ? 'text-gain-2' : 'text-loss-1';
  const spoken = dir === 'flat' ? 'unchanged' : dir === 'up' ? 'up' : 'down';
  return (
    <dd className="flex flex-wrap items-center gap-x-s2 gap-y-0.5 text-t13">
      <span className={cn('inline-flex items-center gap-1.5 font-medium tabular-nums', tone)}>
        {dir === 'flat' ? (
          <span aria-hidden="true" className="inline-block h-px w-2 bg-current" />
        ) : (
          <Arrow up={dir === 'up'} />
        )}
        <span className="sr-only">{spoken} </span>
        {delta.text}
      </span>
      {delta.label && <span className="text-navy-200">{delta.label}</span>}
    </dd>
  );
}

const valueSize = {
  sm: 'text-t17 font-semibold',
  md: 'text-[22px] leading-7 font-semibold',
  lg: 'text-[40px] leading-[44px] font-medium tracking-[-0.02em]',
} as const;

/** A labelled figure. Numbers are tabular so a live value does not shimmy as it updates. */
export function Stat({ label, value, unit, delta, size = 'md', loading = false, footnote, className }: StatProps) {
  return (
    <dl aria-busy={loading || undefined} className={cn('grid content-start gap-s1', className)}>
      <dt className="text-t13 text-navy-200">{label}</dt>
      <dd className="flex items-baseline gap-1.5 text-navy-50">
        {loading ? (
          <>
            <Skeleton className={cn(size === 'lg' ? 'h-10 w-48' : size === 'md' ? 'h-7 w-32' : 'h-6 w-24')} />
            <span className="sr-only">Loading</span>
          </>
        ) : value === null ? (
          <>
            <span aria-hidden="true" className={cn(valueSize[size], 'text-navy-400')}>
              —
            </span>
            <span className="sr-only">Not available</span>
          </>
        ) : (
          <>
            <span className={cn(valueSize[size], 'tabular-nums')}>{value}</span>
            {unit && <span className={cn('text-navy-200', size === 'lg' ? 'text-t17' : 'text-t13')}>{unit}</span>}
          </>
        )}
      </dd>
      {!loading && delta && <Delta delta={delta} />}
      {footnote && <dd className="text-t12 text-navy-200">{footnote}</dd>}
    </dl>
  );
}
