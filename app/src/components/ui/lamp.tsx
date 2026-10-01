import { cn } from '@/lib/cn';

export type LampTone = 'cyan' | 'navy-50' | 'navy-200' | 'navy-400' | 'loss-1' | 'loss-2' | 'loss-3' | 'gain-2' | 'zero';

const TONE: Record<LampTone, string> = {
  cyan: '[--lamp:var(--color-cyan)]',
  'navy-50': '[--lamp:var(--color-navy-50)]',
  'navy-200': '[--lamp:var(--color-navy-200)]',
  'navy-400': '[--lamp:var(--color-navy-400)]',
  'loss-1': '[--lamp:var(--color-loss-1)]',
  'loss-2': '[--lamp:var(--color-loss-2)]',
  'loss-3': '[--lamp:var(--color-loss-3)]',
  'gain-2': '[--lamp:var(--color-gain-2)]',
  zero: '[--lamp:var(--color-zero)]',
};

export interface LampProps {
  tone?: LampTone;
  /** `lit` is a filled dot with a faint halo; `ring` is an unlit outline (closed, idle). */
  state?: 'lit' | 'ring';
  size?: 6 | 8 | 10;
  className?: string;
}

/** The circle that marks state across the system: session chips, the segmented switch, refusals, toasts. */
export function Lamp({ tone = 'navy-200', state = 'lit', size = 8, className }: LampProps) {
  return (
    <span
      aria-hidden="true"
      data-lamp={state}
      className={cn(
        'inline-block shrink-0 rounded-full',
        TONE[tone],
        size === 6 && 'size-1.5',
        size === 8 && 'size-2',
        size === 10 && 'size-2.5',
        state === 'lit'
          ? 'bg-(--lamp) shadow-[0_0_0_3px_color-mix(in_oklab,var(--lamp)_22%,transparent)]'
          : 'border-[1.5px] border-(--lamp)',
        className,
      )}
    />
  );
}
