import { describe, expect, it } from 'vitest';
import { MockClient, FIXTURE_AS_OF } from '@/lib/client/mock';
import { parseAmount } from '@/components/earn/vault-dialogs';
import { discountAt } from '@/components/charts/discount-ramp';
import { isWeeklyExpiry } from '@/lib/nyse';

const c = new MockClient();

describe('demo books', () => {
  it('carries the initial margin of every session grid', async () => {
    expect((await c.scenarioGrid(7, 'REGULAR')).im).toBeCloseTo(596.506189, 6);
    expect((await c.scenarioGrid(7, 'WEEKEND')).im).toBeCloseTo(1373.287093, 6);
    const mm = await c.scenarioGrid(1, 'WEEKEND');
    expect(mm.session).toBe('WEEKEND');
    expect(mm.im).toBeGreaterThan((await c.scenarioGrid(1, 'REGULAR')).im);
  });

  it('account 12 sits below maintenance, with IM = worst cell + short minimum', async () => {
    const a = await c.account(12);
    expect(a.state.liquidatable).toBe(true);
    expect(a.state.equity).toBeLessThan(a.state.mm);
    expect(a.state.equity).toBeCloseTo(a.state.cash + a.state.mtm, 6);
    const g = await c.scenarioGrid(12, 'REGULAR');
    expect(g.im).toBeCloseTo(a.state.im, 6);
    expect(Math.min(...g.cells)).toBeLessThan(0);
  });
});

describe('settlement', () => {
  it('lists the open expiry first, then settled ones on weekly closes', async () => {
    const xs = await c.expiries(7);
    expect(xs[0]!.status).toBe('open');
    expect(xs[0]!.net).toBeCloseTo(-1022.8, 6);
    for (const x of xs) expect(isWeeklyExpiry(x.expiry)).toBe(true);
    const claimed = xs.filter((x) => x.status === 'claimed');
    expect(claimed).toHaveLength(2);
    for (const x of claimed) {
      expect(x.readyAt!).toBeGreaterThanOrEqual(x.settledAt!);
      expect(x.claimedAt!).toBeGreaterThan(x.readyAt!);
      expect(x.net).toBeCloseTo(x.legs.reduce((a, l) => a + l.payoff, 0), 6);
    }
  });

  it('pools never pay out more than came in, and settle on prints at or before the close', async () => {
    for (const p of await c.pools()) {
      if (p.status === 'open') continue;
      expect(p.paidIn).toBeGreaterThanOrEqual(p.claims);
      expect(p.unsettledShortQty).toBe(0);
      expect(p.pending).toBe(0);
      for (const s of p.prices) {
        expect(s.updatedAt!).toBeLessThanOrEqual(p.expiry);
        expect(p.expiry - s.updatedAt!).toBeLessThanOrEqual(87300);
      }
    }
  });

  it("the short book's deficit was bridged, rounded up, and repaid by its collateral sale", async () => {
    const d = (await c.expiries(12)).find((x) => x.status === 'deficit-cleared')!;
    expect(d.bridged).toBe(Math.ceil(-d.net - d.paidCash!));
    expect(d.deficitSale!.tokensSold * d.deficitSale!.price).toBeCloseTo(d.bridged!, 4);
    expect(d.deficitSale!.discount).toBeCloseTo(discountAt(d.deficitSale!.bidAt - d.deficitSale!.startedAt, { startDiscount: 0.02, maxDiscount: 0.12, duration: 1800 }), 6);
    expect((await c.insurance()).outstanding).toBe(0);
  });
});

describe('vaults', () => {
  it('splits backing into locked, queued and free', async () => {
    for (const v of await c.vaults()) {
      const d = await c.vault(v.address);
      expect(d.locked + d.queued + d.free).toBeCloseTo(d.backing, 4);
      expect(d.queued).toBeCloseTo(d.escrowedShares * d.navPerShare, 4);
      expect(d.openSeries.length).toBeLessThanOrEqual(d.config.maxOpenSeries);
      expect(d.navHistory.at(-1)!.nav).toBeCloseTo(d.navPerShare, 9);
    }
  });

  it('splits a covered-call exit in kind and pays a put-write exit in USDG', async () => {
    const vs = await c.vaults();
    const cc = vs.find((v) => v.kind === 'coveredCall')!;
    const pw = vs.find((v) => v.kind === 'putWrite')!;
    const d = await c.vault(cc.address);
    const spot = (await c.underlyings()).find((u) => u.symbol === d.underlying)!.spot;
    const p = await c.previewExit(cc.address, 10);
    expect(p.shares).toBeCloseTo(10 / d.navPerShare, 9);
    // the USDG part is the vault's cash per unit of NAV; with the tokens it is worth the exit, no more
    expect(p.cash).toBeGreaterThan(0);
    expect(p.cash).toBeCloseTo((d.cash * 10) / (d.shares * d.navPerShare), 5);
    expect(p.tokens + p.cash / spot).toBeLessThanOrEqual(10 + 1e-9);
    expect(p.tokens + p.cash / spot).toBeCloseTo(10, 6);
    const put = await c.previewExit(pw.address, 500);
    expect(put.tokens).toBe(500);
    expect(put.cash).toBe(0);
  });

  it('validates amounts the way the dialogs show them', () => {
    expect(parseAmount('', 10, 'NVDA', 'your wallet holds').error).toBe('Enter an amount.');
    expect(parseAmount('1e3', 10, 'NVDA', 'your wallet holds').error).toBe('Numbers only.');
    expect(parseAmount('0', 10, 'NVDA', 'your wallet holds').error).toBe('The amount must be above zero.');
    expect(parseAmount('12.5', 10, 'NVDA', 'your wallet holds').error).toBe('That is more than your wallet holds: 10 NVDA.');
    expect(parseAmount('1,000', 2000, 'USDG', 'x')).toEqual({ value: 1000 });
  });
});

describe('agent grants', () => {
  it('refuses the owner, the zero address and a past expiry, like Clearinghouse.grantAgent', async () => {
    const m = new MockClient();
    const owner = (await m.account(7)).owner;
    const g = { label: 'x', maxWorstLoss: 1000, maxPremiumPerTrade: 100, allowed: ['NVDA'], expiresAt: FIXTURE_AS_OF + 3600 };
    await expect(m.grantAgent(7, { ...g, agent: owner })).rejects.toThrow('InvalidAgent');
    await expect(m.grantAgent(7, { ...g, agent: '0x' + '0'.repeat(40) })).rejects.toThrow('InvalidAgent');
    await expect(m.grantAgent(7, { ...g, agent: '0x' + 'c4'.repeat(20), expiresAt: FIXTURE_AS_OF })).rejects.toThrow('InvalidExpiry');
  });

  it('grants with the account lossIM as used, and revokes at once', async () => {
    const m = new MockClient();
    const agent = '0x' + 'c4'.repeat(20);
    await m.grantAgent(7, { agent, label: 'roll-keeper', maxWorstLoss: 1200, maxPremiumPerTrade: 100, allowed: ['NVDA'], expiresAt: FIXTURE_AS_OF + 86400 });
    const g = (await m.agents(7)).find((x) => x.agent === agent)!;
    expect(g.used).toBeCloseTo((await m.account(7)).state.im, 6);
    await m.revokeAgent(7, '0x' + 'b0'.repeat(20));
    expect((await m.agents(7)).map((x) => x.label)).toEqual(['mcp-desk', 'rebalancer', 'roll-keeper']);
    expect((await new MockClient().agents(7))[0]!.label).toBe('hedge-bot');
  });
});
