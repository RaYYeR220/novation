'use client';

import { useId, useState, type KeyboardEvent } from 'react';
import { cn } from '@/lib/cn';
import { fmtNumber, fmtShock } from '@/lib/format';
import { cellCoords, PRICE_POINTS, priceShockFraction, rampColor, VOL_MULTS, VOL_POINTS, worstCell } from '@/lib/scenario';

export interface StripGrid {
  /** Row label, e.g. "Now". */
  name: string;
  cells: readonly number[];
  /** The kernel's worst scenario index; defaults to the lowest cell. */
  worst?: number;
  /** Cells re-priced by the float twin of the kernel rather than computed by it. */
  estimate?: boolean;
}

export interface ScenarioStripProps {
  grids: StripGrid[];
  /** Shock range of the underlying the reader cares about, to label the price axis (each underlying moves by its own range). */
  range?: { symbol: string; value: number };
  unit?: string;
  className?: string;
}

const CELL_W = 18;
const CELL_H = 11;
const GAP = 2;
const W = PRICE_POINTS * CELL_W + (PRICE_POINTS - 1) * GAP;
const H = VOL_POINTS * CELL_H + (VOL_POINTS - 1) * GAP;

/** Rows top to bottom: vol ×1.4, ×1.0, ×0.7, so the stressed-vol row reads first. */
const rowY = (v: number) => (VOL_POINTS - 1 - v) * (CELL_H + GAP);
const colX = (j: number) => j * (CELL_W + GAP);

function describe(i: number, range?: ScenarioStripProps['range']): string {
  const { v, j } = cellCoords(i);
  const f = priceShockFraction(j);
  const price = range ? `${range.symbol} ${fmtShock(f * range.value)}` : `price ${j === 6 ? '0' : `${f > 0 ? '+' : '−'}${fmtNumber(Math.abs(f), 2)}R`}`;
  return `${price}, vol ×${VOL_MULTS[v]!.toFixed(1)}`;
}

/**
 * The 39 kernel scenarios as a compact 13 × 3 strip per grid, coloured on the diverging data ramp
 * (loss orange, zero blue-grey, gain lime) with one shared scale. The worst cell is ringed. Arrow
 * keys or the pointer move the readout; it rests on the last grid's worst cell.
 */
