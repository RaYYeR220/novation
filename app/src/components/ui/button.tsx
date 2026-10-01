'use client';

import type { ComponentProps, MouseEvent, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Spinner } from './spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Keeps focus and width, blocks activation, and shows the spinner. */
  loading?: boolean;
  /** Visible label while loading. Defaults to the normal label so the button does not jump. */
  loadingLabel?: ReactNode;
  /** The ringed dot from the E3 CTA. Use on the one primary action of a surface. */
  lamp?: boolean;
}

const base =
  'relative inline-flex select-none items-center justify-center gap-s2 whitespace-nowrap rounded-control font-medium ' +
  'transition-[background-color,border-color,color] duration-(--duration-fast) ease-out ' +
  'disabled:cursor-not-allowed aria-disabled:cursor-progress';

const variants: Record<ButtonVariant, string> = {
  primary:
    // Hover lifts the key with a navy lip along its bottom edge; active presses it flat.
    'bg-navy-50 text-navy-950 font-semibold ui-hover:bg-navy-0 ui-hover:shadow-[inset_0_-2px_0_var(--color-navy-200)] ' +
    'ui-active:bg-navy-200 ui-active:shadow-none disabled:bg-navy-800 disabled:text-navy-400',
  secondary:
    'border border-navy-600 bg-transparent text-navy-50 ui-hover:border-navy-400 ui-hover:bg-navy-800 ' +
    'ui-active:border-navy-200 ui-active:bg-navy-700 disabled:border-navy-700 disabled:text-navy-400',
  ghost:
    'bg-transparent text-navy-200 ui-hover:bg-navy-800 ui-hover:text-navy-50 ui-active:bg-navy-700 ' +
    'ui-active:text-navy-50 disabled:text-navy-400',
};

const sizes: Record<ButtonSize, string> = {
  sm: 'h-8 px-s3 text-t13',
  md: 'h-10 px-s4 text-t15',
  lg: 'h-13 pl-s5 pr-[26px] text-base',
};

function RingDot({ size }: { size: ButtonSize }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative inline-block shrink-0 rounded-full border-2 border-current',
        size === 'lg' ? 'size-3.5' : 'size-3',
        'after:absolute after:inset-0.5 after:rounded-full after:bg-current',
      )}
    />
  );
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  loadingLabel,
  lamp = false,
  type = 'button',
  className,
  children,
  onClick,
  ...rest
}: ButtonProps) {
  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (loading) {
      e.preventDefault();
      return;
    }
    onClick?.(e);
  };

  return (
    <button
      type={type}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      className={cn(base, variants[variant], sizes[size], className)}
      onClick={handleClick}
      {...rest}
    >
      {loading ? <Spinner size={size === 'sm' ? 12 : 14} /> : lamp ? <RingDot size={size} /> : null}
      {loading && loadingLabel ? loadingLabel : children}
    </button>
  );
}
