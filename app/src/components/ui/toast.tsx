'use client';

import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/cn';
import { Lamp } from './lamp';
import { Spinner } from './spinner';

export type ToastTone = 'neutral' | 'done' | 'refused' | 'pending';

export interface ToastData {
  title: ReactNode;
  description?: ReactNode;
  tone?: ToastTone;
  /** A follow-up, e.g. a "View transaction" link. */
  action?: ReactNode;
  /** ms before it leaves on its own; 0 keeps it. Pending toasts default to 0. */
  duration?: number;
}

function ToneMark({ tone }: { tone: ToastTone }) {
  if (tone === 'pending') return <Spinner size={14} className="text-navy-200" />;
  if (tone === 'done')
    return (
      <svg aria-hidden="true" viewBox="0 0 14 14" className="size-3.5 shrink-0 text-navy-50">
        <circle cx="7" cy="7" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="m4.3 7.2 1.8 1.8 3.6-3.9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  return (
    <span className="flex size-3.5 shrink-0 items-center justify-center">
      <Lamp tone={tone === 'refused' ? 'loss-3' : 'navy-200'} size={8} />
    </span>
  );
}

export interface ToastProps extends Omit<ComponentProps<'div'>, 'title'>, Omit<ToastData, 'duration'> {
  onDismiss?: () => void;
}

/** One notification. Used by the viewport, and on its own in /system. */
export function Toast({ title, description, tone = 'neutral', action, onDismiss, className, ...rest }: ToastProps) {
  return (
    <div
      data-tone={tone}
      className={cn(
        'pointer-events-auto grid w-full grid-cols-[auto_1fr_auto] gap-x-s3 rounded-control border bg-navy-950 py-s3 pl-s4 pr-s2',
        tone === 'refused' ? 'border-loss-3/50' : 'border-navy-600',
        className,
      )}
      {...rest}
    >
      <span className="pt-[3px]">
        <ToneMark tone={tone} />
      </span>
      <div className="grid min-w-0 gap-0.5 py-0.5">
        <p className="text-t15 font-medium text-navy-50">{title}</p>
        {description && <p className="text-t13 text-navy-200">{description}</p>}
        {action && <div className="pt-s2">{action}</div>}
      </div>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss notification"
          className="flex size-7 items-center justify-center rounded-control text-navy-200 transition-colors duration-(--duration-fast) ui-hover:bg-navy-800 ui-hover:text-navy-50"
        >
          <svg aria-hidden="true" viewBox="0 0 12 12" className="size-3">
            <path d="m2.5 2.5 7 7m0-7-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}

interface Entry extends ToastData {
  id: number;
}

interface ToastApi {
  toast: (t: ToastData) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = use(ToastContext);
  if (!ctx) throw new Error('useToast must be inside ToastProvider');
  return ctx;
}

function TimedToast({ entry, onDismiss }: { entry: Entry; onDismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  const tone = entry.tone ?? 'neutral';
  const duration = entry.duration ?? (tone === 'pending' ? 0 : 6000);
  const left = useRef(duration);
  const started = useRef(0);

  useEffect(() => {
    if (duration === 0 || paused) return;
    started.current = Date.now();
    const t = setTimeout(() => onDismiss(entry.id), left.current);
    return () => {
      clearTimeout(t);
      left.current -= Date.now() - started.current;
    };
  }, [duration, paused, entry.id, onDismiss]);

  return (
    <li
      className="motion-safe:animate-[ui-enter_var(--duration-base)_var(--ease-out)]"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onDismiss(entry.id);
      }}
    >
      <Toast
        role={tone === 'refused' ? 'alert' : undefined}
        title={entry.title}
        description={entry.description}
        tone={tone}
        action={entry.action}
        onDismiss={() => onDismiss(entry.id)}
      />
    </li>
  );
}

/** Holds the toast queue and renders the viewport: bottom right, bottom centre on phones. Newest last. */
export function ToastProvider({ children, max = 4 }: { children: ReactNode; max?: number }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setEntries((xs) => xs.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (t: ToastData) => {
      const id = nextId.current++;
      setEntries((xs) => [...xs, { ...t, id }].slice(-max));
      return id;
    },
    [max],
  );
  const api = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext value={api}>
      {children}
      <section aria-label="Notifications" className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-end p-s4 sm:p-s6">
        <ol aria-live="polite" aria-relevant="additions" className="grid w-full gap-s2 sm:w-[380px]">
          {entries.map((e) => (
            <TimedToast key={e.id} entry={e} onDismiss={dismiss} />
          ))}
        </ol>
      </section>
    </ToastContext>
  );
}
