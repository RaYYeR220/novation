'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';
import { Lamp } from '@/components/ui/lamp';
import { meterState, type MeterState } from '@/components/ui/meter';
import type { AccountState } from '@/lib/client/types';
import { cn } from '@/lib/cn';
import { fmtNumber, fmtPct, fmtSigned } from '@/lib/format';
import { marginDelta, sharedScale, toPct } from '@/lib/margin';

export interface MarginMeterProps {
  /** The account as it stands. */
  now: AccountState;
  /** The account if the ticket clears. Absent until there is a ticket. */
  after?: AccountState;
  /** A new quote is computing; the last one stays on screen, dimmed. */
  pending?: boolean;
  /** Replaces the status line under the ruler. */
  status?: ReactNode;
  unit?: string;
  className?: string;
}

const FILL: Record<MeterState, string> = { clear: 'bg-zero', restricted: 'bg-loss-1', liquidatable: 'bg-loss-3' };
const LAMP = { clear: 'navy-200', restricted: 'loss-1', liquidatable: 'loss-3' } as const;
/** The after lane glides from where the account is to where the ticket puts it. */
const GLIDE = 'transition-[left,width] duration-(--duration-slow) ease-out';

function Lane({
  name,
  state,
  top,
  glide,
  band,
  labelId,
}: {
  name: string;
  state: AccountState;
  top: number;
  glide: boolean;
  /** The initial margin this ticket adds (or frees): from, to. */
  band?: { from: number; to: number; text: string };
  labelId: string;
}) {
  const zone = meterState(state.equity, state.im, state.mm);
  const eq = toPct(state.equity, top);
  const im = toPct(state.im, top);
  const mm = toPct(state.mm, top);
  const move = glide ? GLIDE : '';
  const lo = band ? toPct(Math.min(band.from, band.to), top) : 0;
  const hi = band ? toPct(Math.max(band.from, band.to), top) : 0;
  const mid = (lo + hi) / 2;
  return (
    <div className="grid grid-cols-[44px_minmax(0,1fr)] items-end gap-s3">
      <span id={labelId} className="pb-[9px] text-t12 text-navy-200">
        {name}
      </span>
      <div
        role="meter"
        aria-labelledby={labelId}
        aria-valuemin={0}
        aria-valuemax={top}
        aria-valuenow={Math.min(top, Math.max(0, state.equity))}
        aria-valuetext={`Equity ${fmtNumber(state.equity)}, initial margin ${fmtNumber(state.im)}, maintenance margin ${fmtNumber(state.mm)}`}
        className="relative h-9"
      >
        {band && Math.abs(band.to - band.from) > 0.005 && (
          <>
            {/* what this ticket adds to initial margin: a cyan wash between the old and the new datum */}
            <span
              aria-hidden="true"
              data-band=""
              className={cn('absolute top-[15px] h-3 rounded-[1px] bg-cyan/18', move)}
              style={{ left: `${lo}%`, width: `${Math.max(0.4, hi - lo)}%` }}
            />
            <span
              aria-hidden="true"
              className={cn('absolute top-0 whitespace-nowrap text-t12 leading-none font-medium tabular-nums text-navy-50', move)}
              style={{ left: `clamp(0px, calc(${mid}% - 44px), calc(100% - 88px))` }}
            >
              {band.text}
            </span>
          </>
        )}
        <span aria-hidden="true" className="absolute inset-x-0 top-[19px] h-1 rounded-full bg-navy-800" />
        {/* liquidation zone under MM, hatched so it reads without colour */}
        <span
          aria-hidden="true"
          className={cn(
            'absolute left-0 top-[19px] h-1 bg-[repeating-linear-gradient(135deg,var(--color-loss-1)_0_1px,transparent_1px_4px)] opacity-70',
            move,
          )}
          style={{ width: `${mm}%` }}
        />
        <span
          aria-hidden="true"
          className={cn('absolute left-0 top-[20px] h-0.5 rounded-full', FILL[zone], move)}
          style={{ width: `${eq}%` }}
        />
        <span
          aria-hidden="true"
          className={cn('absolute top-[21px] size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-navy-900', FILL[zone], move)}
          style={{ left: `${eq}%` }}
        />
        {/* datums: MM short in peach, IM tall in cyan */}
        <span
          aria-hidden="true"
          data-datum="mm"
          className={cn('absolute top-[15px] h-3 w-px -translate-x-1/2 bg-loss-1', move)}
          style={{ left: `${mm}%` }}
        />
        <span
          aria-hidden="true"
          data-datum="im"
          className={cn('absolute top-[12px] h-[18px] w-0.5 -translate-x-1/2 rounded-full bg-cyan', move)}
          style={{ left: `${im}%` }}
        />
      </div>
    </div>
  );
}

/** "Initial margin would take 16.9% of equity, up from 6.4%." Two decimals when one would read the same. */
function usageLine(now: number, after: number): string {
  const d = fmtPct(now) === fmtPct(after) ? 2 : 1;
  if (Math.abs(after - now) < 5e-5) return `Initial margin stays at ${fmtPct(after, d)} of equity.`;
  return `Initial margin would take ${fmtPct(after, d)} of equity, ${after > now ? 'up' : 'down'} from ${fmtPct(now, d)}.`;
}

function Change({ v, good }: { v: number | undefined; good: 'up' | 'down' }) {
  if (v === undefined) return <span className="text-navy-400">—</span>;
  if (Math.abs(v) < 0.005) return <span className="text-navy-200">0.00</span>;
  const better = good === 'up' ? v > 0 : v < 0;
  return <span className={better ? 'text-gain-2' : 'text-loss-1'}>{fmtSigned(v)}</span>;
}

