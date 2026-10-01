'use client';

import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { cn } from '@/lib/cn';
import { fmtNumber, fmtShock, fmtSigned } from '@/lib/format';
import { breakevens, payoffAt, priceAxis, type PayoffBook } from '@/lib/payoff';
import { PRICE_POINTS, priceShockFraction } from '@/lib/scenario';
import { niceTicks, useWidth } from './use-width';

export interface PayoffChartProps {
  symbol: string;
  spot: number;
  /** The expiry the payoff is read at (unix seconds). */
  horizon: number;
  /** The kernel's shock range for this underlying, as a fraction: drawn as the band the margin looks at. */
  shock: number;
  /** The book on this underlying as it stands. */
  now: PayoffBook;
  /** The book with the ticket. */
  after?: PayoffBook;
  /** The ticket on its own. */
  ticket?: PayoffBook;
  /** Strike of the ticket, marked on the plot. */
  strike?: number;
  unit?: string;
  height?: number;
  className?: string;
}

type Key = 'main' | 'now' | 'ticket';
interface Line {
  key: Key;
  name: string;
  ys: number[];
}

const M = { top: 24, right: 12, bottom: 26, left: 60 };
const listFmt = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });
const joinPrices = (xs: number[]) => listFmt.format(xs.map((x) => fmtNumber(x)));
const SAMPLES = 161;

/** A short stroke in the series colour, for legend rows and the readout. */
function LineKey({ k }: { k: Key }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block h-0.5 w-4 shrink-0 rounded-full',
        k === 'now' && 'bg-navy-400',
        k === 'ticket' && 'bg-navy-200',
        k === 'main' && 'bg-[linear-gradient(90deg,var(--color-loss-2)_50%,var(--color-gain-2)_50%)]',
      )}
    />
  );
}

/**
 * P&L at expiry across the underlying's price, against today's marks: the book with the ticket
 * (in the data ramp, lime above zero and orange below), the book as it stands, and the ticket alone.
 * The shaded band is the kernel's shock range, where the 13 price points of the margin grid sit.
 */
