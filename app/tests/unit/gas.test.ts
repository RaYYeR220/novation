import { describe, expect, it } from 'vitest';
import gas from '@/fixtures/gas.json';
import { TX_GAS_CAP, fmtGas, fmtGasTick, fmtRatio, tradeGas } from '@/lib/gas';

describe('gas figures', () => {
  it('formats to three significant figures', () => {
    expect(fmtGas(46_538_678)).toBe('46.5M');
    expect(fmtGas(2_646_216)).toBe('2.65M');
    expect(fmtGas(32_000_000)).toBe('32M');
    expect(fmtGas(100_000_000)).toBe('100M');
    expect(fmtGas(109_700)).toBe('110k');
    expect(fmtGasTick(0)).toBe('0');
    expect(fmtGasTick(40_000_000)).toBe('40M');
    expect(fmtRatio(16.85)).toBe('16.9×');
  });

  it('a 256-position trade needs two checks: over the cap in Solidity, well inside it on Stylus', () => {
    const t = tradeGas(gas.rows, 256);
    expect(t.solidity).toBe(2 * 23_269_339);
    expect(t.stylus).toBe(2 * 1_323_108);
    expect(t.solidityOverCap).toBe(true);
    expect(t.stylusOverCap).toBe(false);
    expect(t.solidity).toBeGreaterThan(TX_GAS_CAP);
    expect(fmtGas(t.solidity)).toBe('46.5M');
    expect(fmtGas(t.stylus)).toBe('2.65M');
  });

  it('every single Solidity check measured fits under the cap; the pair at 256 does not', () => {
    for (const r of gas.rows) expect(r.solidityOptimized).toBeLessThan(TX_GAS_CAP);
    expect(tradeGas(gas.rows, 128).solidityOverCap).toBe(false);
  });

  it('refuses a book size that was not measured', () => {
    expect(() => tradeGas(gas.rows, 300)).toThrow(RangeError);
  });
});
