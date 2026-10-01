import { describe, expect, it } from 'vitest';
import { cellCoords, cellIndex, rampColor, worstCell } from '@/lib/scenario';

describe('scenario grid helpers', () => {
  it('round-trips all 39 indices', () => {
    for (let i = 0; i < 39; i++) {
      const { v, j } = cellCoords(i);
      expect(cellIndex(v, j)).toBe(i);
    }
    expect(cellIndex(1, 6)).toBe(19);
  });

  it('rejects out-of-range coordinates', () => {
    expect(() => cellIndex(3, 0)).toThrow();
    expect(() => cellIndex(0, 13)).toThrow();
    expect(() => cellCoords(39)).toThrow();
  });

  it('ramp midpoint is the zero colour and ends hit the ramp ends', () => {
    expect(rampColor(0, 100)).toBe('#9FB3D9');
    expect(rampColor(-100, 100)).toBe('#FF4400');
    expect(rampColor(100, 100)).toBe('#9DC93B');
    expect(rampColor(-500, 100)).toBe('#FF4400');
  });

  it('finds the worst cell', () => {
    const cells = Array.from({ length: 39 }, (_, i) => i - 10);
    cells[26] = -99;
    expect(worstCell(cells)).toEqual({ index: 26, pnl: -99 });
  });
});
