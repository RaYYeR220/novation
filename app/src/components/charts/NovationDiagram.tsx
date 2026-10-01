'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { cn } from '@/lib/cn';
import { fmtNumber } from '@/lib/format';
import { CELLS, PRICE_POINTS, VOL_POINTS, rampColor, worstCell } from '@/lib/scenario';
import styles from './novation-diagram.module.css';

export interface NovationSide {
  /** "Buyer" / "Seller". */
  role: string;
  /** Who it is: "Account 7". */
  name: string;
  /** The side's whole book after the trade, 39 scenario P&Ls (index = v*13 + j). */
  cells: number[];
  imAfter: number;
  equity: number;
}

export interface NovationDiagramProps {
  /** "NVDA 225C". */
  series: string;
  qty: number;
  premium: number;
  buyer: NovationSide;
  seller: NovationSide;
  className?: string;
}

type Pt = { x: number; y: number };
type Anchor = 'start' | 'middle' | 'end';
interface Label extends Pt {
  anchor: Anchor;
  rotate?: number;
}

/** Everything the drawing places, for one orientation. */
interface Geo {
  w: number;
  h: number;
  nodeR: number;
  hubR: number;
  buyer: Pt;
  hub: Pt;
  seller: Pt;
  arc: string;
  arcLabel: Label;
  legs: [[Pt, Pt], [Pt, Pt]];
  legLabels: [Label, Label];
  payLabels: [Label, Label];
  nodeLabels: [Label, Label];
  hubLabel: Label;
  grids: [Pt, Pt];
  gridLabels: [Label, Label] | null;
  readouts: [Label, Label];
  signal: Pt;
  wires: [string, string];
  wireLabels: [Label, Label] | null;
  settled: Label;
}

const CELL_W = 16;
const CELL_H = 12;
const GAP = 3;
const GRID_W = PRICE_POINTS * (CELL_W + GAP) - GAP;
const GRID_H = VOL_POINTS * (CELL_H + GAP) - GAP;

const WIDE: Geo = (() => {
  const y = 96;
  const buyer = { x: 140, y };
  const hub = { x: 560, y };
  const seller = { x: 980, y };
  const gy = 236;
  const sig = { x: 560, y: 254 };
  return {
    w: 1120,
    h: 330,
    nodeR: 28,
    hubR: 40,
    buyer,
    hub,
    seller,
    arc: `M${buyer.x} ${y - 30}C300 -18 820 -18 ${seller.x} ${y - 30}`,
    arcLabel: { x: 560, y: 30, anchor: 'middle' },
    legs: [
      [{ x: buyer.x + 28, y }, { x: hub.x - 40, y }],
      [{ x: hub.x + 40, y }, { x: seller.x - 28, y }],
    ],
    legLabels: [
      { x: 344, y: y - 12, anchor: 'middle' },
      { x: 776, y: y - 12, anchor: 'middle' },
    ],
    payLabels: [
      { x: 344, y: y + 24, anchor: 'middle' },
      { x: 776, y: y + 24, anchor: 'middle' },
    ],
    nodeLabels: [
      { x: buyer.x, y: y + 52, anchor: 'middle' },
      { x: seller.x, y: y + 52, anchor: 'middle' },
    ],
    hubLabel: { x: hub.x, y: y + 66, anchor: 'middle' },
    grids: [
      { x: buyer.x - GRID_W / 2, y: gy },
      { x: seller.x - GRID_W / 2, y: gy },
    ],
    gridLabels: [
      { x: buyer.x - GRID_W / 2, y: gy - 12, anchor: 'start' },
      { x: seller.x - GRID_W / 2, y: gy - 12, anchor: 'start' },
    ],
    readouts: [
      { x: buyer.x - GRID_W / 2, y: gy + GRID_H + 26, anchor: 'start' },
      { x: seller.x - GRID_W / 2, y: gy + GRID_H + 26, anchor: 'start' },
    ],
    signal: sig,
    wires: [
      `M${buyer.x + GRID_W / 2 + 10} ${gy + GRID_H / 2}H${sig.x - 14}`,
      `M${seller.x - GRID_W / 2 - 10} ${gy + GRID_H / 2}H${sig.x + 14}`,
    ],
    wireLabels: [
      { x: (buyer.x + GRID_W / 2 + sig.x) / 2, y: gy + GRID_H / 2 - 10, anchor: 'middle' },
      { x: (seller.x - GRID_W / 2 + sig.x) / 2, y: gy + GRID_H / 2 - 10, anchor: 'middle' },
    ],
    settled: { x: hub.x, y: gy + GRID_H + 26, anchor: 'middle' },
  };
})();

