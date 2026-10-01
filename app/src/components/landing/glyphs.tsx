import { cn } from '@/lib/cn';

/*
 * Small drawings in the crown's grammar: a hub, spokes, nodes on a ring that opens at the back.
 * Seen from above, price 0 faces the viewer (down), and the 60° gap sits at the top.
 */

const SPAN = 300;
/** Point on a circle, angle in degrees measured from straight down (the viewer), clockwise. */
function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [cx - r * Math.sin(a), cy + r * Math.cos(a)];
}
function arcPath(cx: number, cy: number, r: number, from: number, to: number): string {
  const [x0, y0] = polar(cx, cy, r, from);
  const [x1, y1] = polar(cx, cy, r, to);
  const large = Math.abs(to - from) > 180 ? 1 : 0;
  // angles grow clockwise on screen, which is SVG's positive sweep
  const sweep = to > from ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/** The mark: the outer ring of the crown with seven of its nodes and the hub; the worst node (price down, on the left) in loss-3. */
export function CrownMark({ size = 24, className, title }: { size?: number; className?: string; title?: string }) {
  const c = 12;
  const r = 8.6;
  const nodes = Array.from({ length: 7 }, (_, k) => polar(c, c, r, -SPAN / 2 + (SPAN * k) / 6));
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <path d={arcPath(c, c, r, -SPAN / 2, SPAN / 2)} fill="none" stroke="var(--color-navy-400)" strokeWidth="1.2" />
      {nodes.map(([x, y], k) => (
        <line key={`s${k}`} x1={c} y1={c} x2={x} y2={y} stroke="var(--color-navy-600)" strokeWidth="0.9" />
      ))}
      {nodes.map(([x, y], k) => (
        <circle key={k} cx={x} cy={y} r={1.9} fill={k === 5 ? 'var(--color-loss-3)' : 'var(--color-navy-50)'} />
      ))}
      <circle cx={c} cy={c} r={3.1} fill="var(--color-navy-50)" />
    </svg>
  );
}

const STROKE = 'var(--color-navy-400)';
const NODE_FILL = 'var(--color-navy-800)';

/** Vaults: a node holding the token it writes against, wired to the hub; premium runs back along the spoke. */
export function VaultGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 96 64" className={cn('h-16 w-24', className)} aria-hidden="true">
      <line x1="22" y1="32" x2="74" y2="32" stroke={STROKE} strokeWidth="1.25" />
      {[38, 48, 58].map((x) => (
        <circle key={x} cx={x} cy={32} r={1.8} fill="var(--color-gain-2)" />
      ))}
      <circle cx="74" cy="32" r="8" fill="var(--color-navy-50)" />
      <circle cx="22" cy="32" r="15" fill={NODE_FILL} stroke="var(--color-navy-200)" strokeWidth="1.5" />
      <circle cx="22" cy="32" r="7" fill="none" stroke="var(--color-navy-50)" strokeWidth="1.5" />
      <circle cx="22" cy="32" r="2.6" fill="var(--color-navy-50)" />
    </svg>
  );
}

/** RFQ desk: maker and taker on two spokes of the same hub, never wired to each other. */
export function RfqGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 96 64" className={cn('h-16 w-24', className)} aria-hidden="true">
      <line x1="16" y1="14" x2="60" y2="32" stroke={STROKE} strokeWidth="1.25" />
      <line x1="16" y1="50" x2="60" y2="32" stroke={STROKE} strokeWidth="1.25" />
      <circle cx="16" cy="14" r="8" fill={NODE_FILL} stroke="var(--color-navy-200)" strokeWidth="1.5" />
      <circle cx="16" cy="50" r="8" fill={NODE_FILL} stroke="var(--color-navy-200)" strokeWidth="1.5" />
      <circle cx="60" cy="32" r="10" fill="var(--color-navy-50)" />
      <circle cx="60" cy="32" r="16" fill="none" stroke="var(--color-navy-600)" strokeWidth="1" />
    </svg>
  );
}

/** Agents: a node inside its risk budget, drawn as a ring with the used share lit (1,180 of 1,500 USDG). */
export function AgentGlyph({ used, className }: { used: number; className?: string }) {
  const c = 32;
  const r = 22;
  const end = -180 + 360 * Math.min(0.999, Math.max(0, used));
  return (
    <svg viewBox="0 0 96 64" className={cn('h-16 w-24', className)} aria-hidden="true">
      <circle cx={c} cy={c} r={r} fill="none" stroke="var(--color-navy-700)" strokeWidth="3" />
      <path d={arcPath(c, c, r, -180, end)} fill="none" stroke="var(--color-navy-200)" strokeWidth="3" />
      <line x1={c} y1={c} x2="80" y2={c} stroke={STROKE} strokeWidth="1.25" />
      <circle cx="80" cy={c} r="8" fill="var(--color-navy-50)" />
      <circle cx={c} cy={c} r="8" fill={NODE_FILL} stroke="var(--color-navy-200)" strokeWidth="1.5" />
      <circle cx={c} cy={c} r="2.6" fill="var(--color-navy-50)" />
    </svg>
  );
}
