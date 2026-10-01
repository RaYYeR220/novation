import { describe, expect, it } from 'vitest';
import type { AccountState } from '@/lib/client/types';
import { cashDelta, marginDelta, perContract, sharedScale, toPct } from '@/lib/margin';

// Literal copies of account 7 and of the canned ticket (60 NVDA 200 calls sold), so a fixture
// regeneration can't silently change what these assertions mean.
const now: AccountState = {
  cash: 2400,
  mtm: 7921.599641,
  settledValue: 2400,
  deficit: 0,
  equity: 10321.599641,
  im: 656.252198,
  mm: 492.189148,
  worstScenario: 26,
  healthy: true,
  liquidatable: false,
};
const after: AccountState = {
  cash: 3945.411608,
  mtm: 6375.414942,
  settledValue: 3945.411608,
  deficit: 0,
  equity: 10320.82655,
  im: 1741.603995,
  mm: 1306.202996,
  worstScenario: 38,
  healthy: true,
  liquidatable: false,
};

describe('margin delta', () => {
  it('reports each figure now, after and the change', () => {
    const d = marginDelta(now, after);
    expect(d.im.now).toBe(656.252198);
    expect(d.im.after).toBe(1741.603995);
    expect(d.im.change).toBeCloseTo(1085.351797, 6);
    expect(d.equity.change).toBeCloseTo(-0.773091, 6);
    expect(d.mm.change).toBeCloseTo(814.013848, 6);
    // free margin = equity - IM
    expect(d.free.now).toBeCloseTo(9665.347443, 6);
    expect(d.free.after).toBeCloseTo(8579.222555, 6);
    expect(d.free.change).toBeCloseTo(-1086.124888, 6);
  });

  it('measures IM as a share of equity', () => {
    const d = marginDelta(now, after);
    expect(d.usage.now).toBeCloseTo(0.06358, 5);
    expect(d.usage.after).toBeCloseTo(0.16875, 5);
    expect(marginDelta(now, { ...after, equity: 0 }).usage.after).toBe(Infinity);
  });

  it('names the zone and the direction it moves', () => {
    expect(marginDelta(now, after)).toMatchObject({ zone: { now: 'clear', after: 'clear' }, shift: 'same' });
    const short = { ...after, equity: 1500 };
    expect(marginDelta(now, short)).toMatchObject({ zone: { after: 'restricted' }, shift: 'worse' });
    const underMm = { ...after, equity: 1000 };
    expect(marginDelta(now, underMm).zone.after).toBe('liquidatable');
    expect(marginDelta(underMm, now).shift).toBe('better');
  });

  it('shares one round scale end across lanes', () => {
    expect(sharedScale(now, after)).toBe(12000);
    expect(sharedScale(now, undefined)).toBe(12000);
    expect(sharedScale({ ...after, equity: 900, im: 1741.6 })).toBe(2000);
    expect(sharedScale()).toBe(1);
  });

  it('places values on the ruler, clamped', () => {
    expect(toPct(3000, 12000)).toBe(25);
    expect(toPct(-5, 100)).toBe(0);
    expect(toPct(150, 100)).toBe(100);
    expect(toPct(5, 0)).toBe(0);
  });
});

describe('ticket cash', () => {
  it('a sale receives premium and pays the fee', () => {
    expect(cashDelta(1546.1847, 0.773092, -60)).toBeCloseTo(1545.411608, 6);
    expect(now.cash + cashDelta(1546.1847, 0.773092, -60)).toBeCloseTo(after.cash, 6);
  });

  it('a buy pays premium and fee', () => {
    expect(cashDelta(100, 0.05, 2)).toBeCloseTo(-100.05, 9);
  });

  it('prices per contract from the total', () => {
    expect(perContract(1546.1847, -60)).toBeCloseTo(25.769745, 6);
    expect(perContract(10, 0)).toBe(0);
  });
});
