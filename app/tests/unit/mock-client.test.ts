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

  // The canned ticket: hedge-bot sells 60 NVDA 200 calls through RFQ at the demo maker's mid.
  const canned = whatifs[0]!;
  const asBot = { agent: HEDGE_BOT, venue: 'rfq' as const };
  const shortMin = (calls: number) => calls * 225.57 * 0.01 + 6 * 380.245 * 0.01;

  it('what-if: the canned ticket is exact, refused for the agent, with the kernel after-grid', async () => {
    const q = await c.whatIf(7, canned.seriesId, canned.qtyDelta, canned.premium, asBot);
    expect(q.approx).toBe(false);
    expect(q.refusal?.code).toBe('AgentRiskBudgetExceeded');
    // the budget caps the account's lossIM after the trade (spec 4.7, Clearinghouse _checkBudget)
    expect(q.refusal!.numbers).toEqual({
      worstLoss: q.after.im,
      budget: 1500,
      used: account7.account.state.im,
      remaining: 1500 - account7.account.state.im,
    });
    expect(q.afterGrid).toEqual(canned.quote.afterGrid);
    expect(worstCell(q.afterGrid!).index).toBe(q.after.worstScenario);
    expect(-worstCell(q.afterGrid!).pnl + shortMin(100)).toBeCloseTo(q.after.im, 6);
  });

  it('what-if: the canned quote needs the same venue and a premium within a cent', async () => {
    const near = await c.whatIf(7, canned.seriesId, canned.qtyDelta, canned.premium + 0.004, asBot);
    expect(near.approx).toBe(false);
    for (const q of [
      await c.whatIf(7, canned.seriesId, canned.qtyDelta, canned.premium + 0.5, asBot),
      await c.whatIf(7, canned.seriesId, canned.qtyDelta, canned.premium, { agent: HEDGE_BOT, venue: 'vault' }),
      await c.whatIf(7, canned.seriesId, canned.qtyDelta, canned.premium, { agent: HEDGE_BOT }),
    ]) {
      expect(q.approx).toBe(true);
      expect(q.refusal?.code).toBe('AgentRiskBudgetExceeded');
      expect(q.after.im).toBeCloseTo(canned.quote.after.im, 4);
    }
  });

  it('what-if: the owner clears the same ticket; an agent without a grant is rejected', async () => {
    const owner = await c.whatIf(7, canned.seriesId, canned.qtyDelta, canned.premium, { venue: 'rfq' });
    expect(owner.refusal).toBeUndefined();
    expect(owner.approx).toBe(false);
    expect(owner.after.im).toBe(canned.quote.after.im);
    await expect(c.whatIf(7, canned.seriesId, -60, 0, { agent: '0x' + '11'.repeat(20) })).rejects.toThrow(/no grant/);
  });

  it('what-if: estimates re-price the grid from the exact one and say so', async () => {
    const g = (await c.scenarioGrid(7)).cells;
    const q = await c.whatIf(7, 5, -60, 1543.2, { venue: 'vault' });
    expect(q.approx).toBe(true);
    expect(worstCell(q.afterGrid!).index).toBe(q.after.worstScenario);
    expect(-worstCell(q.afterGrid!).pnl + shortMin(100)).toBeCloseTo(q.after.im, 4);
    // the twin agrees with the kernel on the canned book
    q.afterGrid!.forEach((x, i) => expect(x).toBeCloseTo(canned.quote.afterGrid[i]!, 4));
    const tiny = await c.whatIf(7, 2, 1, 0.0001);
    tiny.afterGrid!.forEach((x, i) => expect(Math.abs(x - g[i]!)).toBeLessThan(0.5));
  });

  it('what-if: agent rules in contract order on estimated tickets', async () => {
    const im0 = account7.account.state.im;
    // post-trade lossIM over maxWorstLoss
    const budget = await c.whatIf(7, 5, -80, 400, asBot);
    expect(budget.refusal?.code).toBe('AgentRiskBudgetExceeded');
    expect(budget.refusal!.numbers).toMatchObject({ worstLoss: budget.after.im, budget: 1500, used: im0 });
    // inside the budget, but the premium is over the 500 per-trade cap
    const premium = await c.whatIf(7, 5, -20, 515, asBot);
    expect(premium.after.im).toBeLessThan(1500);
    expect(premium.refusal).toEqual({
      code: 'AgentPremiumExceeded',
      message: "Premium exceeds the agent's per-trade cap.",
      numbers: { premium: 515, cap: 500 },
    });
    // a cheap premium, but selling 30 calls far under the mark gives away more than the cap
    const drain = await c.whatIf(7, 5, -30, 200, asBot);
    expect(drain.refusal?.code).toBe('AgentValueDrainExceeded');
    const call = account7.account.positions.find((p) => p.seriesId === 5)!;
    expect(drain.refusal!.numbers!.loss).toBeCloseTo(30 * call.mark - 200, 4);
    // an underlying outside the grant
    const tsla = await c.whatIf(7, 126, -1, 8, asBot);
    expect(tsla.refusal?.code).toBe('AgentUnderlyingNotAllowed');
    // a small hedge at a fair price clears
    expect((await c.whatIf(7, 5, 1, 25.7, asBot)).refusal).toBeUndefined();
  });

  it('what-if: a sale that equity cannot margin is refused', async () => {
    const q = await c.whatIf(7, 5, -900, 23000);
    expect(q.refusal?.code).toBe('InsufficientMargin');
    expect(q.refusal!.numbers!.im).toBeGreaterThan(q.refusal!.numbers!.equity!);
  });

  it('premium is a positive magnitude; cash moves the same way on exact and approx paths', async () => {
    const a = await c.account(7);
    const call = a.positions[0]!;
    const cash0 = a.state.cash;
    const sellExact = await c.whatIf(7, call.seriesId, canned.qtyDelta, canned.premium, asBot);
    expect(sellExact.premium).toBeGreaterThan(0);
    expect(sellExact.after.cash).toBeCloseTo(cash0 + canned.premium - sellExact.fee, 6);
    const sellApprox = await c.whatIf(7, call.seriesId, -1, 10);
    expect(sellApprox.after.cash).toBeCloseTo(cash0 + 10 - sellApprox.fee, 9);
    const buyApprox = await c.whatIf(7, call.seriesId, 1, 10);
    expect(buyApprox.after.cash).toBeCloseTo(cash0 - 10 - buyApprox.fee, 9);
    // The position is valued at the kernel mark, not at the price paid: selling one call below
    // its mark moves equity by the premium, less the fee, less that mark.
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

  it('refusal numbers agree across agents, feed and what-if; the grant reports current lossIM as used', async () => {
    expect((await c.agents(7))[0]!.used).toBe(account7.account.state.im);
    const series = (await c.account(7)).positions[0]!;
    const wi = (await c.whatIf(7, series.seriesId, canned.qtyDelta, canned.premium, asBot)).refusal!;
    const ag = (await c.agents(7))[0]!.lastRefusal!;
    const feed = (await c.refusalsFeed()).find((r) => r.code === 'AgentRiskBudgetExceeded')!;
    expect(ag.numbers).toEqual(wi.numbers);
    expect(feed.numbers).toEqual(wi.numbers);
  });
});
