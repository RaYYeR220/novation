/**
 * Geometry, scales, camera fit and motion for the scenario crown. Pure functions only, so the
 * poster, the live scene and the tests share one source of truth for where every node sits.
 *
 * Frame: y up, the crown centred on the origin. Spoke angle 0 points at the viewer (+z) and is the
 * no-move price; negative prices fan out to the left (−x), positive to the right.
 */
import { fmtSigned } from '@/lib/format';
import { CELLS, PRICE_POINTS, VOL_MULTS, VOL_POINTS, cellCoords, rampColor, worstCell } from '@/lib/scenario';

/** Price spokes cover 300°, leaving a 60° gap at the back. */
export const SPAN = (300 * Math.PI) / 180;
/** Ring radius per vol index (×0.7, ×1.0, ×1.4). */
export const RING_RADII = [1.35, 2.05, 2.75] as const;
/** Height of a node whose loss equals `scale.loss`. */
export const MAX_HEIGHT = 1.45;
/** Node ring (torus centreline) radius and tube radius. */
export const NODE_RADIUS = 0.2;
export const NODE_TUBE = 0.042;
/** Hub bezel radius; spokes leave the bezel at their price angle. */
export const HUB_RADIUS = 0.62;
/** The cyan IM datum ring. */
export const DATUM_RADIUS = 3.1;
/** Floor the contact shadow sits on, below the deepest possible node or datum. */
export const GROUND_Y = -MAX_HEIGHT - 0.12;

/** Camera: vertical field of view (degrees), elevation above the horizon (radians). */
export const FOV = 28;
export const ELEVATION = 0.42;
/** Rest pose: the crown turned so the loss side swings toward the viewer. Shared by poster and scene. */
export const INITIAL_YAW = 0.55;
/** Idle turn, rad/s. */
export const IDLE_SPEED = 0.08;

export type Vec3 = readonly [number, number, number];

export interface CrownScale {
  /** |loss| that maps to full depth and the end of the loss ramp (includes the IM). */
  loss: number;
  /** gain that maps to the end of the gain ramp. */
  gain: number;
}

/** A shared scale over every grid the crown will show, so heights and colours stay comparable across sessions. */
export function crownScale(grids: readonly (readonly number[])[], ims: readonly number[] = []): CrownScale {
  let loss = 0;
  let gain = 0;
  for (const g of grids)
    for (const v of g) {
      if (v < -loss) loss = -v;
      if (v > gain) gain = v;
    }
  for (const im of ims) if (Math.abs(im) > loss) loss = Math.abs(im);
  return { loss: loss > 0 ? loss : 1, gain: gain > 0 ? gain : 1 };
}

/** Spoke angle for price index j (0 = −R … 12 = +R). */
export function spokeAngle(j: number): number {
  return -SPAN / 2 + (SPAN * j) / (PRICE_POINTS - 1);
}

/** Node height: linear in PnL, one unit for gains and losses so the IM datum is comparable. Clamped at ±MAX_HEIGHT. */
export function nodeHeight(pnl: number, scale: CrownScale): number {
  const t = pnl / scale.loss;
  return MAX_HEIGHT * Math.max(-1, Math.min(1, t));
}

export function nodePosition(v: number, j: number, height: number): Vec3 {
  const r = RING_RADII[v] as number;
  const a = spokeAngle(j);
  return [r * Math.sin(a), height, r * Math.cos(a)];
}

/** Every node position for a grid of 39 cells, flattened [x0,y0,z0, x1,…]. */
export function nodePositions(cells: ArrayLike<number>, scale: CrownScale, out = new Float32Array(CELLS * 3)): Float32Array {
  for (let i = 0; i < CELLS; i++) {
    const { v, j } = cellCoords(i);
    const p = nodePosition(v, j, nodeHeight(cells[i] ?? 0, scale));
    out[i * 3] = p[0];
    out[i * 3 + 1] = p[1];
    out[i * 3 + 2] = p[2];
  }
  return out;
}

/** Diverging ramp coloured on its own side's scale, so small gains stay readable next to large losses. */
export function nodeColor(pnl: number, scale: CrownScale): string {
  return rampColor(pnl, pnl < 0 ? scale.loss : scale.gain);
}

/** The worst scenario: index, value and the node it lives on. */
export function worstNode(cells: readonly number[]): { index: number; pnl: number; v: number; j: number } {
  const w = worstCell(cells);
  return { ...w, ...cellCoords(w.index) };
}

/** Links between neighbouring nodes. `-1 - j` marks the hub socket of spoke j. */
export type Link = readonly [a: number, b: number];

function buildLinks(): Link[] {
  const out: Link[] = [];
  for (let j = 0; j < PRICE_POINTS; j++) {
    out.push([-1 - j, j]);
    for (let v = 0; v < VOL_POINTS - 1; v++) out.push([v * PRICE_POINTS + j, (v + 1) * PRICE_POINTS + j]);
  }
  for (let v = 0; v < VOL_POINTS; v++)
    for (let j = 0; j < PRICE_POINTS - 1; j++) out.push([v * PRICE_POINTS + j, v * PRICE_POINTS + j + 1]);
  return out;
}

