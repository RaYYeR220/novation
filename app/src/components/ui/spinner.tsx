import { cn } from '@/lib/cn';

/** A quarter arc on a hairline ring. Static under reduced motion. Decorative; pair it with text or aria-busy. */
export function Spinner({ size = 14, className }: { size?: 12 | 14 | 16; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={cn('shrink-0 animate-[ui-spin_900ms_linear_infinite]', className)}
    >
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeOpacity="0.28" strokeWidth="1.5" />
      <path d="M8 1.75a6.25 6.25 0 0 1 6.25 6.25" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
