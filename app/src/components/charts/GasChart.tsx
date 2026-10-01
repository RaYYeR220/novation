'use client';

import { scaleLinear, scaleLog } from 'd3-scale';
import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { GasRow } from '@/lib/client/types';
import { cn } from '@/lib/cn';
import { fmtNumber } from '@/lib/format';
import { TX_GAS_CAP, fmtGas, fmtGasTick, fmtRatio, tradeGas } from '@/lib/gas';
import { useWidth } from './use-width';

export interface GasChartProps {
  rows: GasRow[];
  /** Book size of the trade to annotate: two margin checks at this many positions. */
  tradeAt?: number;
  className?: string;
  /** Names the source footnote on the figure. */
  source?: string;
}

const SOL = 'var(--color-loss-2)';
const STY = 'var(--color-gain-2)';
const Y_MAX = 50_000_000;
/** A ring of the plot's ground under annotation text, so a line passing behind never cuts it. */
const HALO = '[paint-order:stroke] stroke-navy-950 [stroke-width:4px] [stroke-linejoin:round]';

function LineKey({ color }: { color: string }) {
  return <span aria-hidden="true" className="inline-block h-0.5 w-5 shrink-0 rounded-full" style={{ background: color }} />;
}

/**
 * Execution gas of one portfolio-margin check against the number of positions in the book (log x),
 * for a hand-optimized Solidity version and the Stylus kernel. The band above 32M does not fit in one
 * transaction; the trade marker doubles both lines because a trade runs at least two checks.
 */
