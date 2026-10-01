import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/*
 * The default waterfall as a cascade. The unpaid loss pours into the first basin; what that basin
 * cannot hold spills over its lip, one step to the right, into the next. Each row draws its own
 * piece, and a bar under it stretches with the row's text, so the labels stay at reading size on
 * a phone instead of shrinking with a single drawing.
 */

const STREAM = 'var(--color-loss-2)';
const COL = 132;
const TOP = 26;
const FLOOR = 74;
const H = 92;

/** The stream between two pieces, at x with width w, as tall as the row's text needs. */
function Bar({ x, w }: { x: number; w: number }) {
  return <span aria-hidden="true" className="block flex-1" style={{ width: w, marginLeft: x - w / 2, background: STREAM, minHeight: 12 }} />;
}

function Source({ x, w }: { x: number; w: number }) {
  return (
    <svg width={COL} height={56} viewBox={`0 0 ${COL} 56`} aria-hidden="true" className="block">
      <rect x={x - w / 2} y={26} width={w} height={30} fill={STREAM} />
      <circle cx={x} cy={18} r={13} fill="var(--color-navy-800)" stroke="var(--color-loss-3)" strokeWidth={2} />
      <circle cx={x} cy={18} r={4.5} fill="var(--color-loss-3)" />
    </svg>
  );
}

/**
 * An open basin from `left` to `left + 56`. The stream arrives at `inX` (width `inW`) and fills it to
 * near the lip; the rest spills over the right lip and falls at `outX` with width `outW`.
 */
function Basin({ id, left, inX, inW, outX, outW }: { id: string; left: number; inX: number; inW: number; outX: number; outW: number }) {
  const right = left + 56;
  const level = TOP + 9;
  return (
    <svg width={COL} height={H} viewBox={`0 0 ${COL} ${H}`} aria-hidden="true" className="block overflow-visible">
      <defs>
        <pattern id={id} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="5" stroke="var(--color-loss-2)" strokeWidth="1.6" />
        </pattern>
      </defs>
      <rect x={inX - inW / 2} y={0} width={inW} height={level} fill={STREAM} />
      <rect x={left + 1} y={level} width={right - left - 2} height={FLOOR - level} fill={`url(#${id})`} />
      <line x1={left + 1} x2={right - 1} y1={level} y2={level} stroke="var(--color-loss-2)" strokeWidth={1.5} />
      <path
        d={`M${right - 4} ${level - outW / 2 + 1}Q${outX} ${level - outW / 2 + 1} ${outX} ${level + 10}V${H}`}
        fill="none"
        stroke={STREAM}
        strokeWidth={outW}
      />
      <path
        d={`M${left} ${TOP - 4}V${FLOOR - 4}Q${left} ${FLOOR} ${left + 4} ${FLOOR}H${right - 4}Q${right} ${FLOOR} ${right} ${FLOOR - 4}V${TOP - 4}`}
        fill="none"
        stroke="var(--color-navy-200)"
        strokeWidth={1.5}
        strokeLinecap="round"
      />
    </svg>
  );
}

/** The last step is everyone: the thin remainder fans out over every cash balance, pro rata. */
function Spread({ inX, inW }: { inX: number; inW: number }) {
  const n = 9;
  const xs = Array.from({ length: n }, (_, i) => 10 + (i * (COL - 20)) / (n - 1));
  return (
    <svg width={COL} height={80} viewBox={`0 0 ${COL} 80`} aria-hidden="true" className="block">
      <rect x={inX - inW / 2} y={0} width={inW} height={20} fill={STREAM} />
      {xs.map((x) => (
        <path key={x} d={`M${inX} 20C${inX} 40 ${x} 36 ${x} 58`} fill="none" stroke={STREAM} strokeWidth={1} strokeOpacity={0.9} />
      ))}
      {xs.map((x) => (
        <circle key={`d${x}`} cx={x} cy={64} r={4.5} fill="var(--color-navy-50)" stroke="var(--color-navy-900)" strokeWidth={2} />
      ))}
    </svg>
  );
}

/* stream positions: each spill lands one step to the right */
const S0 = { x: 28, w: 14 };
const S1 = { x: 72, w: 6 };
const S2 = { x: 112, w: 2.5 };

interface Tier {
  title: string;
  body: ReactNode;
  graphic: ReactNode;
  /** The stream leaving the row, if any. */
  out: { x: number; w: number } | null;
}

/** `idPrefix` keeps the hatch pattern ids unique if the diagram appears twice on a page. */
export function WaterfallDiagram({ className, idPrefix = 'waterfall' }: { className?: string; idPrefix?: string }) {
  const uid = idPrefix;
  const tiers: Tier[] = [
    {
      title: 'An account owes more than it holds',
      body: 'A net payer at expiry can’t cover its payoff, or a liquidation finds equity below zero.',
      graphic: <Source x={S0.x} w={S0.w} />,
      out: S0,
    },
    {
      title: 'First, the defaulter’s own collateral',
      body: (
        <>
          Sold by Dutch auction: by default the discount rises from 2% to 12% over 30 minutes. Proceeds repay the expiry pool first. No bids are
          taken on weekends or while the underlying is halted, so nothing sells without a live price.
        </>
      ),
      graphic: <Basin id={`${uid}-b1`} left={8} inX={S0.x} inW={S0.w} outX={S1.x} outW={S1.w} />,
      out: S1,
    },
    {
      title: 'Then the insurance fund',
      body: 'Filled by a share of every trading fee and by liquidation penalties. At settlement it bridges the shortfall as far as its balance goes, and the sale repays it after the pool.',
      graphic: <Basin id={`${uid}-b2`} left={48} inX={S1.x} inW={S1.w} outX={S2.x} outW={S2.w} />,
      out: S2,
    },
    {
      title: 'Last, every cash balance, pro rata',
      body: 'Only if the collateral and the fund run out: one cash index scales every account’s USDG cash down by the same fraction, and the chain emits LossSocialized.',
      graphic: <Spread inX={S2.x} inW={S2.w} />,
      out: null,
    },
  ];

  return (
    <figure className={className}>
      <ol aria-label="Default waterfall, in order">
        {tiers.map((t, i) => (
          <li key={t.title} className="grid grid-cols-[132px_1fr] gap-x-s5 md:gap-x-s6">
            <div className="flex flex-col">
              {t.graphic}
              {t.out ? <Bar x={t.out.x} w={t.out.w} /> : null}
            </div>
            <div className={cn('pb-s6', i === 0 ? 'pt-1' : 'pt-[22px]')}>
              <p className="text-t17 font-semibold text-navy-50">
                {i > 0 ? <span className="sr-only">Tier {i}: </span> : null}
                {t.title}
              </p>
              <p className="mt-s2 max-w-[48ch] text-t15 text-navy-200">{t.body}</p>
            </div>
          </li>
        ))}
      </ol>
      <figcaption className="mt-s2 max-w-[56ch] text-t13 text-navy-200">
        The orange stream is the unpaid loss. Each basin keeps what it can and spills the rest to the next. The order is fixed in the contracts,
        and no step needs an admin to run it.
      </figcaption>
    </figure>
  );
}
