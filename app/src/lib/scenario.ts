/** Helpers for the 39-cell scenario grid: index = volIndex * 13 + priceIndex. */
export const PRICE_POINTS = 13;
export const VOL_POINTS = 3;
export const CELLS = PRICE_POINTS * VOL_POINTS;
export const VOL_MULTS = [0.7, 1.0, 1.4] as const;

export function cellIndex(v: number, j: number): number {
  if (!Number.isInteger(v) || v < 0 || v >= VOL_POINTS) throw new RangeError(`vol index ${v}`);
  if (!Number.isInteger(j) || j < 0 || j >= PRICE_POINTS) throw new RangeError(`price index ${j}`);
  return v * PRICE_POINTS + j;
}

export function cellCoords(i: number): { v: number; j: number } {
  if (!Number.isInteger(i) || i < 0 || i >= CELLS) throw new RangeError(`cell index ${i}`);
  return { v: Math.floor(i / PRICE_POINTS), j: i % PRICE_POINTS };
}

/** Price shock of price index j as a fraction of the shock range: -1 .. +1 in steps of 1/6. */
export function priceShockFraction(j: number): number {
  return (j - 6) / 6;
}

const LOSS = ['#9FB3D9', '#FFB68A', '#FF7A3D', '#FF4400'] as const;
const GAIN = ['#9FB3D9', '#DDEFAE', '#C7E36C', '#9DC93B'] as const;

function hex(h: string): [number, number, number] {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

/** Diverging ramp with its midpoint (zero) at pnl = 0. `scale` is the |pnl| that maps to the end of the ramp. Returns #RRGGBB. */
export function rampColor(pnl: number, scale: number): string {
  const ramp = pnl < 0 ? LOSS : GAIN;
  const t = scale > 0 ? Math.min(1, Math.abs(pnl) / scale) * 3 : 0;
  const i = Math.min(2, Math.floor(t));
  const fr = t - i;
  const a = hex(ramp[i] as string);
  const b = hex(ramp[i + 1] as string);
  const c = a.map((x, k) => Math.round(x + ((b[k] as number) - x) * fr));
  return '#' + c.map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** Index and value of the lowest cell. */
export function worstCell(cells: readonly number[]): { index: number; pnl: number } {
  if (cells.length === 0) throw new RangeError('empty grid');
  let index = 0;
  for (let i = 1; i < cells.length; i++) if ((cells[i] as number) < (cells[index] as number)) index = i;
  return { index, pnl: cells[index] as number };
}