/**
 * Equity against initial and maintenance margin, now and after the ticket, on one shared ruler.
 * The table gives the exact figures; the ruler shows where the ticket moves the datums, with the
 * margin it adds washed in cyan. The after lane glides from the current state when a quote lands.
 */
export function MarginMeter({ now, after, pending = false, status, unit = 'USDG', className }: MarginMeterProps) {
  const id = useId();
  // The lanes take the new state one frame late, so the after lane always has a start to glide from.
  const [lane, setLane] = useState<AccountState | undefined>(undefined);
  useEffect(() => {
    const f = requestAnimationFrame(() => setLane(after));
    return () => cancelAnimationFrame(f);
  }, [after]);
  const top = sharedScale(now, after);
  const d = after ? marginDelta(now, after) : undefined;
  const target = after ?? now;
  const rows: { key: string; label: ReactNode; now: number; after?: number; change?: number; good: 'up' | 'down' }[] = [
    { key: 'equity', label: 'Equity', now: now.equity, after: after?.equity, change: d?.equity.change, good: 'up' },
    {
      key: 'im',
      label: (
        <span className="inline-flex items-center gap-s2">
          <span aria-hidden="true" className="inline-block h-3 w-0.5 rounded-full bg-cyan" />
          Initial margin
        </span>
      ),
      now: now.im,
      after: after?.im,
      change: d?.im.change,
      good: 'down',
    },
    {
      key: 'mm',
      label: (
        <span className="inline-flex items-center gap-s2">
          <span aria-hidden="true" className="inline-block h-2.5 w-px bg-loss-1" />
          Maintenance
        </span>
      ),
      now: now.mm,
      after: after?.mm,
      change: d?.mm.change,
      good: 'down',
    },
    {
      key: 'free',
      label: 'Free to trade',
      now: now.equity - now.im,
      after: after ? after.equity - after.im : undefined,
      change: d?.free.change,
      good: 'up',
    },
  ];

  const zone = meterState(target.equity, target.im, target.mm);
  const line =
    status ??
    (!after
      ? 'Pick a bid or an ask: the margin after the ticket shows here before you sign.'
      : zone === 'liquidatable'
        ? 'Below maintenance margin after this trade. The account could be liquidated.'
        : zone === 'restricted'
          ? 'Below initial margin after this trade. The kernel refuses opening trades from here.'
          : usageLine(d!.usage.now, d!.usage.after));
  const imMoved = d && Math.abs(d.im.change) > 0.005;

  return (
    <div className={cn('grid gap-s4', className)} aria-busy={pending || undefined}>
      <table className="w-full border-separate border-spacing-0 text-t13 tabular-nums">
        <caption className="sr-only">Margin now and after this ticket, in {unit}</caption>
        <thead>
          <tr className="text-t12 text-navy-200">
            <th scope="col" className="pb-s2 text-left font-normal">
              <span className="sr-only">Figure</span>
              <span aria-hidden="true">{unit}</span>
            </th>
            <th scope="col" className="pb-s2 text-right font-normal">
              Now
            </th>
            <th scope="col" className="pb-s2 text-right font-normal">
              After
            </th>
            <th scope="col" className="pb-s2 text-right font-normal">
              Change
            </th>
          </tr>
        </thead>
        <tbody className={cn('transition-opacity duration-(--duration-fast)', pending && 'opacity-60')}>
          {rows.map((r) => (
            <tr key={r.key} data-row={r.key}>
              <th scope="row" className="h-7 border-t border-navy-800 pr-s2 text-left font-normal text-navy-200">
                {r.label}
              </th>
              <td className="border-t border-navy-800 pl-s2 text-right text-navy-200">{fmtNumber(r.now)}</td>
              <td className="border-t border-navy-800 pl-s2 text-right font-medium text-navy-50">
                {r.after === undefined ? <span className="font-normal text-navy-400">—</span> : fmtNumber(r.after)}
              </td>
              <td className="border-t border-navy-800 pl-s2 text-right">
                <Change v={r.change} good={r.good} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className={cn('grid gap-s1 transition-opacity duration-(--duration-fast)', pending && 'opacity-60')}>
        <Lane name="Now" state={now} top={top} glide={false} labelId={`${id}-now`} />
        <div className={cn('transition-opacity duration-(--duration-fast)', !after && 'opacity-40')}>
          <Lane
            name="After"
            state={lane ?? now}
            top={top}
            glide
            labelId={`${id}-after`}
            band={imMoved && lane ? { from: now.im, to: lane.im, text: `${fmtSigned(lane.im - now.im)} IM` } : undefined}
          />
        </div>
        {/* axis: five round stops on the shared ruler */}
        <div aria-hidden="true" className="grid grid-cols-[44px_minmax(0,1fr)] gap-s3">
          <span />
          <div className="relative h-4 border-t border-navy-700">
            {[0, 0.25, 0.5, 0.75, 1].map((f) => (
              <span
                key={f}
                className={cn(
                  'absolute top-1 text-t12 leading-none tabular-nums text-navy-200',
                  f === 0 ? 'left-0' : f === 1 ? 'right-0' : '-translate-x-1/2',
                )}
                style={f > 0 && f < 1 ? { left: `${f * 100}%` } : undefined}
              >
                {fmtNumber(top * f, 0)}
              </span>
            ))}
          </div>
        </div>
      </div>

      <p className="flex items-start gap-s2 text-t13 text-pretty text-navy-200">
        <Lamp tone={after ? LAMP[zone] : 'navy-400'} state={after ? 'lit' : 'ring'} size={6} className="mt-[7px]" />
        <span>{line}</span>
      </p>
    </div>
  );
}