/** 13 spoke roots + 26 spoke segments + 36 ring segments = 75 links. */
export const LINKS: readonly Link[] = buildLinks();

/**
 * End points of a link, trimmed to the node rings so tubes meet the chrome instead of piercing the
 * glass. Writes [ax,ay,az,bx,by,bz] into `out` and returns it.
 */
export function linkEnds(link: Link, positions: ArrayLike<number>, out: Float32Array | number[] = new Float32Array(6)) {
  const [a, b] = link;
  const bx = positions[b * 3] as number;
  const by = positions[b * 3 + 1] as number;
  const bz = positions[b * 3 + 2] as number;
  let ax: number;
  let ay: number;
  let az: number;
  if (a < 0) {
    const ang = spokeAngle(-1 - a);
    ax = HUB_RADIUS * Math.sin(ang);
    ay = 0;
    az = HUB_RADIUS * Math.cos(ang);
  } else {
    ax = positions[a * 3] as number;
    ay = positions[a * 3 + 1] as number;
    az = positions[a * 3 + 2] as number;
  }
  const dx = bx - ax;
  const dz = bz - az;
  const h = Math.hypot(dx, dz) || 1;
  const ux = dx / h;
  const uz = dz / h;
  const trimA = a < 0 ? 0 : NODE_RADIUS;
  out[0] = ax + ux * trimA;
  out[1] = ay;
  out[2] = az + uz * trimA;
  out[3] = bx - ux * NODE_RADIUS;
  out[4] = by;
  out[5] = bz - uz * NODE_RADIUS;
  return out;
}

/* ---------- labels ---------- */

const FRACTIONS: Record<number, string> = { 1: '1/6', 2: '1/3', 3: '1/2', 4: '2/3', 5: '5/6' };

/** "price −R", "price −2/3 R", "price 0", "price +R". */
export function priceLabel(j: number): string {
  const k = j - (PRICE_POINTS - 1) / 2;
  if (k === 0) return 'price 0';
  const sign = k < 0 ? '−' : '+';
  const a = Math.abs(k);
  return a === 6 ? `price ${sign}R` : `price ${sign}${FRACTIONS[a]} R`;
}

/** "vol ×0.7", "vol ×1.0", "vol ×1.4". */
export function volLabel(v: number): string {
  return `vol ×${(VOL_MULTS[v] as number).toFixed(1)}`;
}

export function scenarioLabel(i: number): string {
  const { v, j } = cellCoords(i);
  return `${priceLabel(j)}, ${volLabel(v)}`;
}

/** "price −R, vol ×1.4: −759.36 USDG" */
export function describeNode(i: number, pnl: number, unit = 'USDG'): string {
  return `${scenarioLabel(i)}: ${fmtSigned(pnl)} ${unit}`;
}

/* ---------- camera fit ---------- */

export interface Bounds {
  radius: number;
  yMin: number;
  yMax: number;
}

/** Everything the crown can occupy at any turn: node rings, datum ring and the floor shadow. */
export function crownBounds(scale: CrownScale): Bounds {
  return {
    radius: DATUM_RADIUS + 0.06,
    yMin: GROUND_Y,
    yMax: nodeHeight(scale.gain, scale) + NODE_TUBE + 0.08,
  };
}

export interface CameraFit {
  fov: number;
  elevation: number;
  aspect: number;
  distance: number;
  targetY: number;
  /** Vertical shift in NDC applied after projection (+ moves the image up). */
  shiftY: number;
}

export function cameraEye(fit: CameraFit): Vec3 {
  return [0, fit.targetY + fit.distance * Math.sin(fit.elevation), fit.distance * Math.cos(fit.elevation)];
}

/** Rotate a point about +y by `yaw` (same convention as Object3D.rotation.y). */
export function rotateY(p: Vec3, yaw: number): Vec3 {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];
}

/** Project a world point to NDC ([-1, 1], +y up) for a fitted camera. */
export function projectNdc(p: Vec3, fit: CameraFit): [number, number] {
  const s = Math.sin(fit.elevation);
  const c = Math.cos(fit.elevation);
  const qx = p[0];
  const qy = p[1] - (fit.targetY + fit.distance * s);
  const qz = p[2] - fit.distance * c;
  // right = (1,0,0), up = (0,c,-s), forward = (0,-s,-c)
  const xc = qx;
  const yc = qy * c - qz * s;
  const zc = -qy * s - qz * c;
  const t = Math.tan((fit.fov * Math.PI) / 360);
  return [xc / (zc * t * fit.aspect), yc / (zc * t) + fit.shiftY];
}

/** Project a world point to CSS pixels inside a width × height viewport. */
export function projectPx(p: Vec3, fit: CameraFit, width: number, height: number): [number, number] {
  const [x, y] = projectNdc(p, fit);
  return [((x + 1) / 2) * width, ((1 - y) / 2) * height];
}

function boundsSamples(b: Bounds, n = 120): Vec3[] {
  const pts: Vec3[] = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const x = b.radius * Math.sin(a);
    const z = b.radius * Math.cos(a);
    pts.push([x, b.yMin, z], [x, b.yMax, z]);
  }
  return pts;
}

