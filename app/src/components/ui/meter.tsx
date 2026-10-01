import { useId, type ReactNode } from 'react';
import { fmtNumber } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Lamp, type LampTone } from './lamp';
import { Skeleton } from './skeleton';

export type MeterState = 'clear' | 'restricted' | 'liquidatable';

export interface MeterProps {
  label: ReactNode;
  /** Equity, in the same unit as the datums. */
  value: number;
  /** Initial margin: below it, opening trades are refused. Drawn in cyan. */
  im: number;
  /** Maintenance margin: below it, the account can be liquidated. */
  mm: number;
  min?: number;
  /** Scale end. Defaults to a round number above the largest of value, IM and MM. */
  max?: number;
  unit?: string;
  format?: (v: number) => string;
  /** Replaces the default status line. */
  status?: ReactNode;
  loading?: boolean;
  className?: string;
}

/** The first of 1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8 (times a power of ten) at or above `v`. */
export function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    const c = Number((m * p).toPrecision(12));
    if (c >= v) return c;
  }
  return 10 * p;
}

export function meterState(value: number, im: number, mm: number): MeterState {
  if (value < mm) return 'liquidatable';
  if (value < im) return 'restricted';
  return 'clear';
}

const STATUS: Record<MeterState, { lamp: LampTone; text: string }> = {
  clear: { lamp: 'navy-200', text: 'Above initial margin. New trades can open.' },
  restricted: { lamp: 'loss-1', text: 'Below initial margin. Opening trades are refused; closing trades clear.' },
  liquidatable: { lamp: 'loss-3', text: 'Below maintenance margin. The account can be liquidated.' },
};

const FILL: Record<MeterState, string> = {
  clear: 'bg-zero',
  restricted: 'bg-loss-1',
  liquidatable: 'bg-loss-3',
};

function Datum({
  at,
  depth,
  name,
  text,
  tone,
  side,
}: {
  at: number;
  depth: 0 | 1;
  name: string;
  text: string;
  tone: 'im' | 'mm';
  /** Which side of its leader the label hangs on. */
  side: 'right' | 'left';
}) {
  return (
    <span className="absolute inset-y-0" style={{ left: `${at}%` }}>
      <span
        className={cn(
          'absolute top-0 w-px -translate-x-1/2',
          tone === 'im' ? 'bg-cyan' : 'bg-loss-1',
          depth === 0 ? 'h-7' : 'h-12',
        )}
      />
      <span
        className={cn(
          'absolute flex items-baseline gap-1 whitespace-nowrap text-t12 leading-none',
          depth === 0 ? 'top-[18px]' : 'top-[38px]',
          side === 'right' ? 'left-[6px]' : 'right-[6px]',
        )}
      >
        <span className="text-navy-200">{name}</span>
        <span className="font-medium tabular-nums text-navy-50">{text}</span>
      </span>
    </span>
  );
}

const TICKS = 20;

/**
 * Equity on a hairline scale with two datums: IM (cyan) and MM (loss-1). The scale under MM is
 * hatched so the liquidation zone reads without colour. Labels hang off leader lines at two depths,
 * so they never collide however close IM and MM sit.
 */
export function Meter({
  label,
  value,
  im,
  mm,
  min = 0,
  max,
  unit = 'USDG',
  format = (v) => fmtNumber(v),
  status,
  loading = false,
  className,
}: MeterProps) {
  const labelId = useId();
  const top = max ?? niceCeil(Math.max(value, im, mm) * 1.15);
  const span = top - min || 1;
  const pct = (v: number) => Math.min(100, Math.max(0, ((v - min) / span) * 100));
  const state = meterState(value, im, mm);
  const s = STATUS[state];
  const valuePct = pct(value);
  const imPct = pct(im);
  const mmPct = pct(mm);
  const valueText =
    `${format(value)} ${unit}. Initial margin ${format(im)}, maintenance margin ${format(mm)}. ` + s.text;

  return (
    <div className={cn('grid gap-s3', className)} aria-busy={loading || undefined}>
      <div className="flex items-baseline justify-between gap-s4">
        <span id={labelId} className="text-t13 text-navy-200">
          {label}
        </span>
        {loading ? (
          <Skeleton className="h-5 w-28" />
        ) : (
          <span className="flex items-baseline gap-1.5">
            <span className="text-t20 font-semibold tabular-nums text-navy-50">{format(value)}</span>
            <span className="text-t13 text-navy-200">{unit}</span>
          </span>
        )}
      </div>

      {loading ? (
        <div className="h-[62px] pt-2">
          <Skeleton className="h-1 w-full" />
          <span className="sr-only">Loading margin</span>
        </div>
      ) : (
        <div
          role="meter"
          aria-labelledby={labelId}
          aria-valuemin={min}
          aria-valuemax={top}
          aria-valuenow={Math.min(top, Math.max(min, value))}
          aria-valuetext={valueText}
          className="relative h-[62px]"
        >
          {/* ruler: the liquidation zone hatched under MM, then 20 hairline ticks, taller every fifth */}
          <span aria-hidden="true" className="absolute inset-x-0 top-0 h-1.5">
            <span
              data-zone="liquidation"
              className="absolute inset-y-0 left-0 bg-[repeating-linear-gradient(135deg,var(--color-loss-1)_0_1px,transparent_1px_4px)] opacity-70"
              style={{ width: `${mmPct}%` }}
            />
            {Array.from({ length: TICKS + 1 }, (_, i) => (
              <span
                key={i}
                className={cn('absolute bottom-0 w-px -translate-x-1/2 bg-navy-600', i % 5 === 0 ? 'h-1.5' : 'h-[3px]')}
                style={{ left: `${(i / TICKS) * 100}%` }}
              />
            ))}
          </span>
          {/* track */}
          <span aria-hidden="true" className="absolute inset-x-0 top-2.5 h-1 rounded-full bg-navy-800" />
          {/* fill */}
          <span
            aria-hidden="true"
            data-state={state}
            className={cn('absolute left-0 top-2.5 h-1 rounded-full transition-[width] duration-(--duration-base) ease-out', FILL[state])}
            style={{ width: `${valuePct}%` }}
          />
          {/* value node */}
          <span
            aria-hidden="true"
            className={cn(
              'absolute top-3 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-navy-900 transition-[left] duration-(--duration-base) ease-out',
              FILL[state],
            )}
            style={{ left: `${valuePct}%` }}
          />
          <span aria-hidden="true">
            {/* IM hangs right, away from the MM leader that crosses its row; MM sits alone on the lower row. */}
            <Datum at={imPct} depth={0} name="IM" text={format(im)} tone="im" side={imPct <= 80 ? 'right' : 'left'} />
            <Datum at={mmPct} depth={1} name="MM" text={format(mm)} tone="mm" side={mmPct < 50 ? 'right' : 'left'} />
          </span>
        </div>
      )}

      {!loading && (
        <p className="flex items-center gap-s2 text-t13 text-navy-200">
          <Lamp tone={s.lamp} size={6} />
          {status ?? s.text}
        </p>
      )}
    </div>
  );
}
