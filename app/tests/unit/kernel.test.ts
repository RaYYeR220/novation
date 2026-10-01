import { describe, expect, it } from 'vitest';
import account7 from '@/fixtures/account7.json';
import whatifs from '@/fixtures/whatifs.json';
import underlyings from '@/fixtures/underlyings.json';
import type { Session } from '@/lib/client/types';
import { bsPrice, buildBook, defaultParams, intrinsic, kernelMargin, normCdf, shockRange, withTrade } from '@/lib/kernel';

// tools/ref/gen_app_fixtures.py NOW: the snapshot every fixture is priced at.
const AS_OF = 1790697600;
const acct = account7.account;
const us = (session: Session) => underlyings.map((u) => ({ ...u, session: session as Session }));

describe('float kernel twin', () => {
  it('normal CDF stays inside the Abramowitz-Stegun error bound', () => {
    const exact: [number, number][] = [
      [0, 0.5],
      [1.96, 0.9750021048517795],
      [-1, 0.15865525393145707],
      [3.2, 0.9993128620620841],
    ];
    for (const [x, p] of exact) expect(Math.abs(normCdf(x) - p)).toBeLessThan(7.5e-8);
    expect(normCdf(-8)).toBe(0);
    expect(normCdf(8)).toBe(1);
  });

  it('prices at expiry at intrinsic and puts obey parity', () => {
    expect(bsPrice(225, 200, 0, 0.5, true)).toBe(25);
    expect(bsPrice(180, 200, 0, 0.5, false)).toBe(20);
    expect(intrinsic(180, 200, true)).toBe(0);
    const tau = 6 * 86400;
    const c = bsPrice(225.57, 200, tau, 0.52, true);
    const p = bsPrice(225.57, 200, tau, 0.52, false);
    expect(c - p).toBeCloseTo(225.57 - 200, 10);
  });

  it('marks match the fixture positions', () => {
    for (const p of acct.positions) {
      const u = underlyings.find((x) => x.symbol === p.underlying)!;
      expect(bsPrice(u.spot, p.strike, p.expiry - AS_OF, u.markVol, p.isCall)).toBeCloseTo(p.mark, 5);
    }
  });

  it('shock ranges match the fixture grids', () => {
    for (const s of ['REGULAR', 'EXTENDED', 'WEEKEND'] as const) {
      for (const [sym, r] of Object.entries(account7.grids[s].shockRange)) {
        const u = underlyings.find((x) => x.symbol === sym)!;
        expect(shockRange(u.markVol, s)).toBeCloseTo(r, 6);
      }
    }
  });

  it.each(['REGULAR', 'EXTENDED', 'WEEKEND'] as const)('reproduces account 7 IM and grid (%s)', (session) => {
    const book = buildBook(acct.positions, acct.collateral, us(session));
    const out = kernelMargin(defaultParams(AS_OF), book.us, book.ps);
    const key = { REGULAR: 'im_regular', EXTENDED: 'im_extended', WEEKEND: 'im_weekend' } as const;
    expect(out.lossIM).toBeCloseTo(account7.summary[key[session]], 6);
    expect(out.worstScenario).toBe(account7.summary.worstScenario[session]);
    account7.grids[session].cells.forEach((c, i) => expect(out.grid[i]).toBeCloseTo(c, 6));
    expect(out.mtm).toBeCloseTo(acct.state.mtm, 6);
  });

  it('reproduces the canned what-if: IM, MTM, the after-grid and the agent budget figures', () => {
    const w = whatifs[0]!;
    const before = buildBook(acct.positions, acct.collateral, us('REGULAR'));
    const call = acct.positions.find((p) => p.seriesId === w.seriesId)!;
    const after = withTrade(before, call, w.qtyDelta, us('REGULAR'));
    const kb = kernelMargin(defaultParams(AS_OF), before.us, before.ps);
    const ka = kernelMargin(defaultParams(AS_OF), after.us, after.ps);
    expect(ka.lossIM).toBeCloseTo(w.quote.after.im, 6);
    expect(ka.mtm).toBeCloseTo(w.quote.after.mtm, 6);
    expect(ka.worstScenario).toBe(w.quote.after.worstScenario);
    // the agent budget caps the post-trade lossIM, which is what the refusal reports
    expect(ka.lossIM).toBeCloseTo(w.quote.refusal.numbers.worstLoss, 6);
    expect(kb.lossIM).toBeCloseTo(w.quote.refusal.numbers.used, 6);
    // and the twin's grid agrees with the kernel's after-trade grid
    w.quote.afterGrid.forEach((x, i) => expect(ka.grid[i]).toBeCloseTo(x, 6));
  });

  it('adds a new underlying when the trade is on one the book lacks', () => {
    const before = buildBook(acct.positions, acct.collateral, us('REGULAR'));
    const after = withTrade(before, { underlying: 'AAPL', strike: 340, expiry: AS_OF + 6 * 86400, isCall: false }, -5, us('REGULAR'));
    expect(after.symbols).toEqual([...before.symbols, 'AAPL']);
    expect(before.symbols).not.toContain('AAPL');
    const kb = kernelMargin(defaultParams(AS_OF), before.us, before.ps);
    const ka = kernelMargin(defaultParams(AS_OF), after.us, after.ps);
    expect(ka.lossIM).toBeGreaterThan(kb.lossIM);
  });

  it('closing a position removes it from the book', () => {
    const before = buildBook(acct.positions, acct.collateral, us('REGULAR'));
    const put = acct.positions.find((p) => !p.isCall && p.underlying === 'TSLA')!;
    const after = withTrade(before, put, -put.qty, us('REGULAR'));
    expect(after.ps).toHaveLength(before.ps.length - 1);
  });
});
