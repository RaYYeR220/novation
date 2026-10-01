import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** A page section's head: a Zodiak title, one plain sentence, and an aside (as-of time, an action). */
export function SectionHead({
  id,
  title,
  dek,
  aside,
  className,
}: {
  id?: string;
  title: ReactNode;
  dek?: ReactNode;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-x-s6 gap-y-s3 border-b border-navy-700 pb-s4', className)}>
      <div className="grid max-w-[68ch] gap-s1">
        <h2 id={id} className="text-[28px] leading-[1.15] font-normal text-navy-50 max-sm:text-[24px]">
          {title}
        </h2>
        {dek && <p className="text-t15 text-pretty text-navy-200">{dek}</p>}
      </div>
      {aside && <div className="flex flex-wrap items-center gap-s3 text-t13 text-navy-200">{aside}</div>}
    </div>
  );
}

/** The page body: sections stacked with air between them. */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid gap-s8 px-s4 pb-s9 pt-s6 sm:px-s5 xl:px-s6 max-sm:gap-s7', className)}>{children}</div>;
}
