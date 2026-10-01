import { describe, expect, it } from 'vitest';
import { landingData } from '@/components/landing/data';
import { SOURCES, sourceNumber } from '@/components/landing/sources';

describe('landing data', () => {
  it('the diagram trade clears on both sides with 39-cell books', async () => {
    const d = await landingData();
    const { buyer, seller, series, qty, premium } = d.trade;
    expect(series).toBe('NVDA 225C');
    expect(qty).toBe(1);
    expect(premium).toBeCloseTo(6.579482, 6);
    for (const side of [buyer, seller]) {
      expect(side.cells).toHaveLength(39);
      expect(side.imAfter).toBeLessThanOrEqual(side.equity);
    }
    // the trade adds margin to the buyer's book, as the trade view shows
    expect(buyer.imBefore).toBeCloseTo(656.25, 2);
    expect(buyer.imAfter).toBeCloseTo(661.61, 2);
  });

  it('the hero crown widens from regular to weekend on the same book', async () => {
    const d = await landingData();
    expect(d.ims.REGULAR).toBeCloseTo(656.25, 2);
    expect(d.ims.WEEKEND).toBeCloseTo(1350.99, 2);
    expect(d.grids.WEEKEND.session).toBe('WEEKEND');
    expect(d.gas.find((r) => r.positions === 256)?.solidityOptimized).toBe(23_269_339);
  });

  it('footnotes are numbered in list order and each has a public link or is the demo note', () => {
    SOURCES.forEach((s, i) => {
      expect(sourceNumber(s.id)).toBe(i + 1);
      if (s.id !== 'demo') expect(s.links.length).toBeGreaterThan(0);
      for (const l of s.links) expect(l.href).toMatch(/^https:\/\//);
    });
  });
});
