'use client';

import {
  createContext,
  use,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/cn';

interface TabsContextValue {
  baseId: string;
  value: string | undefined;
  /** `automatic` selects on arrow keys; `manual` moves focus and waits for Enter or Space. */
  activation: 'automatic' | 'manual';
  select: (value: string) => void;
  /** Values that have a mounted TabPanel; a tab only points aria-controls at a panel that exists. */
  panels: ReadonlySet<string>;
  registerPanel: (value: string) => () => void;
  /** When no enabled tab is selected, the first enabled tab holds the tab stop. */
  fallbackStop: string | undefined;
  setFallbackStop: (value: string | undefined) => void;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabs(part: string): TabsContextValue {
  const ctx = use(TabsContext);
  if (!ctx) throw new Error(`${part} must be inside Tabs`);
  return ctx;
}

const slug = (v: string) => v.replace(/[^a-zA-Z0-9_-]/g, '_');
const tabId = (base: string, v: string) => `${base}-tab-${slug(v)}`;
const panelId = (base: string, v: string) => `${base}-panel-${slug(v)}`;

export interface TabsProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  activation?: 'automatic' | 'manual';
  className?: string;
  children: ReactNode;
}

export function Tabs({ value, defaultValue, onValueChange, activation = 'automatic', className, children }: TabsProps) {
  const baseId = useId();
  const [inner, setInner] = useState(defaultValue);
  const current = value ?? inner;
  const [panels, setPanels] = useState<ReadonlySet<string>>(() => new Set());
  const [fallbackStop, setFallbackStop] = useState<string | undefined>(undefined);
  const select = (next: string) => {
    if (value === undefined) setInner(next);
    onValueChange?.(next);
  };
  const registerPanel = useCallback((v: string) => {
    setPanels((p) => new Set(p).add(v));
    return () =>
      setPanels((p) => {
        const n = new Set(p);
        n.delete(v);
        return n;
      });
  }, []);
  return (
    <TabsContext value={{ baseId, value: current, activation, select, panels, registerPanel, fallbackStop, setFallbackStop }}>
      <div className={className}>{children}</div>
    </TabsContext>
  );
}

export interface TabListProps extends ComponentProps<'div'> {
  /** Required unless `aria-labelledby` is given. */
  'aria-label'?: string;
}

export function TabList({ className, children, onKeyDown, ref, ...rest }: TabListProps) {
  const ctx = useTabs('TabList');
  const listRef = useRef<HTMLDivElement | null>(null);
  const { setFallbackStop } = ctx;

  // Keep the list reachable by Tab when nothing (or only a disabled tab) is selected.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const selected = list.querySelector('[role="tab"][aria-selected="true"]:not(:disabled)');
    const first = list.querySelector<HTMLElement>('[role="tab"]:not(:disabled)');
    setFallbackStop(selected ? undefined : first?.dataset.value);
  });

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'));
    const at = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0 || tabs.length === 0) return;
    let next = -1;
    if (e.key === 'ArrowRight') next = (at + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (at - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const target = tabs[next];
    if (!target) return;
    target.focus();
    if (ctx.activation === 'automatic' && target.dataset.value) ctx.select(target.dataset.value);
  };

  return (
    <div
      ref={(node) => {
        listRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      }}
      role="tablist"
      aria-orientation="horizontal"
      className={cn('flex flex-wrap gap-x-s5 border-b border-navy-700', className)}
      onKeyDown={handleKeyDown}
      {...rest}
    >
      {children}
    </div>
  );
}

export interface TabProps extends Omit<ComponentProps<'button'>, 'value'> {
  value: string;
  /** Tabular count shown after the label, e.g. open positions. */
  count?: number;
}

export function Tab({ value, count, disabled, className, children, onClick, ...rest }: TabProps) {
  const ctx = useTabs('Tab');
  const selected = ctx.value === value;
  return (
    <button
      type="button"
      role="tab"
      id={tabId(ctx.baseId, value)}
      aria-controls={ctx.panels.has(value) ? panelId(ctx.baseId, value) : undefined}
      aria-selected={selected}
      tabIndex={selected || ctx.fallbackStop === value ? 0 : -1}
      disabled={disabled}
      data-value={value}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) ctx.select(value);
      }}
      className={cn(
        'relative flex h-10 shrink-0 items-center gap-s2 rounded-t-control text-t15 font-medium',
        'transition-colors duration-(--duration-fast) ease-out',
        'after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:transition-colors after:duration-(--duration-fast)',
        selected ? 'text-navy-50 after:bg-navy-50' : 'text-navy-200 after:bg-transparent ui-hover:text-navy-50 ui-hover:after:bg-navy-600',
        'disabled:cursor-not-allowed disabled:text-navy-400',
        className,
      )}
      {...rest}
    >
      {children}
      {count !== undefined && (
        <span className="text-t13 font-normal tabular-nums text-navy-200">{count}</span>
      )}
    </button>
  );
}

export interface TabPanelProps extends ComponentProps<'div'> {
  value: string;
}

export function TabPanel({ value, className, children, ...rest }: TabPanelProps) {
  const ctx = useTabs('TabPanel');
  const { registerPanel } = ctx;
  const selected = ctx.value === value;
  useEffect(() => registerPanel(value), [registerPanel, value]);
  return (
    <div
      role="tabpanel"
      id={panelId(ctx.baseId, value)}
      aria-labelledby={tabId(ctx.baseId, value)}
      tabIndex={0}
      hidden={!selected}
      className={cn('pt-s4 outline-offset-4', className)}
      {...rest}
    >
      {selected ? children : null}
    </div>
  );
}