const TALL: Geo = (() => {
  const w = 380;
  const x = 64;
  const buyer = { x, y: 70 };
  const hub = { x, y: 372 };
  const seller = { x, y: 674 };
  const gx = w - GRID_W - 8;
  const sig = { x: w - 40, y: 372 };
  const by = 96;
  const sy = 700;
  return {
    w,
    h: 780,
    nodeR: 24,
    hubR: 32,
    buyer,
    hub,
    seller,
    arc: `M${x - 22} ${buyer.y + 14}C-6 300 -6 444 ${x - 22} ${seller.y - 14}`,
    arcLabel: { x: 36, y: 214, anchor: 'middle', rotate: -90 },
    legs: [
      [{ x, y: buyer.y + 24 }, { x, y: hub.y - 32 }],
      [{ x, y: hub.y + 32 }, { x, y: seller.y - 24 }],
    ],
    legLabels: [
      { x: x + 22, y: 226, anchor: 'start' },
      { x: x + 22, y: 520, anchor: 'start' },
    ],
    payLabels: [
      { x: x + 22, y: 244, anchor: 'start' },
      { x: x + 22, y: 538, anchor: 'start' },
    ],
    nodeLabels: [
      { x: x + 40, y: buyer.y - 4, anchor: 'start' },
      { x: x + 40, y: seller.y - 4, anchor: 'start' },
    ],
    hubLabel: { x: x + 48, y: hub.y - 6, anchor: 'start' },
    grids: [
      { x: gx, y: by },
      { x: gx, y: sy },
    ],
    gridLabels: null,
    readouts: [
      { x: gx, y: by + GRID_H + 22, anchor: 'start' },
      { x: gx, y: sy + GRID_H + 22, anchor: 'start' },
    ],
    signal: sig,
    wires: [`M${sig.x} ${by + GRID_H + 34}V${sig.y - 26}`, `M${sig.x} ${sy - 12}V${sig.y + 26}`],
    wireLabels: null,
    settled: { x: x + 48, y: hub.y + 52, anchor: 'start' },
  };
})();

/** Cells light in a sweep across price, all three vol rows together. */
function sweepOrder(i: number): number {
  const v = Math.floor(i / PRICE_POINTS);
  const j = i % PRICE_POINTS;
  return j * VOL_POINTS + v;
}

function Grid({ at, cells, side }: { at: Pt; cells: number[]; side: 0 | 1 }) {
  const scale = Math.max(1, ...cells.map((c) => Math.abs(c)));
  const worst = worstCell(cells).index;
  return (
    <g className={styles.grid}>
      {cells.slice(0, CELLS).map((pnl, i) => {
        const v = Math.floor(i / PRICE_POINTS);
        const j = i % PRICE_POINTS;
        // vol ×1.4 on the top row: the stressed row reads first
        const x = at.x + j * (CELL_W + GAP);
        const y = at.y + (VOL_POINTS - 1 - v) * (CELL_H + GAP);
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={CELL_W}
            height={CELL_H}
            rx={2}
            className={styles.cell}
            style={{ '--c': rampColor(pnl, scale), '--k': sweepOrder(i) + side * 2 } as CSSProperties}
          />
        );
      })}
      {(() => {
        const v = Math.floor(worst / PRICE_POINTS);
        const j = worst % PRICE_POINTS;
        return (
          <rect
            x={at.x + j * (CELL_W + GAP) - 2.5}
            y={at.y + (VOL_POINTS - 1 - v) * (CELL_H + GAP) - 2.5}
            width={CELL_W + 5}
            height={CELL_H + 5}
            rx={3.5}
            className={styles.worst}
          />
        );
      })()}
    </g>
  );
}

function Txt({ at, className, children }: { at: Label; className?: string; children: React.ReactNode }) {
  return (
    <text
      x={at.x}
      y={at.y}
      textAnchor={at.anchor}
      transform={at.rotate ? `rotate(${at.rotate} ${at.x} ${at.y})` : undefined}
      className={className}
    >
      {children}
    </text>
  );
}