/**
 * Fit the camera so the bounding cylinder fills the viewport at any turn, leaving `margin` (fraction
 * of each half-extent) free on both axes, and centre it vertically. The pose (fov, elevation) is fixed.
 */
export function fitCamera(aspect: number, b: Bounds, margin = { x: 0.04, y: 0.06 }): CameraFit {
  const pts = boundsSamples(b);
  const targetY = (b.yMin + b.yMax) / 2;
  const base = { fov: FOV, elevation: ELEVATION, aspect, targetY, shiftY: 0 };
  const extent = (distance: number) => {
    let xMax = 0;
    let yLo = Infinity;
    let yHi = -Infinity;
    for (const p of pts) {
      const [x, y] = projectNdc(p, { ...base, distance });
      xMax = Math.max(xMax, Math.abs(x));
      yLo = Math.min(yLo, y);
      yHi = Math.max(yHi, y);
    }
    return { xMax, yLo, yHi };
  };
  const over = (d: number) => {
    const e = extent(d);
    return Math.max(e.xMax / (1 - margin.x), (e.yHi - e.yLo) / 2 / (1 - margin.y));
  };
  let lo = b.radius * 1.5 + 1;
  let hi = 400;
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2;
    if (over(mid) > 1) lo = mid;
    else hi = mid;
  }
  const e = extent(hi);
  return { ...base, distance: hi, shiftY: -(e.yHi + e.yLo) / 2 };
}

/** Aspect ratio (w/h) of the fitted bounds with margins; used to size the poster tightly. */
export function naturalAspect(b: Bounds, margin = { x: 0.04, y: 0.06 }): number {
  // Solve for the aspect where both axes touch their margins at once.
  let lo = 0.5;
  let hi = 4;
  for (let k = 0; k < 40; k++) {
    const a = (lo + hi) / 2;
    const fit = fitCamera(a, b, margin);
    let xMax = 0;
    for (const p of boundsSamples(b)) xMax = Math.max(xMax, Math.abs(projectNdc(p, fit)[0]));
    // x has room left: the view is wider than it needs to be
    if (xMax < 1 - margin.x - 1e-4) hi = a;
    else lo = a;
  }
  return (lo + hi) / 2;
}

/** Screen positions of all 39 nodes (CSS px) for a static pose. */
export function projectNodes(
  cells: ArrayLike<number>,
  scale: CrownScale,
  yaw: number,
  width: number,
  height: number,
  out = new Float32Array(CELLS * 2),
): Float32Array {
  const fit = fitCamera(width / height, crownBounds(scale));
  const pos = nodePositions(cells, scale);
  for (let i = 0; i < CELLS; i++) {
    const p = rotateY([pos[i * 3] as number, pos[i * 3 + 1] as number, pos[i * 3 + 2] as number], yaw);
    const [x, y] = projectPx(p, fit, width, height);
    out[i * 2] = x;
    out[i * 2 + 1] = y;
  }
  return out;
}

/** Nearest projected node within `radius` px of (x, y), or -1. */
export function nearestNode(screen: ArrayLike<number>, x: number, y: number, radius = 44): number {
  let best = -1;
  let bestD = radius * radius;
  for (let i = 0; i < CELLS; i++) {
    const dx = (screen[i * 2] as number) - x;
    const dy = (screen[i * 2 + 1] as number) - y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Keyboard stepping: arrows move along price (left/right) and across vol rings (up = outer). */
export function stepNode(i: number, key: string): number {
  const { v, j } = cellCoords(i < 0 ? 19 : i);
  switch (key) {
    case 'ArrowLeft':
      return v * PRICE_POINTS + Math.max(0, j - 1);
    case 'ArrowRight':
      return v * PRICE_POINTS + Math.min(PRICE_POINTS - 1, j + 1);
    case 'ArrowUp':
      return Math.min(VOL_POINTS - 1, v + 1) * PRICE_POINTS + j;
    case 'ArrowDown':
      return Math.max(0, v - 1) * PRICE_POINTS + j;
    case 'Home':
      return v * PRICE_POINTS;
    case 'End':
      return v * PRICE_POINTS + PRICE_POINTS - 1;
    default:
      return i;
  }
}

/* ---------- motion ---------- */

/** Spring used for the session re-seat: settles within ~900 ms with a small overshoot. */
export const SPRING = { omega: 9, zeta: 0.74 } as const;

/**
 * Advance a damped spring toward `target` by `dt` seconds (semi-implicit Euler, sub-stepped for
 * stability). Returns [position, velocity].
 */
export function springStep(x: number, v: number, target: number, dt: number, s: { omega: number; zeta: number } = SPRING): [number, number] {
  const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
  const h = dt / steps;
  for (let k = 0; k < steps; k++) {
    const a = -s.omega * s.omega * (x - target) - 2 * s.zeta * s.omega * v;
    v += a * h;
    x += v * h;
  }
  return [x, v];
}

/** Shortest signed angle from a to b. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Yaw that brings node spoke j to face the viewer slightly left of centre (used by keyboard stepping). */
export function yawFacing(j: number): number {
  return -spokeAngle(j) - 0.25;
}
