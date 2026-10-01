'use client';

import { useState, type KeyboardEvent, type PointerEvent } from 'react';
import { cn } from '@/lib/cn';
import { fmtExpiry, fmtNumber, fmtPct } from '@/lib/format';
import { fmtEt } from '@/lib/nyse';
import { niceTicks, useWidth } from './use-width';

export interface NavPoint {
  t: number;
  nav: number;
}

export interface NavMark {
  t: number;
  /** "Calls assigned: paid 376.75", shown in the readout. */
  text: string;
  tone: 'paid' | 'deficit';
}

/** A tiny NAV line for a ledger row. Decorative: the row carries the numbers. */
export function NavSparkline({ points, className }: { points: NavPoint[]; className?: string }) {
  const w = 120;
  const h = 28;
  if (points.length < 2) return null;
  const xs = points.map((p) => p.t);
  const ys = points.map((p) => p.nav);
  const x0 = xs[0]!;
  const x1 = xs[xs.length - 1]!;
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const px = (t: number) => ((t - x0) / (x1 - x0 || 1)) * (w - 4) + 2;
  const py = (v: number) => h - 3 - ((v - lo) / (hi - lo || 1)) * (h - 6);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${px(p.t).toFixed(1)},${py(p.nav).toFixed(1)}`).join('');
  const last = points[points.length - 1]!;
  return (
    <svg aria-hidden="true" width={w} height={h} viewBox={`0 0 ${w} ${h}`} className={cn('block overflow-visible', className)}>
      <path d={d} fill="none" stroke="var(--color-zero)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={px(last.t)} cy={py(last.nav)} r={2.5} fill="var(--color-navy-50)" />
    </svg>
  );
}

const M = { top: 16, right: 16, bottom: 26, left: 64 };

/**
 * NAV per share over time, with the weeks the vault paid out marked on the line. Pointer and arrow
 * keys read any day; the readout leads with the value.
 */
export function NavChart({
  points,
  unit,
  marks = [],
  height = 220,
  label,
  className,
}: {
  points: NavPoint[];
  unit: string;
  marks?: NavMark[];
  height?: number;
  label: string;
  className?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>(640);
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2) return null;
  const ys = points.map((p) => p.nav);
  let lo = Math.min(...ys);
  let hi = Math.max(...ys);
  const pad = (hi - lo || 0.01) * 0.12;
  lo -= pad;
  hi += pad;
  const t0 = points[0]!.t;
  const t1 = points[points.length - 1]!.t;
  const plotW = Math.max(10, width - M.left - M.right);
  const plotH = height - M.top - M.bottom;
  const px = (t: number) => M.left + ((t - t0) / (t1 - t0 || 1)) * plotW;
  const py = (v: number) => M.top + ((hi - v) / (hi - lo)) * plotH;
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${px(p.t).toFixed(2)},${py(p.nav).toFixed(2)}`).join('');
  const base = points[0]!.nav;
  const yTicks = niceTicks(lo, hi, 4);
  const months: number[] = [];
  {
    const dt = new Date(t0 * 1000);
    let m = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 1) / 1000;
    while (m < t1) {
      months.push(m);
      const x = new Date(m * 1000);
      m = Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 1) / 1000;
    }
  }
  const nearest = (t: number) => {
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(points[i]!.t - t) < Math.abs(points[best]!.t - t)) best = i;
    return best;
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHover(nearest(t0 + ((e.clientX - r.left - M.left) / plotW) * (t1 - t0)));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = hover ?? points.length - 1;
    let next = cur;
    if (e.key === 'ArrowRight') next = Math.min(points.length - 1, cur + (e.shiftKey ? 7 : 1));
    else if (e.key === 'ArrowLeft') next = Math.max(0, cur - (e.shiftKey ? 7 : 1));
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = points.length - 1;
    else if (e.key === 'Escape') return setHover(null);
    else return;
    e.preventDefault();
    setHover(next);
  };
  const h = hover !== null ? points[hover]! : undefined;
  const mk = h ? marks.find((m) => Math.abs(m.t - h.t) < 86400) : undefined;
  const tipX = h ? px(h.t) : 0;
  const flip = tipX > width - 230;
  const last = points[points.length - 1]!;
  const change = last.nav / base - 1;

  return (
    <div className={cn('grid min-w-0 grid-cols-[minmax(0,1fr)] gap-s2', className)}>
      <div
        ref={ref}
        role="group"
        tabIndex={0}
        aria-label={`${label}: ${fmtNumber(base, 4)} to ${fmtNumber(last.nav, 4)} ${unit} per share, ${fmtPct(change, 2)}. Left and right arrows read each day.`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
        className="relative touch-pan-y rounded-control outline-offset-4"
        style={{ height }}
      >
        <svg width={width} height={height} aria-hidden="true" className="block">
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={M.left + plotW} y1={py(t)} y2={py(t)} stroke="var(--color-navy-800)" shapeRendering="crispEdges" />
              <text x={M.left - 8} y={py(t)} dy="0.32em" textAnchor="end" className="fill-navy-200 text-[12px] tabular-nums">
                {fmtNumber(t, 3)}
              </text>
            </g>
          ))}
          <line x1={M.left} x2={M.left + plotW} y1={py(base)} y2={py(base)} stroke="var(--color-navy-400)" strokeDasharray="2 3" shapeRendering="crispEdges" />
          {months.map((m) => (
            <text key={m} x={px(m)} y={height - 8} textAnchor="middle" className="fill-navy-200 text-[12px]">
              {new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(new Date(m * 1000))}
            </text>
          ))}
          <path d={d} fill="none" stroke="var(--color-zero)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {marks.map((m) => {
            const i = nearest(m.t);
            const p = points[i]!;
            return (
              <circle
                key={m.t}
                cx={px(p.t)}
                cy={py(p.nav)}
                r={4}
                fill={m.tone === 'deficit' ? 'var(--color-navy-950)' : 'var(--color-loss-2)'}
                stroke={m.tone === 'deficit' ? 'var(--color-loss-3)' : 'var(--color-navy-900)'}
                strokeWidth={2}
              />
            );
          })}
          <circle cx={px(last.t)} cy={py(last.nav)} r={4} fill="var(--color-navy-50)" stroke="var(--color-navy-900)" strokeWidth={2} />
          {h && (
            <g>
              <line x1={px(h.t)} x2={px(h.t)} y1={M.top} y2={M.top + plotH} stroke="var(--color-navy-200)" shapeRendering="crispEdges" />
              <circle cx={px(h.t)} cy={py(h.nav)} r={4} fill="var(--color-zero)" stroke="var(--color-navy-900)" strokeWidth={2} />
            </g>
          )}
        </svg>
        {h && (
          <div
            className="pointer-events-none absolute z-10 grid w-max max-w-[260px] gap-0.5 rounded-control border border-navy-600 bg-navy-950 px-s3 py-s2 text-t12"
            style={{ top: M.top, ...(flip ? { right: width - tipX + 12 } : { left: tipX + 12 }) }}
          >
            <p>
              <span className="font-medium tabular-nums text-navy-50">{fmtNumber(h.nav, 4)}</span>{' '}
              <span className="text-navy-200">{unit} per share</span>
            </p>
            <p className="tabular-nums text-navy-200">
              {fmtPct(h.nav / base - 1, 2)} since launch, {fmtEt(h.t)}
            </p>
            {mk && <p className="text-navy-50">{mk.text}</p>}
          </div>
        )}
      </div>
      <ul className="flex flex-wrap items-center gap-x-s5 gap-y-s1 text-t12 text-navy-200">
        <li className="flex items-center gap-s2">
          <span aria-hidden="true" className="inline-block h-0.5 w-4 rounded-full bg-zero" />
          NAV per share, {unit}
        </li>
        <li className="flex items-center gap-s2">
          <span aria-hidden="true" className="inline-block h-px w-4 border-t border-dashed border-navy-400" />
          At launch, {fmtExpiry(t0)}
        </li>
        {marks.some((m) => m.tone === 'paid') && (
          <li className="flex items-center gap-s2">
            <span aria-hidden="true" className="inline-block size-2 rounded-full bg-loss-2" />
            Expiry the vault paid out
          </li>
        )}
        {marks.some((m) => m.tone === 'deficit') && (
          <li className="flex items-center gap-s2">
            <span aria-hidden="true" className="inline-block size-2 rounded-full border-2 border-loss-3" />
            Paid past its cash: insurance bridged, tokens sold
          </li>
        )}
      </ul>
    </div>
  );
}
