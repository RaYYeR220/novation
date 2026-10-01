import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

export interface SkeletonProps extends ComponentProps<'span'> {
  shape?: 'bar' | 'circle';
}

/**
 * A placeholder block with a slow sweep (still under reduced motion). Decorative: the
 * container that is loading carries aria-busy and a text alternative.
 */
export function Skeleton({ shape = 'bar', className, ...rest }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      data-skeleton=""
      className={cn(
        'block bg-navy-800 bg-[linear-gradient(90deg,transparent_0%,var(--color-navy-700)_50%,transparent_100%)] bg-size-[200%_100%] bg-no-repeat',
        'animate-[ui-sweep_1600ms_ease-in-out_infinite]',
        shape === 'circle' ? 'rounded-full' : 'rounded-[2px]',
        className,
      )}
      {...rest}
    />
  );
}

/** Stacked text lines; the last is shorter so the block reads as a paragraph. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <span aria-hidden="true" className={cn('grid gap-s2', className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn('h-3', i === lines - 1 && lines > 1 ? 'w-3/5' : 'w-full')} />
      ))}
    </span>
  );
}
