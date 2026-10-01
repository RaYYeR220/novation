'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';

export const NAV = [
  { href: '/app/trade', label: 'Trade', blurb: 'Chain, ticket, what-if margin' },
  { href: '/app/earn', label: 'Earn', blurb: 'Covered-call and put-write vaults' },
  { href: '/app/portfolio', label: 'Portfolio', blurb: 'Margin, scenarios, settlement' },
  { href: '/app/risk', label: 'Risk', blurb: 'Sessions, insurance, refusals' },
  { href: '/app/agents', label: 'Agents', blurb: 'Risk budgets for bots' },
] as const;

export function useSection() {
  const path = usePathname() ?? '';
  return NAV.find((n) => path === n.href || path.startsWith(`${n.href}/`));
}

/** The five app sections. Vertical in the rail, a single scrolling row on smaller screens. */
export function Nav({ orientation }: { orientation: 'vertical' | 'horizontal' }) {
  const current = useSection();
  const vertical = orientation === 'vertical';
  return (
    <nav aria-label="App sections" className={vertical ? '' : 'min-w-0'}>
      <ul className={cn(vertical ? 'grid gap-0.5' : 'flex gap-0.5 overflow-x-auto px-s3 [scrollbar-width:none] sm:px-s5')}>
        {NAV.map((n) => {
          const on = current?.href === n.href;
          return (
            <li key={n.href} className="shrink-0">
              <Link
                href={n.href}
                aria-current={on ? 'page' : undefined}
                className={cn(
                  'group flex items-center rounded-control transition-colors duration-(--duration-fast)',
                  vertical ? 'h-10 gap-s3 px-s3 text-t15' : 'h-9 gap-1.5 px-2.5 text-t13 font-medium',
                  on ? 'bg-navy-800 text-navy-50' : 'text-navy-200 ui-hover:bg-navy-800/60 ui-hover:text-navy-50',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'inline-block size-2 shrink-0 rounded-full',
                    on ? 'bg-cyan' : 'border-[1.5px] border-navy-400 group-hover:border-navy-200',
                  )}
                />
                {n.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
