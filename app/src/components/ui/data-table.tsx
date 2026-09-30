'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Skeleton } from './skeleton';

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Numbers align to the right edge, header included. */
  numeric?: boolean;
  /** Cell content. Defaults to `String(row[key])`. */
  cell?: (row: T) => ReactNode;
  /** CSS width, e.g. "8rem". */
  width?: string;
  /** Visually hidden header, for icon or marker columns. */
  hideHeader?: boolean;
}

export interface DataTableProps<T> {
  caption: string;
  showCaption?: boolean;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Makes rows focusable (roving tabindex, arrows, Home, End) and Enter or Space activate them. */
  onRowActivate?: (row: T) => void;
  /** Marks the current row (for example the open ticket). */
  currentKey?: string;
  /** Scroll height for long tables; the head stays pinned. */
  maxHeight?: number;
  loading?: boolean;
  loadingRows?: number;
  empty?: ReactNode;
  error?: ReactNode;
  /** For /system: pin a row's hover or focus look. */
  forceRow?: { key: string; state: 'hover' | 'focus' };
  className?: string;
}

export function DataTable<T>({
  caption,
  showCaption = false,
  columns,
  rows,
  rowKey,
  onRowActivate,
  currentKey,
  maxHeight,
  loading = false,
  loadingRows = 4,
  empty = 'Nothing here yet.',
  error,
  forceRow,
  className,
}: DataTableProps<T>) {
  const captionId = useId();
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  // A table that overflows its box (narrow screens) must be reachable by keyboard to scroll.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      setOverflowing(el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
    });
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, []);
  const keys = rows.map(rowKey);
  const [focusKey, setFocusKey] = useState<string | undefined>(undefined);
  // The one row in the tab order: the last focused, else the current, else the first. A key that
  // has left the rows is skipped so the table never drops out of the tab order.
  const tabStop = [focusKey, currentKey].find((k) => k !== undefined && keys.includes(k)) ?? keys[0];
  const interactive = Boolean(onRowActivate) && !loading && !error;

  const moveFocus = (e: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    const list = Array.from(bodyRef.current?.querySelectorAll<HTMLTableRowElement>('tr[data-key]') ?? []);
    const at = list.indexOf(e.currentTarget);
    let next = -1;
    if (e.key === 'ArrowDown') next = Math.min(list.length - 1, at + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, at - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onRowActivate?.(row);
      return;
    }
    if (next < 0) return;
    e.preventDefault();
    list[next]?.focus();
  };

  const colSpan = columns.length;
  const scrolls = maxHeight !== undefined || overflowing;

  return (
    <div
      ref={wrapRef}
      role={scrolls ? 'region' : undefined}
      aria-labelledby={scrolls ? captionId : undefined}
      tabIndex={scrolls && !interactive ? 0 : undefined}
      className={cn('relative overflow-auto rounded-control', className)}
      style={maxHeight !== undefined ? { maxHeight } : undefined}
    >
      <table aria-busy={loading || undefined} className="w-full border-separate border-spacing-0 text-t13 tabular-nums">
        <caption
          id={captionId}
          className={showCaption ? 'pb-s3 text-left text-t15 font-medium text-navy-50' : 'sr-only'}
        >
          {caption}
        </caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                style={c.width ? { width: c.width } : undefined}
                className={cn(
                  'sticky top-0 z-10 h-9 border-b border-navy-700 bg-navy-900 px-s3 align-middle text-t12 font-medium text-navy-200',
                  'first:pl-s4 last:pr-s4',
                  c.numeric ? 'text-right' : 'text-left',
                )}
              >
                {c.hideHeader ? <span className="sr-only">{c.header}</span> : c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody ref={bodyRef}>
          {loading &&
            Array.from({ length: loadingRows }, (_, i) => (
              <tr key={`sk-${i}`}>
                {columns.map((c, j) => (
                  <td key={c.key} className="h-9 border-b border-navy-800 px-s3 first:pl-s4 last:pr-s4">
                    <Skeleton className={cn('h-2.5', c.numeric ? 'ml-auto w-2/3' : j === 0 ? 'w-4/5' : 'w-2/3')} />
                  </td>
                ))}
              </tr>
            ))}
          {loading && (
            <tr className="sr-only">
              <td colSpan={colSpan}>Loading {caption.toLowerCase()}</td>
            </tr>
          )}
          {!loading && error && (
            <tr>
              <td colSpan={colSpan} className="h-18 border-b border-navy-800 px-s4 text-t13 text-loss-1">
                {error}
              </td>
            </tr>
          )}
          {!loading && !error && rows.length === 0 && (
            <tr>
              <td colSpan={colSpan} className="h-18 border-b border-navy-800 px-s4 text-t13 text-navy-200">
                {empty}
              </td>
            </tr>
          )}
          {!loading &&
            !error &&
            rows.map((row) => {
              const key = rowKey(row);
              const current = key === currentKey;
              const force = forceRow?.key === key ? forceRow.state : undefined;
              return (
                <tr
                  key={key}
                  data-key={key}
                  data-force={force}
                  aria-current={current || undefined}
                  tabIndex={interactive ? (key === tabStop ? 0 : -1) : undefined}
                  onFocus={interactive ? () => setFocusKey(key) : undefined}
                  onKeyDown={interactive ? (e) => moveFocus(e, row) : undefined}
                  onClick={interactive ? () => onRowActivate?.(row) : undefined}
                  className={cn(
                    'group/row outline-offset-[-2px]',
                    interactive && 'cursor-pointer',
                    current ? 'bg-navy-800' : interactive && 'ui-hover:bg-navy-800/60',
                  )}
                >
                  {columns.map((c, j) => (
                    <td
                      key={c.key}
                      className={cn(
                        'h-9 whitespace-nowrap border-b border-navy-800 px-s3 align-middle text-navy-50',
                        'first:pl-s4 last:pr-s4',
                        c.numeric && 'text-right',
                        j === 0 && current && 'shadow-[inset_2px_0_0_var(--color-cyan)]',
                      )}
                    >
                      {c.cell ? c.cell(row) : String((row as Record<string, unknown>)[c.key] ?? '')}
                    </td>
                  ))}
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}
