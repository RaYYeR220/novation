import { useId } from 'react';
import { Lamp } from '@/components/ui/lamp';
import { cn } from '@/lib/cn';
import { fmtNumber, fmtPct } from '@/lib/format';

export interface BudgetMeterProps {
  /** The account's worst-case loss now: the kernel's lossIM, which is its initial margin. */
  used: number;
  /** maxWorstLoss on the grant. */
  budget: number;
  /** The worst case of the last refused ticket, drawn past the budget. */
  refused?: number;
  unit?: string;
  /** Expired or revoked grants draw dimmed. */
  inactive?: boolean;
  className?: string;
}

/**
 * An agent's risk budget: the account's worst-case loss (cyan, the IM datum) against the grant's
 * cap. The budget caps what the account may carry while the agent trades, not what the agent
 * spends, so every agent on one account reads the same `used`.
 */
export function BudgetMeter({ used, budget, refused, unit = 'USDG', inactive = false, className }: BudgetMeterProps) {
  const labelId = useId();
  const top = Math.max(budget, used, refused ?? 0) * 1.06 || 1;
  const pct = (v: number) => Math.min(100, Math.max(0, (v / top) * 100));
  const share = budget > 0 ? used / budget : 1;
  const over = used > budget;
  const left = budget - used;
  const state = over ? 'over' : share >= 0.8 ? 'tight' : 'clear';
  const tone = inactive ? 'bg-navy-400' : state === 'over' ? 'bg-loss-3' : state === 'tight' ? 'bg-loss-1' : 'bg-zero';
  const status = inactive
    ? 'Expired: trades it signs revert NotAuthorized until the owner grants it again.'
    : state === 'over'
      ? `Over budget by ${fmtNumber(-left)}. Only trades that cut the worst case clear.`
      : `${fmtNumber(left)} ${unit} of worst-case loss left before trades that add risk are refused.`;
  return (
    <div className={cn('grid gap-s2', className)} data-inactive={inactive || undefined}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-s4 gap-y-0.5">
        <span id={labelId} className="text-t12 text-navy-200">
          Worst-case loss against budget
        </span>
        <span className="flex items-baseline gap-1.5 tabular-nums">
          <span className="text-t17 font-semibold text-navy-50">{fmtNumber(used)}</span>
          <span className="text-t13 text-navy-200">/ {fmtNumber(budget)} {unit}</span>
        </span>
      </div>
      <div
        role="meter"
        aria-labelledby={labelId}
        aria-valuemin={0}
        aria-valuemax={budget}
        aria-valuenow={Math.min(budget, used)}
        aria-valuetext={`${fmtNumber(used)} of ${fmtNumber(budget)} ${unit} used, ${fmtPct(share)}. ${status}${
          refused !== undefined ? ` Last refused ticket: ${fmtNumber(refused)}.` : ''
        }`}
        className="relative h-9"
      >
        <span aria-hidden="true" className="absolute inset-x-0 top-[13px] h-1 rounded-full bg-navy-800" />
        <span aria-hidden="true" data-fill="" className={cn('absolute left-0 top-[13px] h-1 rounded-full', tone)} style={{ width: `${pct(used)}%` }} />
        {refused !== undefined && refused > budget && (
          <>
            <span
              aria-hidden="true"
              data-refused=""
              className="absolute top-[14px] h-0.5 bg-[repeating-linear-gradient(90deg,var(--color-loss-3)_0_4px,transparent_4px_7px)]"
              style={{ left: `${pct(budget)}%`, width: `${pct(refused) - pct(budget)}%` }}
            />
            <span
              aria-hidden="true"
              className="absolute top-[15px] size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-loss-3 bg-navy-950"
              style={{ left: `${pct(refused)}%` }}
            />
          </>
        )}
        {/* the IM datum: the account's worst case now */}
        <span aria-hidden="true" className="absolute top-[7px] h-4 w-0.5 -translate-x-1/2 rounded-full bg-cyan" style={{ left: `${pct(used)}%` }} />
        {/* the budget: the cap the grant sets */}
        <span aria-hidden="true" className="absolute top-[5px] h-5 w-px -translate-x-1/2 bg-navy-50" style={{ left: `${pct(budget)}%` }} />
        <span
          aria-hidden="true"
          className="absolute top-[26px] whitespace-nowrap text-t12 leading-none text-navy-200"
          style={pct(budget) > 60 ? { right: `calc(${100 - pct(budget)}% + 6px)` } : { left: `calc(${pct(budget)}% + 6px)` }}
        >
          Budget
        </span>
      </div>
      <p className="flex items-start gap-s2 text-t12 text-navy-200">
        <Lamp tone={state === 'over' ? 'loss-3' : state === 'tight' ? 'loss-1' : 'navy-200'} size={6} className="mt-[5px]" />
        <span>
          <span className="tabular-nums text-navy-50">{fmtPct(share)}</span> used. {status}
        </span>
      </p>
    </div>
  );
}
