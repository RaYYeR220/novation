'use client';

import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface DialogSurfaceProps {
  title: ReactNode;
  titleId: string;
  description?: ReactNode;
  descriptionId?: string;
  children?: ReactNode;
  footer?: ReactNode;
  onClose?: () => void;
  className?: string;
}

/** The dialog's inside: title, text, body, and the action row. Also used for the static preview in /system. */
export function DialogSurface({ title, titleId, description, descriptionId, children, footer, onClose, className }: DialogSurfaceProps) {
  return (
    <div className={cn('grid gap-s4 p-s6 max-sm:p-s5', className)}>
      <div className="flex items-start justify-between gap-s4">
        <h2 id={titleId} className="text-[28px] leading-[1.15] font-normal text-balance text-navy-50 max-sm:text-[24px]">
          {title}
        </h2>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-s2 -mt-1 flex size-8 shrink-0 items-center justify-center rounded-control text-navy-200 transition-colors duration-(--duration-fast) ui-hover:bg-navy-800 ui-hover:text-navy-50"
          >
            <svg aria-hidden="true" viewBox="0 0 12 12" className="size-3">
              <path d="m2.5 2.5 7 7m0-7-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
      {description && (
        <p id={descriptionId} className="max-w-[60ch] text-t15 text-pretty text-navy-200">
          {description}
        </p>
      )}
      {children}
      {footer && <div className="flex flex-wrap justify-end gap-s3 border-t border-navy-700 pt-s4 max-sm:flex-col-reverse max-sm:[&>*]:w-full">{footer}</div>}
    </div>
  );
}

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Tab from the last control goes to the first and Shift+Tab from the first to the last, so focus never leaves. */
function wrapTab(e: KeyboardEvent<HTMLDialogElement>) {
  if (e.key !== 'Tab') return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.closest('[hidden]'));
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) return;
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === e.currentTarget)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** Clicking the backdrop closes. Off for confirmations that must be answered. */
  dismissible?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * A modal on the native <dialog>: top layer, inert page behind it, Escape closes, Tab wraps inside,
 * focus goes back to whatever opened it. Put `data-autofocus` on the safest action; otherwise the close button gets focus.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  dismissible = true,
  size = 'md',
  className,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  // Remember the last focus outside the dialog: by the time the effect below runs, React may
  // already have moved focus into the new content.
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target;
      if (t instanceof HTMLElement && !ref.current?.contains(t)) returnTo.current = t;
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      if (!returnTo.current && document.activeElement instanceof HTMLElement && !el.contains(document.activeElement)) {
        returnTo.current = document.activeElement;
      }
      el.showModal();
      el.querySelector<HTMLElement>('[data-autofocus]')?.focus();
      document.documentElement.style.overflow = 'hidden';
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  useEffect(
    () => () => {
      document.documentElement.style.overflow = '';
    },
    [],
  );

  const handleClose = () => {
    document.documentElement.style.overflow = '';
    const back = returnTo.current;
    if (back?.isConnected) back.focus();
    if (open) onOpenChange(false);
  };

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onClose={handleClose}
      onKeyDown={wrapTab}
      onClick={(e) => {
        if (dismissible && e.target === e.currentTarget) onOpenChange(false);
      }}
      className={cn(
        'm-auto max-h-[calc(100dvh-32px)] w-[calc(100%-32px)] overflow-auto rounded-control border border-navy-600 bg-navy-900 p-0 text-navy-50',
        'backdrop:bg-navy-950/80 open:motion-safe:animate-[ui-enter_var(--duration-base)_var(--ease-out)]',
        size === 'sm' ? 'max-w-[440px]' : 'max-w-[560px]',
        className,
      )}
    >
      {open && (
        <DialogSurface
          title={title}
          titleId={titleId}
          description={description}
          descriptionId={descriptionId}
          footer={footer}
          onClose={() => onOpenChange(false)}
        >
          {children}
        </DialogSurface>
      )}
    </dialog>
  );
}
