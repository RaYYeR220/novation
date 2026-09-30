'use client';

import {
  cloneElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/cn';

export interface TooltipProps {
  content: ReactNode;
  /** One focusable element. It receives aria-describedby. */
  children: ReactElement<{ 'aria-describedby'?: string }>;
  side?: 'top' | 'bottom';
  align?: 'start' | 'center' | 'end';
  /** Hover delay in ms. Keyboard focus opens at once. */
  delay?: number;
  /** Pin open (for /system and docs). */
  open?: boolean;
  className?: string;
}

/**
 * A hairline callout on a leader line, the way a drawing labels a part. Opens on hover and
 * focus, stays while the pointer is on it, and closes on Escape (WCAG 1.4.13).
 */
export function Tooltip({ content, children, side = 'top', align = 'center', delay = 300, open, className }: TooltipProps) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visible = open ?? shown;

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const later = (next: boolean, ms: number) => {
    clear();
    timer.current = setTimeout(() => setShown(next), ms);
  };
  useEffect(() => clear, []);

  useEffect(() => {
    if (!visible || open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        clear();
        setShown(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [visible, open]);

  const describedBy = [children.props['aria-describedby'], id].filter(Boolean).join(' ');

  return (
    <span
      className={cn('relative inline-flex', className)}
      onPointerEnter={() => later(true, delay)}
      onPointerLeave={() => later(false, 120)}
      onFocus={() => {
        clear();
        setShown(true);
      }}
      onBlur={() => later(false, 0)}
    >
      {cloneElement(children, { 'aria-describedby': describedBy })}
      <span
        role="tooltip"
        id={id}
        data-side={side}
        hidden={!visible}
        className={cn(
          'absolute z-40 w-max max-w-[280px] rounded-control border border-navy-600 bg-navy-950 px-s3 py-s2',
          'text-t13 text-navy-50 motion-safe:animate-[ui-enter_var(--duration-fast)_var(--ease-out)]',
          // The leader: a hairline from the panel back to a node on the trigger. It also bridges the gap for the pointer.
          'before:absolute before:h-3 before:w-px before:bg-navy-400',
          'after:absolute after:size-[7px] after:rounded-full after:border after:border-navy-400 after:bg-navy-900',
          side === 'top'
            ? 'bottom-[calc(100%+14px)] before:top-full after:top-[calc(100%+10px)]'
            : 'top-[calc(100%+14px)] before:bottom-full after:bottom-[calc(100%+10px)]',
          align === 'center' && 'left-1/2 -translate-x-1/2 before:left-1/2 after:left-[calc(50%-3px)]',
          align === 'start' && 'left-0 before:left-s4 after:left-[13px]',
          align === 'end' && 'right-0 before:right-s4 after:right-[13px]',
        )}
      >
        {content}
      </span>
    </span>
  );
}