export function ScenarioStrip({ grids, range, unit = 'USDG', className }: ScenarioStripProps) {
  const id = useId();
  const scale = Math.max(1e-9, ...grids.flatMap((g) => g.cells.map((c) => Math.abs(c))));
  const last = grids[grids.length - 1];
  const lastWorst = last ? (last.worst ?? worstCell(last.cells).index) : 0;
  const [active, setActive] = useState<{ g: number; i: number } | null>(null);
  const focus = active ?? { g: grids.length - 1, i: lastWorst };
  const focusGrid = grids[focus.g];
  const focusValue = focusGrid?.cells[focus.i];
  const focusIsWorst = focusGrid && focus.i === (focusGrid.worst ?? worstCell(focusGrid.cells).index);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = active ?? focus;
    const { v, j } = cellCoords(cur.i);
    let nv = v;
    let nj = j;
    let ng = cur.g;
    if (e.key === 'ArrowRight') nj = Math.min(PRICE_POINTS - 1, j + 1);
    else if (e.key === 'ArrowLeft') nj = Math.max(0, j - 1);
    else if (e.key === 'ArrowUp') {
      if (v < VOL_POINTS - 1) nv = v + 1;
      else if (cur.g > 0) {
        ng = cur.g - 1;
        nv = 0;
      }
    } else if (e.key === 'ArrowDown') {
      if (v > 0) nv = v - 1;
      else if (cur.g < grids.length - 1) {
        ng = cur.g + 1;
        nv = VOL_POINTS - 1;
      }
    } else if (e.key === 'Home') nj = 0;
    else if (e.key === 'End') nj = PRICE_POINTS - 1;
    else return;
    e.preventDefault();
    setActive({ g: ng, i: nv * PRICE_POINTS + nj });
  };

  return (
    <div className={cn('grid gap-s3', className)}>
      <div
        role="group"
        tabIndex={0}
        aria-label={`Scenario grids, ${grids.map((g) => g.name).join(' and ')}. Arrow keys move between scenarios.`}
        aria-describedby={`${id}-readout`}
        onKeyDown={onKey}
        onPointerLeave={() => setActive(null)}
        className="grid gap-s2 rounded-control outline-offset-4"
      >
        {grids.map((g, gi) => {
          const worst = g.worst ?? worstCell(g.cells).index;
          return (
            <div key={g.name} className="grid grid-cols-[56px_minmax(0,1fr)] items-center gap-s3">
              <span className="grid text-t12 leading-tight text-navy-200">
                {g.name}
                {g.estimate && <span className="text-navy-200/80">estimate</span>}
              </span>
              <svg
                viewBox={`-2 -2 ${W + 4} ${H + 4}`}
                className="block h-auto w-full max-w-[300px]"
                aria-hidden="true"
                data-grid={g.name}
              >
                {g.cells.map((c, i) => {
                  const { v, j } = cellCoords(i);
                  const on = focus.g === gi && focus.i === i;
                  return (
                    <rect
                      key={i}
                      x={colX(j)}
                      y={rowY(v)}
                      width={CELL_W}
                      height={CELL_H}
                      rx={1.5}
                      fill={rampColor(c, scale)}
                      data-cell={i}
                      data-worst={i === worst || undefined}
                      stroke={i === worst ? 'var(--color-navy-50)' : on ? 'var(--color-cyan)' : 'none'}
                      strokeWidth={i === worst || on ? 1.5 : 0}
                      strokeDasharray={i === worst && g.estimate ? '2.5 1.5' : undefined}
                      onPointerEnter={() => setActive({ g: gi, i })}
                    />
                  );
                })}
                {focus.g === gi && focus.i !== worst && (
                  <rect
                    x={colX(cellCoords(focus.i).j) - 1.5}
                    y={rowY(cellCoords(focus.i).v) - 1.5}
                    width={CELL_W + 3}
                    height={CELL_H + 3}
                    rx={2.5}
                    fill="none"
                    stroke="var(--color-cyan)"
                    strokeWidth={1}
                    pointerEvents="none"
                  />
                )}
              </svg>
            </div>
          );
        })}
        <div aria-hidden="true" className="grid grid-cols-[56px_minmax(0,1fr)] gap-s3">
          <span />
          <div className="flex max-w-[300px] justify-between text-t12 leading-none tabular-nums text-navy-200">
            <span>{range ? fmtShock(-range.value) : '−R'}</span>
            <span>{range ? `${range.symbol} price` : 'price'}</span>
            <span>{range ? fmtShock(range.value) : '+R'}</span>
          </div>
        </div>
      </div>

      <p id={`${id}-readout`} aria-live="polite" className="text-t13 text-pretty text-navy-200">
        {active && focusGrid && focusValue !== undefined ? (
          <>
            <span className="text-navy-50">{focusGrid.name}</span>, {describe(focus.i, range)}:{' '}
            <span className="font-medium tabular-nums text-navy-50">
              {fmtNumber(focusValue)} {unit}
            </span>
            {focusIsWorst && <span> (worst of 39)</span>}
            {focusGrid.estimate && <span> (estimate)</span>}
          </>
        ) : (
          <>
            Worst of 39{' '}
            {grids.map((g, gi) => {
              const w = g.worst ?? worstCell(g.cells).index;
              return (
                <span key={g.name}>
                  {gi > 0 && '; '}
                  {g.name.toLowerCase()}{' '}
                  <span className="font-medium tabular-nums text-navy-50">{fmtNumber(g.cells[w] ?? 0)}</span>
                  {g.estimate && ' (estimate)'} at {describe(w, range)}
                </span>
              );
            })}
            . {unit}, whole book.
          </>
        )}
      </p>

      <table className="sr-only">
        <caption>Scenario P&amp;L in {unit}, rows by vol, columns by price shock</caption>
        <tbody>
          {grids.flatMap((g) =>
            [2, 1, 0].map((v) => (
              <tr key={`${g.name}-${v}`}>
                <th scope="row">
                  {g.name}, vol ×{VOL_MULTS[v]!.toFixed(1)}
                </th>
                {Array.from({ length: PRICE_POINTS }, (_, j) => (
                  <td key={j}>{fmtNumber(g.cells[v * PRICE_POINTS + j] ?? 0)}</td>
                ))}
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}