export function PayoffChart({
  symbol,
  spot,
  horizon,
  shock,
  now,
  after,
  ticket,
  strike,
  unit = 'USDG',
  height = 236,
  className,
}: PayoffChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>(720);
  const rawId = useId();
  const uid = rawId.replace(/[^a-zA-Z0-9_-]/g, '');
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);

  const span = Math.max(2 * shock, 0.15);
  const main = after ?? now;
  const xs = useMemo(
    () => priceAxis(spot, span, SAMPLES, [...main.legs.map((l) => l.strike), spot]),
    [spot, span, main],
  );
  const lines: Line[] = useMemo(() => {
    const out: Line[] = [{ key: 'main', name: after ? 'Book with this ticket' : 'Book now', ys: xs.map((x) => payoffAt(main, x, horizon)) }];
    if (after) out.push({ key: 'now', name: 'Book now', ys: xs.map((x) => payoffAt(now, x, horizon)) });
    if (ticket) out.push({ key: 'ticket', name: 'This ticket alone', ys: xs.map((x) => payoffAt(ticket, x, horizon)) });
    return out;
  }, [xs, main, now, after, ticket, horizon]);

  const all = lines.flatMap((l) => l.ys);
  let lo = Math.min(0, ...all);
  let hi = Math.max(0, ...all);
  const pad = (hi - lo || 1) * 0.08;
  lo -= pad;
  hi += pad;
  const yTicks = niceTicks(lo, hi, 5);
  const xmin = xs[0]!;
  const xmax = xs[xs.length - 1]!;
  const xTicks = niceTicks(xmin, xmax, width < 480 ? 3 : 6);
  const plotW = Math.max(10, width - M.left - M.right);
  const plotH = height - M.top - M.bottom;
  const px = (x: number) => M.left + ((x - xmin) / (xmax - xmin)) * plotW;
  const py = (y: number) => M.top + ((hi - y) / (hi - lo)) * plotH;
  const path = (ys: number[]) => ys.map((y, i) => `${i ? 'L' : 'M'}${px(xs[i]!).toFixed(2)},${py(y).toFixed(2)}`).join('');
  const mainYs = lines[0]!.ys;
  const zeroY = py(0);
  const area = `${path(mainYs)}L${px(xmax).toFixed(2)},${zeroY.toFixed(2)}L${px(xmin).toFixed(2)},${zeroY.toFixed(2)}Z`;
  const bes = breakevens(xs, mainYs);
  const bandL = px(spot * (1 - shock));
  const bandR = px(spot * (1 + shock));
  const showStrike = strike !== undefined && strike > xmin && strike < xmax && Math.abs(px(strike) - px(spot)) > 64;

  const pick = (clientX: number, el: Element) => {
    const r = el.getBoundingClientRect();
    const x = xmin + ((clientX - r.left - M.left) / plotW) * (xmax - xmin);
    let best = 0;
    for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i]! - x) < Math.abs(xs[best]! - x)) best = i;
    return best;
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => setHover(pick(e.clientX, e.currentTarget));
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = hover ?? xs.findIndex((x) => x >= spot);
    const step = e.shiftKey ? 10 : 1;
    let next = cur;
    if (e.key === 'ArrowRight') next = Math.min(xs.length - 1, cur + step);
    else if (e.key === 'ArrowLeft') next = Math.max(0, cur - step);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = xs.length - 1;
    else if (e.key === 'Escape') {
      setHover(null);
      return;
    } else return;
    e.preventDefault();
    setHover(next);
  };

  const hx = hover !== null ? xs[hover]! : undefined;
  const tipLeft = hx !== undefined ? px(hx) : 0;
  const flip = tipLeft > width - 220;
  const kernelPoints = Array.from({ length: PRICE_POINTS }, (_, j) => spot * (1 + priceShockFraction(j) * shock));
  const range = `${fmtNumber(xmin)} to ${fmtNumber(xmax)}`;
  const mainLo = Math.min(...mainYs);
  const mainHi = Math.max(...mainYs);

  return (
    <div className={cn('grid gap-s3', className)}>
      <ul className="flex flex-wrap items-center gap-x-s5 gap-y-s1 text-t12 text-navy-200">
        {lines.map((l) => (
          <li key={l.key} className="flex items-center gap-s2">
            <LineKey k={l.key} />
            {l.name}
          </li>
        ))}
        <li className="flex items-center gap-s2">
          <span aria-hidden="true" className="inline-block h-2.5 w-4 rounded-[1px] bg-navy-800" />
          Kernel shocks {fmtShock(-shock)} to {fmtShock(shock)}
        </li>
      </ul>

      <div
        ref={ref}
        role="group"
        tabIndex={0}
        aria-label={`Payoff at expiry for ${symbol}, ${range}. ${lines[0]!.name} runs from ${fmtNumber(mainLo)} to ${fmtNumber(mainHi)} ${unit}${bes.length ? `, breakeven ${joinPrices(bes)}` : ''}. Left and right arrows read values.`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
        className="relative touch-pan-y overflow-hidden rounded-control outline-offset-4"
        style={{ height }}
      >
        <svg width={width} height={height} aria-hidden="true" className="block">
          <defs>
            <clipPath id={`${uid}-up`}>
              <rect x={0} y={0} width={width} height={Math.max(0, zeroY)} />
            </clipPath>
            <clipPath id={`${uid}-down`}>
              <rect x={0} y={zeroY} width={width} height={Math.max(0, height - zeroY)} />
            </clipPath>
          </defs>

          {/* the kernel's price shock range */}
          <rect x={bandL} y={M.top} width={Math.max(0, bandR - bandL)} height={plotH} fill="var(--color-navy-800)" opacity={0.55} />
          {/* grid: hairlines, zero a step stronger */}
          {yTicks.map((t) => (
            <g key={t}>
              <line
                x1={M.left}
                x2={M.left + plotW}
                y1={py(t)}
                y2={py(t)}
                stroke={t === 0 ? 'var(--color-navy-400)' : 'var(--color-navy-800)'}
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              <text x={M.left - 8} y={py(t)} dy="0.32em" textAnchor="end" className="fill-navy-200 text-[12px] tabular-nums">
                {fmtSigned(t, 0)}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t} x={px(t)} y={height - 8} textAnchor="middle" className="fill-navy-200 text-[12px] tabular-nums">
              {fmtNumber(t, 0)}
            </text>
          ))}
          <line x1={M.left} x2={M.left + plotW} y1={M.top + plotH} y2={M.top + plotH} stroke="var(--color-navy-700)" shapeRendering="crispEdges" />

          {/* spot and the ticket's strike */}
          <line x1={px(spot)} x2={px(spot)} y1={M.top - 4} y2={M.top + plotH} stroke="var(--color-navy-400)" strokeWidth={1} shapeRendering="crispEdges" />
          <text x={px(spot)} y={M.top - 10} textAnchor="middle" className="fill-navy-50 text-[12px] tabular-nums">
            Spot {fmtNumber(spot)}
          </text>
          {strike !== undefined && strike > xmin && strike < xmax && (
            <line x1={px(strike)} x2={px(strike)} y1={M.top + plotH - 6} y2={M.top + plotH} stroke="var(--color-navy-200)" strokeWidth={1.5} />
          )}
          {showStrike && (
            <text x={px(strike!)} y={M.top - 10} textAnchor="middle" className="fill-navy-200 text-[12px] tabular-nums">
              Strike {fmtNumber(strike!, 0)}
            </text>
          )}

          {/* the book with the ticket: washed and stroked in the ramp by sign */}
          <path d={area} fill="var(--color-gain-2)" opacity={0.1} clipPath={`url(#${uid}-up)`} />
          <path d={area} fill="var(--color-loss-2)" opacity={0.12} clipPath={`url(#${uid}-down)`} />
          {lines
            .filter((l) => l.key !== 'main')
            .map((l) => (
              <path
                key={l.key}
                d={path(l.ys)}
                fill="none"
                stroke={l.key === 'now' ? 'var(--color-navy-400)' : 'var(--color-navy-200)'}
                strokeWidth={l.key === 'now' ? 1.75 : 1.25}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
          <path d={path(mainYs)} fill="none" stroke="var(--color-gain-2)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" clipPath={`url(#${uid}-up)`} />
          <path d={path(mainYs)} fill="none" stroke="var(--color-loss-2)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" clipPath={`url(#${uid}-down)`} />
          {bes.map((b) => (
            <circle key={b} cx={px(b)} cy={zeroY} r={4} fill="var(--color-navy-50)" stroke="var(--color-navy-900)" strokeWidth={2} />
          ))}

          {/* crosshair */}
          {hx !== undefined && (
            <g>
              <line x1={px(hx)} x2={px(hx)} y1={M.top} y2={M.top + plotH} stroke="var(--color-navy-200)" strokeWidth={1} shapeRendering="crispEdges" />
              {lines.map((l) => (
                <circle
                  key={l.key}
                  cx={px(hx)}
                  cy={py(l.ys[hover!]!)}
                  r={4}
                  fill={l.key === 'main' ? (l.ys[hover!]! >= 0 ? 'var(--color-gain-2)' : 'var(--color-loss-2)') : l.key === 'now' ? 'var(--color-navy-400)' : 'var(--color-navy-200)'}
                  stroke="var(--color-navy-900)"
                  strokeWidth={2}
                />
              ))}
            </g>
          )}
        </svg>

        {hx !== undefined && (
          <div
            className="pointer-events-none absolute z-10 grid w-max min-w-[180px] gap-s1 rounded-control border border-navy-600 bg-navy-950 px-s3 py-s2 text-t12"
            style={{ top: M.top + 4, ...(flip ? { right: width - tipLeft + 12 } : { left: tipLeft + 12 }) }}
          >
            <p className="text-navy-200">
              {symbol} at <span className="font-medium tabular-nums text-navy-50">{fmtNumber(hx)}</span>{' '}
              <span className="tabular-nums">({fmtShock(hx / spot - 1)})</span>
            </p>
            {lines.map((l) => (
              <p key={l.key} className="flex items-center gap-s2">
                <LineKey k={l.key} />
                <span className="font-medium tabular-nums text-navy-50">{fmtSigned(l.ys[hover!]!)}</span>
                <span className="text-navy-200">{l.name}</span>
              </p>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-s3 text-t12 text-navy-200">
        <p className="tabular-nums">
          {bes.length === 0
            ? `No breakeven between ${fmtNumber(xmin, 0)} and ${fmtNumber(xmax, 0)}.`
            : `Breakeven at ${joinPrices(bes)}.`}{' '}
          P&amp;L in {unit} against today&apos;s marks.
        </p>
        <button
          type="button"
          aria-expanded={showTable}
          onClick={() => setShowTable((s) => !s)}
          className="rounded-[2px] text-navy-50 underline decoration-navy-400 underline-offset-4 transition-colors duration-(--duration-fast) ui-hover:decoration-cyan"
        >
          {showTable ? 'Hide values' : 'Values at the 13 kernel prices'}
        </button>
      </div>

      {showTable && (
        <div className="overflow-x-auto rounded-control border border-navy-700">
          <table className="w-full border-separate border-spacing-0 text-t12 tabular-nums">
            <caption className="sr-only">
              {symbol} P&amp;L at expiry at the kernel&apos;s 13 price points, in {unit}
            </caption>
            <thead>
              <tr className="text-navy-200">
                <th scope="col" className="h-8 border-b border-navy-700 px-s3 text-left font-medium">
                  Shock
                </th>
                <th scope="col" className="h-8 border-b border-navy-700 px-s3 text-right font-medium">
                  {symbol}
                </th>
                {lines.map((l) => (
                  <th key={l.key} scope="col" className="h-8 border-b border-navy-700 px-s3 text-right font-medium">
                    {l.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {kernelPoints.map((x, j) => (
                <tr key={j}>
                  <td className="h-7 border-b border-navy-800 px-s3 text-navy-200">{fmtShock(priceShockFraction(j) * shock)}</td>
                  <td className="h-7 border-b border-navy-800 px-s3 text-right text-navy-50">{fmtNumber(x)}</td>
                  {lines.map((l) => {
                    const book = l.key === 'main' ? main : l.key === 'now' ? now : ticket!;
                    return (
                      <td key={l.key} className="h-7 border-b border-navy-800 px-s3 text-right text-navy-50">
                        {fmtSigned(payoffAt(book, x, horizon))}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
