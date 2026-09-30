import { describe, expect, it } from 'vitest';
import { MockClient } from '@/lib/client/mock';
import account7 from '@/fixtures/account7.json';
import { worstCell } from '@/lib/scenario';

const c = new MockClient();

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
    const gas = await c.gasTable();
    expect(gas.find((r) => r.positions === 64)?.stylus).toBe(386324);
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
    const exact = await c.whatIf(7, series.seriesId, -60, 0);
    expect(exact.approx).toBe(false);
    expect(exact.refusal?.code).toBe('AgentRiskBudgetExceeded');
    const approx = await c.whatIf(7, series.seriesId, -1, 1);
    expect(approx.approx).toBe(true);
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
    expect(sellApprox.after.equity).toBeCloseTo(a.state.equity - sellApprox.fee, 9);
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
    const wi = (await c.whatIf(7, series.seriesId, -60, 0)).refusal!;
    const ag = (await c.agents(7))[0]!.lastRefusal!;
    const feed = (await c.refusalsFeed()).find((r) => r.code === 'AgentRiskBudgetExceeded')!;
    expect(ag.numbers).toEqual(wi.numbers);
    expect(feed.numbers).toEqual(wi.numbers);
  });
});