function Drawing({ g, props, className }: { g: Geo; props: NovationDiagramProps; className?: string }) {
  const { series, qty, premium, buyer, seller } = props;
  const sides: readonly [NovationSide, NovationSide] = [buyer, seller];
  const side = (k: number) => (k === 0 ? sides[0] : sides[1]);
  const [l0, l1] = g.legs;
  const travel = {
    '--mx': `${g.hub.x - l0[0].x}px`,
    '--my': `${g.hub.y - l0[0].y}px`,
    '--ex': `${l1[1].x - l0[0].x}px`,
    '--ey': `${l1[1].y - l0[0].y}px`,
  } as CSSProperties;
  const p = fmtNumber(premium);
  return (
    <svg viewBox={`0 0 ${g.w} ${g.h}`} className={cn(styles.svg, className)} aria-hidden="true">
      {/* the quote both sides agreed: drawn first, then demoted to a dashed trace */}
      <path d={g.arc} pathLength={1} className={styles.arcDraw} />
      <path d={g.arc} className={styles.arcTrace} />
      <Txt at={g.arcLabel} className={cn(styles.small, styles.arcLabel)}>
        {g.arcLabel.rotate ? `Quote: ${qty} ${series} at ${p}` : `Quote agreed: buy ${qty} ${series} at ${p}`}
      </Txt>

      {/* the two legs that replace it: each side faces the clearinghouse */}
      {g.legs.map(([a, b], k) => (
        <g key={k}>
          <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={styles.wireBase} />
          <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} pathLength={1} className={styles.leg} />
        </g>
      ))}
      {g.legLabels.map((at, k) => (
        <Txt key={k} at={at} className={cn(styles.label, styles.legLabel)}>
          {k === 0 ? `+${qty}` : `−${qty}`} {series} against Novation
        </Txt>
      ))}
      {g.payLabels.map((at, k) => (
        <Txt key={k} at={at} className={cn(styles.small, styles.payLabel)}>
          {k === 0 ? `pays ${p} USDG` : `receives ${p} USDG`}
        </Txt>
      ))}

      {/* premium in transit */}
      <circle cx={l0[0].x} cy={l0[0].y} r={5} className={styles.coin} style={travel} />

      {/* nodes */}
      {[g.buyer, g.seller].map((n, k) => (
        <g key={k}>
          <circle cx={n.x} cy={n.y} r={g.nodeR} className={styles.node} />
          <circle cx={n.x} cy={n.y} r={g.nodeR * 0.32} className={styles.nodeCore} />
        </g>
      ))}
      {g.nodeLabels.map((at, k) => (
        <Txt key={k} at={at} className={styles.label}>
          <tspan className={styles.strong}>{side(k).role}</tspan>
          <tspan x={at.x} dy={18} className={styles.muted}>
            {side(k).name}
          </tspan>
        </Txt>
      ))}

      {/* the clearinghouse */}
      <circle cx={g.hub.x} cy={g.hub.y} r={g.hubR + 9} className={styles.hubHalo} />
      <circle cx={g.hub.x} cy={g.hub.y} r={g.hubR} className={styles.hub} />
      <circle cx={g.hub.x} cy={g.hub.y} r={g.hubR * 0.36} className={styles.hubCore} />
      <Txt at={g.hubLabel} className={styles.hubName}>
        Novation
      </Txt>

      {/* each book's stress grid, feeding the signal */}
      {g.grids.map((at, k) => (
        <Grid key={k} at={at} cells={side(k).cells} side={k as 0 | 1} />
      ))}
      {g.gridLabels?.map((at, k) => (
        <Txt key={k} at={at} className={cn(styles.small, styles.muted)}>
          {k === 0 ? 'Buyer’s whole book, 39 scenarios' : 'Seller’s whole book, 39 scenarios'}
        </Txt>
      ))}
      {g.readouts.map((at, k) => (
        <Txt key={k} at={at} className={cn(styles.label, styles.readout)}>
          IM {fmtNumber(side(k).imAfter)} ≤ equity {fmtNumber(side(k).equity)}
        </Txt>
      ))}
      {g.wires.map((d, k) => (
        <g key={k}>
          <path d={d} className={styles.wireBase} />
          <path d={d} pathLength={1} className={styles.wire} />
        </g>
      ))}
      {g.wireLabels?.map((at, k) => (
        <Txt key={k} at={at} className={cn(styles.small, styles.wireLabel)}>
          margin check passes
        </Txt>
      ))}

      {/* signal head: hold until both checks pass, then clear */}
      <g>
        <rect x={g.signal.x - 12} y={g.signal.y - 24} width={24} height={48} rx={12} className={styles.signalHead} />
        <circle cx={g.signal.x} cy={g.signal.y - 11} r={6.5} className={styles.hold} />
        <circle cx={g.signal.x} cy={g.signal.y + 11} r={6.5} className={styles.clear} />
      </g>
      <Txt at={g.settled} className={cn(styles.label, styles.settled)}>
        Route clear, settled in USDG
      </Txt>
    </svg>
  );
}

