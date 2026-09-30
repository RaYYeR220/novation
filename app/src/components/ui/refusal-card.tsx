import { useId, type ReactNode } from 'react';
import { fmtNumber } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Lamp } from './lamp';

export interface RefusalBreach {
  /** What the trade asked for: worst-case loss, margin required. */
  attempted: { label: string; value: number };
  /** The rule it broke: budget, equity. The rule is attempted ≤ limit. */
  limit: { label: string; value: number };
  /** How the gap is named: "Over by", "Short by". */
  gapLabel?: string;
}

export interface RefusalCardProps {
  /** The contract's error name, e.g. AgentRiskBudgetExceeded. */
  code: string;
  /** One plain sentence: what was refused and why. */
  reason: ReactNode;
  /** Who and what, e.g. the account and agent. */
  context?: ReactNode;
  /** The numbers that broke the rule. Drawn as a readout and a thread that runs past the limit. */
  breach?: RefusalBreach;
  /** What would clear instead. */
  hint?: ReactNode;
  /** An action that applies the hint, e.g. a resize button. */
  action?: ReactNode;
  /** Link to the refused transaction or simulation. */
  proof?: { href: string; label: string };
  unit?: string;
  format?: (v: number) => string;
  /** Announce on mount (a live refusal right after an action). Off for history lists. */
  announce?: boolean;
  level?: 2 | 3 | 4;
  className?: string;
}

function Thread({ breach, format }: { breach: RefusalBreach; format: (v: number) => string }) {
  const { attempted, limit } = breach;
  const top = Math.max(attempted.value, limit.value) * 1.04 || 1;
  const limitPct = (limit.value / top) * 100;
  const endPct = (attempted.value / top) * 100;
  return (
    <div aria-hidden="true" className="relative mt-s4 h-9" data-thread="">
      {/* limit label hangs left of its tick, or right of it when the tick sits near the start */}
      <span
        className="absolute top-0 whitespace-nowrap text-t12 leading-none text-navy-200"
        style={limitPct < 40 ? { left: `calc(${limitPct}% + 6px)` } : { right: `calc(${100 - limitPct}% + 6px)` }}
      >
        {limit.label} <span className="font-medium tabular-nums text-navy-50">{format(limit.value)}</span>
      </span>
      {/* allowed run: hairline */}
      <span className="absolute left-0 top-[19px] h-px bg-navy-400" style={{ width: `${limitPct}%` }} />
      {/* the breach: the thread keeps going past the limit */}
      <span
        data-overshoot=""
        className="absolute top-[18px] h-0.5 rounded-r-full bg-loss-3"
        style={{ left: `${limitPct}%`, width: `${Math.max(0, endPct - limitPct)}%` }}
      />
      {/* start node, limit tick, end node */}
      <span className="absolute left-0 top-[16px] size-[7px] -translate-x-1/2 rounded-full border border-navy-400 bg-navy-950" />
      <span className="absolute top-[11px] h-4 w-px -translate-x-1/2 bg-navy-50" style={{ left: `${limitPct}%` }} />
      <span
        className="absolute top-[15px] size-2 -translate-x-1/2 rounded-full bg-loss-3 ring-2 ring-navy-950"
        style={{ left: `${endPct}%` }}
      />
      <span
        className="absolute top-[28px] whitespace-nowrap text-t12 leading-none text-navy-200"
        style={{ right: `calc(${100 - endPct}% - 4px)` }}
      >
        {attempted.label}
      </span>
    </div>
  );
}

/**
 * The refusal state. Reads like an instrument: which rule, in plain words, the two numbers that
 * crossed and by how much, and what would have cleared.
 */
export function RefusalCard({
  code,
  reason,
  context,
  breach,
  hint,
  action,
  proof,
  unit = 'USDG',
  format = (v) => fmtNumber(v),
  announce = false,
  level = 3,
  className,
}: RefusalCardProps) {
  const reasonId = useId();
  const Heading = `h${level}` as const;
  const gap = breach ? breach.attempted.value - breach.limit.value : 0;
  // A history list reads refusals as articles; a fresh one is announced as an alert.
  const Root = announce ? 'div' : 'article';

  return (
    <Root
      role={announce ? 'alert' : undefined}
      aria-labelledby={reasonId}
      data-code={code}
      className={cn('min-w-0 rounded-control border border-navy-700 bg-navy-950', className)}
    >
      <header className="flex flex-wrap items-center justify-between gap-x-s4 gap-y-s1 px-s5 pt-s4 max-sm:px-s4">
        <p className="flex items-center gap-s2 text-t13 font-semibold text-navy-50">
          <Lamp tone="loss-3" size={8} />
          Refused
        </p>
        <p className="text-t12 text-navy-200">
          <span className="sr-only">Error code </span>
          <span className="font-medium text-navy-200">{code}</span>
        </p>
      </header>

      <Heading
        id={reasonId}
        className="px-s5 pt-s3 font-display text-[24px] leading-[1.22] font-normal text-balance text-navy-50 max-sm:px-s4 max-sm:text-[21px]"
      >
        {reason}
      </Heading>
      {context && <p className="px-s5 pt-s2 text-t13 text-navy-200 max-sm:px-s4">{context}</p>}

      {breach && (
        <div className="px-s5 pt-s5 max-sm:px-s4">
          <dl className="grid grid-cols-3 gap-s3 max-sm:gap-s2">
            {[
              { k: breach.attempted.label, v: format(breach.attempted.value), tone: 'text-navy-50' },
              { k: breach.limit.label, v: format(breach.limit.value), tone: 'text-navy-50' },
              { k: breach.gapLabel ?? 'Over by', v: format(gap), tone: 'text-loss-1' },
            ].map((r) => (
              <div key={r.k} className="grid content-start gap-s1 border-l border-navy-700 pl-s3 first:border-l-0 first:pl-0">
                <dt className="text-t12 text-navy-200">{r.k}</dt>
                <dd className={cn('text-t20 leading-tight font-semibold tabular-nums max-sm:text-t17', r.tone)}>
                  {r.v}
                  <span className="ml-1 text-t12 font-normal text-navy-200 max-sm:ml-0 max-sm:block">{unit}</span>
                </dd>
              </div>
            ))}
          </dl>
          <Thread breach={breach} format={format} />
        </div>
      )}

      {(hint || action || proof) && (
        <div className="mt-s5 grid gap-s3 border-t border-navy-700 px-s5 py-s4 max-sm:px-s4 sm:grid-cols-[1fr_auto] sm:items-end">
          {hint && (
            <div className="grid gap-s1">
              <p className="flex items-center gap-s2 text-t12 text-navy-200">
                <Lamp tone="navy-200" state="ring" size={6} />
                What would pass
              </p>
              <p className="text-t15 text-pretty text-navy-50">{hint}</p>
            </div>
          )}
          {(action || proof) && (
            <div className="flex flex-wrap items-center gap-s4">
              {proof && (
                <a
                  href={proof.href}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-[2px] text-t13 text-navy-50 underline decoration-navy-400 underline-offset-4 transition-colors duration-(--duration-fast) ui-hover:decoration-cyan"
                >
                  {proof.label}{' '}
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              )}
              {action}
            </div>
          )}
        </div>
      )}
      {!(hint || action || proof) && <div className="pb-s5" />}
    </Root>
  );
}