export function GasChart({ rows, tradeAt = 256, className, source }: GasChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>(1120);
  const [active, setActive] = useState<number | null>(null);
  const ids = useId();
  const wide = width >= 720;
  const height = wide ? 440 : 360;
  const M = { top: 34, right: wide ? 132 : 16, bottom: 44, left: wide ? 52 : 40 };
  const pw = Math.max(10, width - M.left - M.right);
  const ph = height - M.top - M.bottom;

  const sorted = useMemo(() => [...rows].sort((a, b) => a.positions - b.positions), [rows]);
  const last = sorted[sorted.length - 1] as GasRow;
  const x = useMemo(() => scaleLog().base(2).domain([1, last.positions * 1.12]).range([0, pw]), [pw, last.positions]);
  const y = useMemo(() => scaleLinear().domain([0, Y_MAX]).range([ph, 0]), [ph]);
  const trade = tradeGas(sorted, tradeAt);

  const xTicks = (wide ? [1, 2, 4, 8, 16, 32, 64, 128, 256] : [1, 4, 16, 64, 256]).filter((t) => t <= last.positions);
  const yTicks = [0, 10e6, 20e6, 30e6, 40e6, 50e6];
  const path = (key: 'solidityOptimized' | 'stylus') =>
    sorted.map((r, i) => `${i ? 'L' : 'M'}${x(r.positions).toFixed(1)} ${y(r[key]).toFixed(1)}`).join('');

  const tx = x(tradeAt);
  const capY = y(TX_GAS_CAP);

  /* ---------- hover and keys: snap to the measured book sizes ---------- */
  const nearest = (px: number) => {
    let best = 0;
    for (let i = 1; i < sorted.length; i++)
      if (Math.abs(x((sorted[i] as GasRow).positions) - px) < Math.abs(x((sorted[best] as GasRow).positions) - px)) best = i;
    return best;
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - b.left - M.left;
    if (px < -24 || px > pw + 24) return setActive(null);
    setActive(nearest(px));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = sorted.length;
    const cur = active ?? sorted.findIndex((r) => r.positions === tradeAt);
    let next = cur;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = Math.min(n - 1, cur + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.max(0, cur - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else if (e.key === 'Escape') return setActive(null);
    else return;
    e.preventDefault();
    setActive(next);
  };
  const row = active === null ? null : (sorted[active] as GasRow);
  const readout = row
    ? `${row.positions} positions: Solidity ${fmtNumber(row.solidityOptimized, 0)} gas, Stylus ${fmtNumber(row.stylus, 0)} gas, ${fmtRatio(row.solidityOptimized / row.stylus)} less on Stylus.`
    : '';

  const tipLeft = row ? Math.min(Math.max(M.left + x(row.positions), 110), width - 110) : 0;

  return (
    <figure className={className} data-source={source}>
      <div className="flex flex-wrap items-center gap-x-s6 gap-y-s2 text-t13 text-navy-200">
        <span className="inline-flex items-center gap-s2">
          <LineKey color={SOL} />
          Solidity, hand-optimized
        </span>
        <span className="inline-flex items-center gap-s2">
          <LineKey color={STY} />
          Stylus kernel
        </span>
        <span className="inline-flex items-center gap-s2">
          <span aria-hidden="true" className="inline-block size-3 rounded-full border-2 border-navy-50" />
          One trade: two checks at {tradeAt} positions
        </span>
      </div>

      <div
        ref={ref}
        className="relative mt-s4 touch-pan-y rounded-control outline-offset-4"
        tabIndex={0}
        role="group"
        aria-roledescription="chart"
        aria-label={`Execution gas per margin check against positions in the book. Arrow keys step through the ${sorted.length} measured sizes.`}
        aria-describedby={`${ids}-sum`}
        onPointerMove={onMove}
        onPointerLeave={() => setActive(null)}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
      >
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block max-w-full overflow-visible" aria-hidden="true">
          <defs>
            <pattern id={`${ids}-over`} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="8" stroke="var(--color-loss-3)" strokeOpacity="0.22" strokeWidth="1.5" />
            </pattern>
          </defs>
          <g transform={`translate(${M.left},${M.top})`}>
            {/* over the cap: cannot execute */}
            <rect x={0} y={0} width={pw} height={capY} fill={`url(#${ids}-over)`} />
            {yTicks.map((t) => (
              <g key={t}>
                <line x1={0} x2={pw} y1={y(t)} y2={y(t)} stroke="var(--color-navy-50)" strokeOpacity={t === 0 ? 0.28 : 0.07} />
                <text x={-10} y={y(t)} dy="0.32em" textAnchor="end" className="fill-navy-200 text-[12px]">
                  {fmtGasTick(t)}
                </text>
              </g>
            ))}
            {xTicks.map((t) => (
              <text key={t} x={x(t)} y={ph + 22} textAnchor="middle" className="fill-navy-200 text-[12px]">
                {t}
              </text>
            ))}
            <text x={pw} y={ph + 40} textAnchor="end" className="fill-navy-200 text-[12px]">
              Positions in the book, log scale
            </text>
            <text x={-M.left + 4} y={-18} className="fill-navy-200 text-[12px]">
              Execution gas per margin check
            </text>

            {/* the cap */}
            <line x1={0} x2={pw} y1={capY} y2={capY} stroke="var(--color-loss-1)" strokeWidth={1.5} />
            <text x={8} y={capY - 10} className={cn(HALO, 'fill-navy-50 text-[13px] font-medium')}>
              32M gas per transaction: Arbitrum’s cap
            </text>
            {wide ? (
              <text x={8} y={capY - 28} className={cn(HALO, 'fill-navy-200 text-[12px]')}>
                Above this line a transaction cannot run
              </text>
            ) : null}

            {/* the trade: two checks at tradeAt positions */}
            <line x1={tx} x2={tx} y1={ph} y2={y(trade.solidity) + 8} stroke="var(--color-navy-50)" strokeOpacity={0.35} />
            <line
              x1={tx}
              x2={tx}
              y1={y(trade.solidity / 2) - 6}
              y2={y(trade.solidity) + 8}
              stroke={SOL}
              strokeWidth={1.5}
              strokeDasharray="2 3"
            />
            <circle cx={tx} cy={y(trade.solidity)} r={7} fill="var(--color-navy-950)" stroke="var(--color-navy-50)" strokeWidth={2} />
            <circle cx={tx} cy={y(trade.stylus)} r={7} fill="var(--color-navy-950)" stroke="var(--color-navy-50)" strokeWidth={2} />
            <text x={tx - 14} y={y(trade.solidity)} dy="0.32em" textAnchor="end" className={cn(HALO, 'fill-navy-50 text-[13px] font-semibold')}>
              {fmtGas(trade.solidity)} in Solidity
            </text>
            <text
              x={tx - 14}
              y={wide ? y(trade.stylus) - 16 : y(trade.stylus)}
              dy={wide ? undefined : '0.32em'}
              textAnchor="end"
              className={cn(HALO, 'fill-navy-50 text-[13px] font-semibold')}
            >
              {fmtGas(trade.stylus)} on Stylus
            </text>

            {/* measured lines */}
            <path d={path('solidityOptimized')} fill="none" stroke={SOL} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            <path d={path('stylus')} fill="none" stroke={STY} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {sorted.map((r) => (
              <g key={r.positions}>
                <circle cx={x(r.positions)} cy={y(r.solidityOptimized)} r={4} fill={SOL} stroke="var(--color-navy-950)" strokeWidth={2} />
                <circle cx={x(r.positions)} cy={y(r.stylus)} r={4} fill={STY} stroke="var(--color-navy-950)" strokeWidth={2} />
              </g>
            ))}
            {wide ? (
              <>
                <text x={x(last.positions) + 12} y={y(last.solidityOptimized)} dy="0.32em" className="fill-navy-50 text-[13px]">
                  Solidity {fmtGas(last.solidityOptimized)}
                </text>
                <text x={x(last.positions) + 12} y={y(last.stylus)} dy="0.32em" className="fill-navy-50 text-[13px]">
                  Stylus {fmtGas(last.stylus)}
                </text>
              </>
            ) : null}

            {/* crosshair */}
            {row ? (
              <g>
                <line x1={x(row.positions)} x2={x(row.positions)} y1={0} y2={ph} stroke="var(--color-navy-50)" strokeOpacity={0.5} />
                <circle cx={x(row.positions)} cy={y(row.solidityOptimized)} r={6} fill={SOL} stroke="var(--color-navy-950)" strokeWidth={2} />
                <circle cx={x(row.positions)} cy={y(row.stylus)} r={6} fill={STY} stroke="var(--color-navy-950)" strokeWidth={2} />
              </g>
            ) : null}
          </g>
        </svg>

        {row ? (
          <div
            className="pointer-events-none absolute top-0 z-10 w-[220px] -translate-x-1/2 rounded-control border border-navy-600 bg-navy-950/95 px-s3 py-s2 text-t13 shadow-[0_12px_32px_-12px_rgb(1_4_15/0.8)]"
            style={{ left: tipLeft }}
            aria-hidden="true"
          >
            <p className="text-navy-200">{row.positions} positions, one check</p>
            <p className="mt-1 flex items-center justify-between gap-s3">
              <span className="font-semibold text-navy-50">{fmtNumber(row.solidityOptimized, 0)}</span>
              <span className="inline-flex items-center gap-s2 text-navy-200">
                <LineKey color={SOL} />
                Solidity
              </span>
            </p>
            <p className="flex items-center justify-between gap-s3">
              <span className="font-semibold text-navy-50">{fmtNumber(row.stylus, 0)}</span>
              <span className="inline-flex items-center gap-s2 text-navy-200">
                <LineKey color={STY} />
                Stylus
              </span>
            </p>
            <p className="mt-1 text-navy-200">{fmtRatio(row.solidityOptimized / row.stylus)} less gas on Stylus</p>
          </div>
        ) : null}
      </div>

      <p id={`${ids}-sum`} className="sr-only">
        At {tradeAt} positions a trade runs two margin checks: {fmtNumber(trade.solidity, 0)} gas in Solidity, over the{' '}
        {fmtNumber(TX_GAS_CAP, 0)} per-transaction cap, against {fmtNumber(trade.stylus, 0)} gas on Stylus.
      </p>
      <p className="sr-only" aria-live="polite">
        {readout}
      </p>
      {/* a table never shrinks to the 1px box, so the clip lives on a wrapper */}
      <div className="sr-only">
        <table>
          <caption>Execution gas of one margin check, measured on Robinhood Chain testnet</caption>
          <thead>
            <tr>
              <th scope="col">Positions</th>
              <th scope="col">Solidity, hand-optimized</th>
              <th scope="col">Stylus kernel</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.positions}>
                <th scope="row">{r.positions}</th>
                <td>{fmtNumber(r.solidityOptimized, 0)}</td>
                <td>{fmtNumber(r.stylus, 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