const STEPS = [
  {
    title: 'Stress-test the whole book',
    body: 'Each side’s options and collateral are re-priced across 13 price shocks and 3 volatility shocks. The worst of the 39, with a floor for short options, sets its initial margin.',
  },
  {
    title: 'Refuse before risk',
    body: 'If either side’s initial margin would exceed its equity, the transaction reverts. Nothing half-clears, and no position exists without its check.',
  },
  {
    title: 'Settle in USDG',
    body: 'Premium and fees move in the same transaction. Each side now holds its position against Novation, not against the other trader.',
  },
];

type State = 'static' | 'ready' | 'play';

/**
 * Buyer and seller agree a quote; Novation replaces it with two positions against itself, stress-tests
 * both whole books across 39 scenarios, and only then clears the route. Plays once on view.
 */
export function NovationDiagram(props: NovationDiagramProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<State>('static');
  const [run, setRun] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (mq.matches || typeof IntersectionObserver === 'undefined') return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- arm the animation only once JS runs; the server render is the final pose
    setState('ready');
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) {
          setState('play');
          io.disconnect();
        }
      },
      { threshold: 0.45 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const { buyer, seller, series, qty, premium } = props;
  const summary =
    `Buyer ${buyer.name} and the ${seller.name.toLowerCase()} agree ${qty} ${series} at ${fmtNumber(premium)} USDG. ` +
    `Novation replaces the quote with two positions against itself: +${qty} for the buyer, −${qty} for the seller. ` +
    `Both whole books are re-priced across 39 scenarios: the buyer’s initial margin is ${fmtNumber(buyer.imAfter)} against equity ${fmtNumber(buyer.equity)}, ` +
    `the seller’s ${fmtNumber(seller.imAfter)} against ${fmtNumber(seller.equity)}. Both pass, the route clears and premium settles in USDG.`;

  return (
    <div className={cn('reveal', props.className)}>
      <figure key={run} ref={ref} className={styles.stage} data-state={state}>
        <div role="img" aria-label={summary}>
          <Drawing g={WIDE} props={props} className="hidden lg:block" />
          <Drawing g={TALL} props={props} className="mx-auto block max-w-[400px] lg:hidden" />
        </div>
        <figcaption className="mt-s7">
          <ol className="grid gap-s6 md:grid-cols-3 md:gap-0">
            {STEPS.map((s, i) => (
              <li key={s.title} className={cn(styles.step, 'border-t border-navy-50/10 pt-s4 md:pr-s7')} style={{ '--n': i } as CSSProperties}>
                <span className="flex items-center gap-s3 text-t15 font-semibold text-navy-50">
                  <span aria-hidden="true" className={styles.stepLamp} />
                  <span>
                    <span className="sr-only">Step {i + 1}: </span>
                    {s.title}
                  </span>
                </span>
                <p className="mt-s2 max-w-[42ch] text-t15 text-navy-200">{s.body}</p>
              </li>
            ))}
          </ol>
        </figcaption>
      </figure>
      {state === 'play' ? (
        <button
          type="button"
          onClick={() => setRun((r) => r + 1)}
          className="mt-s5 rounded-control text-t13 font-medium text-navy-200 underline decoration-navy-400 underline-offset-4 transition-colors duration-(--duration-fast) hover:text-navy-50 motion-reduce:hidden"
        >
          Play the clearing again
        </button>
      ) : null}
    </div>
  );
}
