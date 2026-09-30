'use client';

import { createContext, use, useId, useState, type ComponentProps, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface SegmentedContextValue {
  name: string;
  value: string | undefined;
  size: 'sm' | 'md';
  disabled: boolean;
  select: (value: string) => void;
}

const SegmentedContext = createContext<SegmentedContextValue | null>(null);

export interface SegmentedControlProps {
  /** Names the group for assistive tech. Shown only when `showLegend` is set. */
  legend: string;
  showLegend?: boolean;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  name?: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * The session switch from E3: one choice out of a few, with a lamp on the chosen one.
 * Built on native radios, so Tab lands on the chosen segment and the arrow keys move and select.
 */
export function SegmentedControl({
  legend,
  showLegend = false,
  value,
  defaultValue,
  onValueChange,
  name,
  size = 'md',
  disabled = false,
  className,
  children,
}: SegmentedControlProps) {
  const autoName = useId();
  const [inner, setInner] = useState(defaultValue);
  const current = value ?? inner;
  const select = (next: string) => {
    if (value === undefined) setInner(next);
    onValueChange?.(next);
  };

  return (
    <SegmentedContext value={{ name: name ?? autoName, value: current, size, disabled, select }}>
      <fieldset disabled={disabled} className={cn('m-0 min-w-0 border-0 p-0', className)}>
        <legend className={showLegend ? 'mb-s2 text-t13 font-medium text-navy-200' : 'sr-only'}>{legend}</legend>
        <div className="inline-flex gap-s1 rounded-control bg-navy-800 p-[3px]">{children}</div>
      </fieldset>
    </SegmentedContext>
  );
}

export interface SegmentProps extends Omit<ComponentProps<'label'>, 'onChange'> {
  value: string;
  disabled?: boolean;
  children: ReactNode;
}

export function Segment({ value, disabled = false, className, children, ...rest }: SegmentProps) {
  const ctx = use(SegmentedContext);
  if (!ctx) throw new Error('Segment must be inside SegmentedControl');
  const checked = ctx.value === value;
  const off = disabled || ctx.disabled;

  return (
    <label
      data-checked={checked || undefined}
      className={cn(
        'relative flex items-center gap-s2 rounded-[3px] font-medium',
        'transition-[background-color,color] duration-(--duration-fast) ease-out',
        'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-cyan',
        ctx.size === 'md' ? 'h-[34px] pl-2.5 pr-3.5 text-t15' : 'h-7 pl-2 pr-2.5 text-t13',
        checked ? 'bg-navy-600 text-navy-50' : 'text-navy-200',
        !checked && !off && 'cursor-pointer ui-hover:bg-navy-700 ui-hover:text-navy-50',
        off && 'cursor-not-allowed text-navy-400',
        className,
      )}
      {...rest}
    >
      <input
        type="radio"
        className="sr-only"
        name={ctx.name}
        value={value}
        checked={checked}
        disabled={off}
        onChange={() => ctx.select(value)}
      />
      <span
        aria-hidden="true"
        className={cn(
          'inline-block size-2.5 shrink-0 rounded-full border-[1.5px]',
          checked ? 'border-cyan bg-cyan' : 'border-current',
        )}
      />
      {children}
    </label>
  );
}
