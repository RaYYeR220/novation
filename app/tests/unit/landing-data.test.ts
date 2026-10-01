import { describe, expect, it } from 'vitest';
import { landingData } from '@/components/landing/data';
import { MockClient } from '@/lib/client/mock';
import { SOURCES, sourceNumber } from '@/components/landing/sources';

describe('landing data', () => {
  it('the diagram trade clears on both sides with 39-cell books', async () => {
    const d = await landingData();
    const { buyer, seller, series, qty, premium } = d.trade;
    expect(series).toBe('NVDA 225C');
    expect(qty).toBe(1);
    expect(premium).toBeCloseTo(4.86094, 6);
    for (const side of [buyer, seller]) {
      expect(side.cells).toHaveLength(39);
      expect(side.imAfter).toBeLessThanOrEqual(side.equity);
    }
    // the trade adds margin to the buyer's book, as the trade view shows
    expect(buyer.imBefore).toBeCloseTo(596.51, 2);
    expect(buyer.imAfter).toBeCloseTo(600.93, 2);
  });

  it('the hero crown widens from regular to weekend on the same book', async () => {
    const d = await landingData();
    expect(d.ims.REGULAR).toBeCloseTo(596.51, 2);
    expect(d.ims.WEEKEND).toBeCloseTo(1373.29, 2);
    expect(d.grids.WEEKEND.session).toBe('WEEKEND');
    expect(d.gas.find((r) => r.positions === 256)?.solidityOptimized).toBe(23_269_339);
  });

  it('the landing figures are the ones the app pages show', async () => {
    const d = await landingData();
    const c = new MockClient();
    // Portfolio and the trade view read account 7's IM per session from the same grids
    expect(d.ims.REGULAR).toBe((await c.scenarioGrid(7, 'REGULAR')).im);
    expect(d.ims.WEEKEND).toBe((await c.scenarioGrid(7, 'WEEKEND')).im);
    expect((await c.account(7)).state.im).toBeCloseTo(d.ims.REGULAR, 6);
    // Agents: hedge-bot's meter (used / budget) and its last refusal; Risk: the refusal feed
    const bot = (await c.agents(7)).find((g) => g.label === 'hedge-bot')!;
    const feed = (await c.refusalsFeed()).find((r) => r.code === 'AgentRiskBudgetExceeded')!;
    expect(d.agent).toEqual({
      label: 'hedge-bot',
      budget: bot.maxWorstLoss,
      imNow: bot.used,
      worstAfter: feed.numbers!.worstLoss,
      ticket: 'sell 60 NVDA 200 calls',
    });
    expect(bot.lastRefusal?.numbers?.worstLoss).toBe(d.agent.worstAfter);
    expect(d.agent.worstAfter).toBeCloseTo(1762.72, 2);
    expect(d.agent.budget).toBe(1500);
    expect(d.agent.imNow).toBeCloseTo(596.51, 2);
    // the protocol strip
    expect(d.protocol).toEqual(await c.protocol());
    expect(d.protocol.openInterestUsd).toBeCloseTo(1_440_900.91, 2);
  });

  it('footnotes are numbered in list order and each has a public link or is the demo note', () => {
    SOURCES.forEach((s, i) => {
      expect(sourceNumber(s.id)).toBe(i + 1);
      if (s.id !== 'demo') expect(s.links.length).toBeGreaterThan(0);
      for (const l of s.links) expect(l.href).toMatch(/^https:\/\//);
    });
  });
});
