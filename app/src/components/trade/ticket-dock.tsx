'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { useMedia } from '@/lib/use-media';

export interface TicketDockProps {
  /** A ticket is open: on phones the sheet shows its handle. */
  active: boolean;
  /** Phones only: the sheet is pulled up. */
  expanded: boolean;
  onExpandedChange: (open: boolean) => void;
  /** One line on the handle: the ticket and its margin after. */
  summary: ReactNode;
  children: ReactNode;
}

/**
 * Where the ticket lives. From 900px it is a sticky column beside the chain. Below that it is a
 * bottom sheet: a handle with the ticket's one-line summary, pulled up to 88% of the screen.
 * Escape or the handle puts it back; a collapsed sheet is inert, so focus never lands off screen.
 */
export function TicketDock({ active, expanded, onExpandedChange, summary, children }: TicketDockProps) {
  const phone = useMedia('(max-width: 899px)');
  const hidden = phone && (!active || !expanded);
  return (
    <aside
      aria-label="Order ticket"
      onKeyDown={(e) => {
        if (phone && expanded && e.key === 'Escape') {
          e.stopPropagation();
          onExpandedChange(false);
        }
      }}
      className={cn(
        'min-w-0 rounded-control border border-navy-700 bg-navy-900',
        'min-[900px]:sticky min-[900px]:top-[calc(var(--topbar)+16px)] min-[900px]:max-h-[calc(100dvh-var(--topbar)-32px)] min-[900px]:self-start min-[900px]:overflow-y-auto',
        'max-[899px]:fixed max-[899px]:inset-x-0 max-[899px]:bottom-0 max-[899px]:z-40 max-[899px]:flex max-[899px]:max-h-[88dvh] max-[899px]:flex-col',
        'max-[899px]:rounded-b-none max-[899px]:border-x-0 max-[899px]:border-b-0 max-[899px]:border-navy-600 max-[899px]:bg-navy-950',
        'max-[899px]:transition-transform max-[899px]:duration-(--duration-base) max-[899px]:ease-out',
        !active ? 'max-[899px]:invisible max-[899px]:translate-y-full' : !expanded ? 'max-[899px]:translate-y-[calc(100%-64px)]' : 'max-[899px]:translate-y-0',
      )}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => onExpandedChange(!expanded)}
        tabIndex={phone && active ? 0 : -1}
        aria-hidden={!phone || !active || undefined}
        className="relative flex h-16 shrink-0 items-center gap-s3 border-b border-navy-700 px-s4 text-left min-[900px]:hidden"
      >
        <span aria-hidden="true" className="absolute left-1/2 top-1.5 h-1 w-9 -translate-x-1/2 rounded-full bg-navy-600" />
        <span className="min-w-0 flex-1">{summary}</span>
        <span className="shrink-0 text-t13 font-medium text-navy-50">{expanded ? 'Hide' : 'Open'}</span>
      </button>
      <div inert={hidden || undefined} className="max-[899px]:min-h-0 max-[899px]:flex-1 max-[899px]:overflow-y-auto">
        {children}
      </div>
    </aside>
  );
}
