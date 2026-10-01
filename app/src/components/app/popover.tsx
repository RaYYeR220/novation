'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface PopoverProps {
  /** Names the panel for assistive tech. */
  label: string;
  /** Renders the trigger; spread the props onto a button. */
  trigger: (props: { id: string; 'aria-expanded': boolean; 'aria-controls': string; onClick: () => void }) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: 'start' | 'end';
  className?: string;
}

/**
 * A small non-modal panel under a top-bar button: the wallet menu, the account list. Opens on click,
 * takes focus to its first control, and closes on Escape (focus back to the trigger) or an outside click.
 */
export function Popover({ label, trigger, children, align = 'end', className }: PopoverProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const triggerId = `${id}-trigger`;
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) document.getElementById(triggerId)?.focus();
  };

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled)')?.focus();
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        document.getElementById(triggerId)?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, triggerId]);

  return (
    <div ref={wrap} className="relative">
      {trigger({ id: triggerId, 'aria-expanded': open, 'aria-controls': id, onClick: () => setOpen((o) => !o) })}
      <div
        ref={panel}
        id={id}
        role="dialog"
        aria-label={label}
        hidden={!open}
        onBlur={(e) => {
          // Tabbing out of the panel closes it without stealing focus back.
          if (open && e.relatedTarget && !wrap.current?.contains(e.relatedTarget as Node)) close(false);
        }}
        className={cn(
          'absolute top-[calc(100%+8px)] z-50 w-[300px] max-w-[calc(100vw-32px)] rounded-control border border-navy-600 bg-navy-950 p-s4',
          'motion-safe:animate-[ui-enter_var(--duration-fast)_var(--ease-out)]',
          align === 'end' ? 'right-0' : 'left-0',
          className,
        )}
      >
        {open && (typeof children === 'function' ? children(() => close()) : children)}
      </div>
    </div>
  );
}
