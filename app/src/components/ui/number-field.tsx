'use client';

import { useId, useState, type ComponentProps, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Lamp } from './lamp';
import { Spinner } from './spinner';

export interface NumberFieldProps
  extends Omit<ComponentProps<'input'>, 'value' | 'defaultValue' | 'onChange' | 'type' | 'size' | 'min' | 'max' | 'step'> {
  label: ReactNode;
  /** Shown inside the field after the number, e.g. "USDG" or "contracts". */
  unit?: string;
  /** Raw text so partial input like "12." survives while typing. */
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  hint?: ReactNode;
  /** Validation message. Its presence sets aria-invalid. */
  error?: ReactNode;
  /** Arrow Up/Down step by this amount (Shift ×10). */
  step?: number;
  min?: number;
  max?: number;
  /** A quote is being recomputed for this value. */
  busy?: boolean;
  /** For /system: pin hover or focus on the field box. */
  'data-force'?: string;
}

const decimals = (step: number) => {
  const s = String(step);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
};

export function NumberField({
  label,
  unit,
  value,
  defaultValue = '',
  onValueChange,
  hint,
  error,
  step,
  min,
  max,
  busy = false,
  disabled,
  readOnly,
  id,
  className,
  onKeyDown,
  'data-force': force,
  ...rest
}: NumberFieldProps) {
  const autoId = useId();
  const inputId = id ?? `${autoId}-input`;
  const hintId = `${autoId}-hint`;
  const errorId = `${autoId}-error`;
  const [inner, setInner] = useState(defaultValue);
  const current = value ?? inner;

  const set = (next: string) => {
    if (value === undefined) setInner(next);
    onValueChange?.(next);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented || step === undefined || readOnly) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const n = Number.parseFloat(current.replace(/,/g, ''));
    const base = Number.isFinite(n) ? n : (min ?? 0);
    let next = base + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    set(next.toFixed(decimals(step)));
  };

  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  const invalid = Boolean(error);

  return (
    <div className={cn('grid min-w-0 grid-cols-[minmax(0,1fr)] gap-s2', className)}>
      <label htmlFor={inputId} className={cn('text-t13 font-medium', disabled ? 'text-navy-400' : 'text-navy-200')}>
        {label}
      </label>
      <div
        data-force={force}
        className={cn(
          'group flex h-10 items-center rounded-control border bg-navy-950',
          'transition-colors duration-(--duration-fast) ease-out',
          'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-cyan',
          invalid ? 'border-loss-2' : 'border-navy-600',
          !invalid && !disabled && !readOnly && 'ui-hover:border-navy-400',
          !invalid && 'has-focus-visible:border-navy-400',
          disabled && 'cursor-not-allowed border-navy-700 bg-navy-900',
          readOnly && 'border-dashed',
        )}
      >
        <input
          id={inputId}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={current}
          onChange={(e) => set(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          readOnly={readOnly}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          aria-busy={busy || undefined}
          className={cn(
            'h-full min-w-0 flex-1 bg-transparent px-s3 text-right text-t15 tabular-nums text-navy-50 outline-none',
            'placeholder:text-navy-400 disabled:cursor-not-allowed disabled:text-navy-400',
          )}
          {...rest}
        />
        {(unit || busy) && (
          <span className={cn('flex shrink-0 items-center gap-s2 pr-s3 text-t13', disabled ? 'text-navy-200/70' : 'text-navy-200')}>
            {busy && <Spinner size={12} />}
            {unit}
          </span>
        )}
      </div>
      {hint && !error && (
        <p id={hintId} className="text-t12 text-navy-200">
          {hint}
        </p>
      )}
      {hint && error && (
        <p id={hintId} className="sr-only">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="flex items-center gap-s2 text-t12 text-loss-1">
          <Lamp tone="loss-2" size={6} />
          {error}
        </p>
      )}
    </div>
  );
}
