import { describe, expect, it } from 'vitest';
import { MockClient } from '@/lib/client/mock';
import account7 from '@/fixtures/account7.json';
import whatifs from '@/fixtures/whatifs.json';
import { worstCell } from '@/lib/scenario';

const c = new MockClient();
const HEDGE_BOT = '0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0';

describe('MockClient', () => {
  it('returns typed data from every method', async () => {
    const us = await c.underlyings();
    expect(us.map((u) => u.symbol)).toEqual(['NVDA', 'TSLA', 'SPY', 'AAPL']);
    const ch = await c.chain('NVDA');
    expect(ch.expiries).toHaveLength(4);
    expect(ch.series.every((s) => s.ask >= s.bid && s.bid >= 0)).toBe(true);
    expect((await c.chain('NVDA', ch.expiries[0])).series.length).toBeLessThan(ch.series.length);
    expect((await c.vaults()).length).toBeGreaterThan(0);
    expect((await c.agents(7))[0]?.label).toBe('hedge-bot');
    expect((await c.protocol()).openInterestUsd).toBeGreaterThan(0);
    expect((await c.refusalsFeed()).length).toBeGreaterThan(0);
    expect(await c.asOf()).toBe(1790697600);
    const gas = await c.gasTable();
    expect(gas.find((r) => r.positions === 64)?.stylus).toBe(351072);
  });

  it('account 7 IM equals the fixture and the grid agrees', async () => {
    const a = await c.account(7);
    expect(a.state.im).toBe(account7.summary.im_regular);
    expect(a.positions).toHaveLength(4);
    const g = await c.scenarioGrid(7);
    expect(g.cells).toHaveLength(39);
    expect(worstCell(g.cells).index).toBe(a.state.worstScenario);
    const w = await c.scenarioGrid(7, 'WEEKEND');
    expect(w.session).toBe('WEEKEND');
    expect(-Math.min(...w.cells)).toBeGreaterThan(-Math.min(...g.cells));
    expect(account7.summary.im_weekend).toBeGreaterThan(account7.summary.im_regular);
  });

  it('market maker grid has 39 cells', async () => {
    expect((await c.scenarioGrid(1)).cells).toHaveLength(39);
  });

  it('what-if: the canned ticket is exact and refused, unknown tickets are approximate', async () => {
    const series = (await c.account(7)).positions[0]!;
    const exact = await c.whatIf(7, series.seriesId, -60, 0, HEDGE_BOT);
    expect(exact.approx).toBe(false);
    expect(exact.refusal?.code).toBe('AgentRiskBudgetExceeded');
    const approx = await c.whatIf(7, series.seriesId, -1, 1);
    expect(approx.approx).toBe(true);
  });

  it('what-if: the budget refusal belongs to the agent; the owner clears the same ticket', async () => {
    const series = (await c.account(7)).positions[0]!;
    const owner = await c.whatIf(7, series.seriesId, -60, 0);
    expect(owner.refusal).toBeUndefined();
    expect(owner.after.im).toBe(whatifs[0]!.quote.after.im);
    await expect(c.whatIf(7, series.seriesId, -60, 0, '0x' + '11'.repeat(20))).rejects.toThrow(/no grant/);
  });

  it('what-if: every quote carries the after-trade grid, anchored on the exact grid', async () => {
    const a = await c.account(7);
    const g = (await c.scenarioGrid(7)).cells;
    const q = await c.whatIf(7, a.positions[0]!.seriesId, -60, 0, HEDGE_BOT);
    expect(q.afterGrid).toHaveLength(39);
    expect(worstCell(q.afterGrid!).index).toBe(q.after.worstScenario);
    // IM = worst correlated loss + the short-option minimum (100 NVDA calls, 6 TSLA puts at 1% of spot)
    const shortMin = 100 * 225.57 * 0.01 + 6 * 380.245 * 0.01;
    expect(-worstCell(q.afterGrid!).pnl + shortMin).toBeCloseTo(q.after.im, 4);
    // one more far out-of-the-money long put (NVDA 170) moves no cell by as much as half a USDG
    const tiny = await c.whatIf(7, 2, 1, 0.0001);
    tiny.afterGrid!.forEach((x, i) => expect(Math.abs(x - g[i]!)).toBeLessThan(0.5));
    expect(tiny.afterGrid![26]).toBeGreaterThan(g[26]!);
  });

  it('what-if: an agent over its budget is refused on estimated tickets too', async () => {
    const q = await c.whatIf(7, 5, -80, 2000, HEDGE_BOT);
    expect(q.approx).toBe(true);
    expect(q.refusal?.code).toBe('AgentRiskBudgetExceeded');
    expect(q.refusal!.numbers!.worstLoss).toBeGreaterThan(q.refusal!.numbers!.budget!);
    const small = await c.whatIf(7, 5, 1, 30, HEDGE_BOT);
    expect(small.refusal).toBeUndefined();
  });

  it('what-if: a sale that equity cannot margin is refused, closing it back is not', async () => {
    const q = await c.whatIf(7, 5, -900, 23000);
    expect(q.refusal?.code).toBe('InsufficientMargin');
    expect(q.refusal!.numbers!.im).toBeGreaterThan(q.refusal!.numbers!.equity!);
  });

  it('premium is a positive magnitude; cash moves the same way on exact and approx paths', async () => {
    const a = await c.account(7);
    const call = a.positions[0]!;
    const cash0 = a.state.cash;
    const sellExact = await c.whatIf(7, call.seriesId, -60, 0);
    expect(sellExact.premium).toBeGreaterThan(0);
    expect(sellExact.after.cash).toBeGreaterThan(cash0);
    const sellApprox = await c.whatIf(7, call.seriesId, -1, 10);
    expect(sellApprox.after.cash).toBeCloseTo(cash0 + 10 - sellApprox.fee, 9);
    const buyApprox = await c.whatIf(7, call.seriesId, 1, 10);
    expect(buyApprox.after.cash).toBeCloseTo(cash0 - 10 - buyApprox.fee, 9);
    // The position is valued at the kernel mark, not at the price paid: selling one call below
    // its 25.77 mark moves equity by the premium, less the fee, less that mark.
    expect(sellApprox.after.equity).toBeCloseTo(a.state.equity + 10 - sellApprox.fee - call.mark, 5);
    expect(sellApprox.after.mtm).toBeCloseTo(a.state.mtm - call.mark, 5);
  });

  it('market-maker account(1) works and fixtures are cloned', async () => {
    const mm = await c.account(1);
    expect(mm.positions.length).toBeGreaterThan(0);
    expect(mm.state.im).toBeGreaterThan(0);
    mm.positions.length = 0;
    expect((await c.account(1)).positions.length).toBeGreaterThan(0);
  });

  it('refusal numbers agree across agents, feed and what-if', async () => {
    const series = (await c.account(7)).positions[0]!;
    const wi = (await c.whatIf(7, series.seriesId, -60, 0, HEDGE_BOT)).refusal!;
    const ag = (await c.agents(7))[0]!.lastRefusal!;
    const feed = (await c.refusalsFeed()).find((r) => r.code === 'AgentRiskBudgetExceeded')!;
    expect(ag.numbers).toEqual(wi.numbers);
    expect(feed.numbers).toEqual(wi.numbers);
  });
});
