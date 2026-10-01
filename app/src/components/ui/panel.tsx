import { useId, type ComponentProps, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface PanelProps extends Omit<ComponentProps<'section'>, 'title'> {
  title?: ReactNode;
  /** Right side of the header: an as-of time, a chip, a small action. */
  meta?: ReactNode;
  /** Heading level for the title; pick the one that fits the page outline. */
  level?: 2 | 3 | 4;
  /** `inset` sinks the panel into a darker well (readouts); `raised` lifts it one navy step. */
  tone?: 'default' | 'inset' | 'raised';
  padding?: 'none' | 'sm' | 'md';
  /** Footer row under a hairline. */
  footer?: ReactNode;
}

const tones = {
  default: 'bg-navy-900',
  inset: 'bg-navy-950',
  raised: 'bg-navy-800',
} as const;

const pads = { none: '', sm: 'p-s3', md: 'p-s5 max-sm:p-s4' } as const;

/** A 1px hairline frame with radius 4. No shadow: depth comes from the navy steps. */
export function Panel({
  title,
  meta,
  level = 2,
  tone = 'default',
  padding = 'md',
  footer,
  className,
  children,
  ...rest
}: PanelProps) {
  const titleId = useId();
  const Heading = `h${level}` as const;
  return (
    <section
      aria-labelledby={title ? titleId : undefined}
      className={cn('min-w-0 rounded-control border border-navy-700', tones[tone], className)}
      {...rest}
    >
      {(title || meta) && (
        <header className="flex min-h-12 flex-wrap items-center justify-between gap-x-s4 gap-y-s1 border-b border-navy-700 px-s5 py-s3 max-sm:px-s4">
          {title && (
            <Heading id={titleId} className="text-t20 font-normal leading-tight text-navy-50">
              {title}
            </Heading>
          )}
          {meta && <div className="flex items-center gap-s3 text-t13 text-navy-200">{meta}</div>}
        </header>
      )}
      <div className={pads[padding]}>{children}</div>
      {footer && (
        <footer className="border-t border-navy-700 px-s5 py-s3 text-t13 text-navy-200 max-sm:px-s4">{footer}</footer>
      )}
    </section>
  );
}
