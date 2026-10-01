'use client';

import { useState, type KeyboardEvent, type PointerEvent } from 'react';
import { cn } from '@/lib/cn';
import { fmtNumber, fmtPct } from '@/lib/format';
import { useWidth } from './use-width';

export interface DiscountRampProps {
  startDiscount: number;
  maxDiscount: number;
  /** Seconds from start to the maximum discount. */
  duration: number;
  /** Seconds since the auction started. */
  elapsed: number;
  /** What a full bid prices against (transferable equity), for the lot readout. */
  value: number;
  /** Largest share one bid may take. */
  fraction: number;
  height?: number;
  className?: string;
}

/** AuctionHouse's discount: linear from start to max over the duration. */
export function discountAt(t: number, p: { startDiscount: number; maxDiscount: number; duration: number }): number {
  return p.startDiscount + (p.maxDiscount - p.startDiscount) * (Math.min(Math.max(t, 0), p.duration) / p.duration);
}

const M = { top: 14, right: 14, bottom: 22, left: 40 };

/**
 * The Dutch auction's discount ramp, with where it stands now. Pointer or arrow keys read the
 * discount and what a maximum lot would pay at any minute.
 */
export function DiscountRamp({ startDiscount, maxDiscount, duration, elapsed, value, fraction, height = 132, className }: DiscountRampProps) {
  const [ref, width] = useWidth<HTMLDivElement>(360);
  const [hover, setHover] = useState<number | null>(null);
  const p = { startDiscount, maxDiscount, duration };
  const mins = duration / 60;
  const plotW = Math.max(10, width - M.left - M.right);
  const plotH = height - M.top - M.bottom;
  const hi = maxDiscount * 1.1;
  const px = (m: number) => M.left + (m / mins) * plotW;
  const py = (d: number) => M.top + ((hi - d) / hi) * plotH;
  const now = Math.min(mins, elapsed / 60);
  const lot = (d: number) => fraction * value * (1 - d);
  const readM = hover ?? now;
  const readD = discountAt(readM * 60, p);
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHover(Math.round(Math.min(mins, Math.max(0, ((e.clientX - r.left - M.left) / plotW) * mins))));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = hover ?? Math.round(now);
    if (e.key === 'ArrowRight') setHover(Math.min(mins, cur + 1));
    else if (e.key === 'ArrowLeft') setHover(Math.max(0, cur - 1));
    else if (e.key === 'Escape') setHover(null);
    else return;
    e.preventDefault();
  };
  const ticks = [0, mins / 3, (2 * mins) / 3, mins].map((m) => Math.round(m));
  return (
    <div className={cn('grid min-w-0 grid-cols-[minmax(0,1fr)] gap-s2', className)}>
      <div
        ref={ref}
        role="group"
        tabIndex={0}
        aria-label={`Discount ramp: ${fmtPct(startDiscount)} at the start to ${fmtPct(maxDiscount)} at ${fmtNumber(mins, 0)} minutes; now ${fmtPct(discountAt(elapsed, p), 2)}. Arrows read each minute.`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
        className="relative touch-pan-y rounded-control outline-offset-4"
        style={{ height }}
      >
        <svg width={width} height={height} aria-hidden="true" className="block">
          {[startDiscount, maxDiscount].map((d) => (
            <g key={d}>
              <line x1={M.left} x2={M.left + plotW} y1={py(d)} y2={py(d)} stroke="var(--color-navy-800)" shapeRendering="crispEdges" />
              <text x={M.left - 6} y={py(d)} dy="0.32em" textAnchor="end" className="fill-navy-200 text-[12px] tabular-nums">
                {fmtPct(d, 0)}
              </text>
            </g>
          ))}
          {ticks.map((m, i) => (
            <text
              key={m}
              x={px(m)}
              y={height - 6}
              textAnchor={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'}
              className="fill-navy-200 text-[12px] tabular-nums"
            >
              {m} min
            </text>
          ))}
          {/* elapsed part solid, the rest of the ramp dashed */}
          <line x1={px(0)} y1={py(startDiscount)} x2={px(now)} y2={py(discountAt(now * 60, p))} stroke="var(--color-loss-2)" strokeWidth={2} strokeLinecap="round" />
          <line
            x1={px(now)}
            y1={py(discountAt(now * 60, p))}
            x2={px(mins)}
            y2={py(maxDiscount)}
            stroke="var(--color-loss-1)"
            strokeWidth={1.5}
            strokeDasharray="3 4"
          />
          <line x1={px(now)} x2={px(now)} y1={M.top} y2={M.top + plotH} stroke="var(--color-navy-400)" shapeRendering="crispEdges" />
          <circle cx={px(now)} cy={py(discountAt(now * 60, p))} r={5} fill="var(--color-loss-2)" stroke="var(--color-navy-950)" strokeWidth={2} />
          {hover !== null && (
            <circle cx={px(hover)} cy={py(readD)} r={4} fill="var(--color-navy-50)" stroke="var(--color-navy-950)" strokeWidth={2} />
          )}
        </svg>
      </div>
      <p className="text-t12 text-navy-200" aria-live="polite">
        {hover === null ? 'Now, ' : `At ${hover} min, `}
        <span className="tabular-nums text-navy-50">{fmtNumber(readM, 0)} min in</span>: discount{' '}
        <span className="font-medium tabular-nums text-navy-50">{fmtPct(readD, 2)}</span>. A {fmtPct(fraction, 0)} lot pays{' '}
        <span className="font-medium tabular-nums text-navy-50">{fmtNumber(lot(readD))}</span> USDG for{' '}
        <span className="tabular-nums">{fmtNumber(fraction * value)}</span> of equity.
      </p>
    </div>
  );
}
