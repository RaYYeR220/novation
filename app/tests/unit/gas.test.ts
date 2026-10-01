import { describe, expect, it } from 'vitest';
import gas from '@/fixtures/gas.json';
import { TX_GAS_CAP, fmtGas, fmtGasTick, fmtRatio, tradeGas } from '@/lib/gas';

describe('gas figures', () => {
  it('formats to three significant figures', () => {
    expect(fmtGas(47_397_620)).toBe('47.4M');
    expect(fmtGas(2_812_696)).toBe('2.81M');
    expect(fmtGas(32_000_000)).toBe('32M');
    expect(fmtGas(100_000_000)).toBe('100M');
    expect(fmtGas(131_615)).toBe('132k');
    expect(fmtGasTick(0)).toBe('0');
    expect(fmtGasTick(40_000_000)).toBe('40M');
    expect(fmtRatio(16.85)).toBe('16.9×');
  });

  it('a 256-position trade needs two checks: over the cap in Solidity, well inside it on Stylus', () => {
    const t = tradeGas(gas.rows, 256);
    expect(t.solidity).toBe(2 * 23_698_810);
    expect(t.stylus).toBe(2 * 1_406_348);
    expect(t.solidityOverCap).toBe(true);
    expect(t.stylusOverCap).toBe(false);
    expect(t.solidity).toBeGreaterThan(TX_GAS_CAP);
    expect(fmtGas(t.solidity)).toBe('47.4M');
    expect(fmtGas(t.stylus)).toBe('2.81M');
  });

  it('every single Solidity check measured fits under the cap; the pair at 256 does not', () => {
    for (const r of gas.rows) expect(r.solidityOptimized).toBeLessThan(TX_GAS_CAP);
    expect(tradeGas(gas.rows, 128).solidityOverCap).toBe(false);
  });

  it('refuses a book size that was not measured', () => {
    expect(() => tradeGas(gas.rows, 300)).toThrow(RangeError);
  });
});
