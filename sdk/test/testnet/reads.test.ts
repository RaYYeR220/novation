/**
 * Read-only checks against the live Robinhood Chain testnet deployment. Skipped with
 * RH_TESTNET_RPC=off; RH_TESTNET_RPC=<url> points them at another endpoint.
 */
import { describe, expect, it } from 'vitest';
import { createNovation, fromWad, proofRefusals, SCENARIOS } from '../../src/index';

const env = process.env.RH_TESTNET_RPC;
const off = env === 'off';
const n = off ? undefined : createNovation({ chainId: 46630, rpcUrl: env && env.startsWith('http') ? env : undefined });

describe.skipIf(off)('Robinhood Chain testnet (read-only)', () => {
  const N = n!;

  it('reads the four markets from the hub', async () => {
    const markets = await N.hub.getMarkets();
    expect(markets.map((m) => m.symbol)).toEqual(['NVDA', 'TSLA', 'AAPL', 'SPY']);
    for (const m of markets) {
      expect(m.feed.updatedAt).toBeGreaterThan(0);
      if (m.session === 'HALTED') expect(m.haltReason).toBeDefined();
      else expect(m.spot).not.toBeNull();
    }
  });

  it('lists series and vaults', async () => {
    const series = await N.registry.listSeries();
    expect(series.length).toBeGreaterThan(0);
    expect(series[0]!.id).toBe(1);
    const vaults = await N.vault.getVaults();
    expect(vaults).toHaveLength(N.deployment.vaults.length);
    for (const v of vaults) expect(v.totalSupply).toBeGreaterThan(0n);
  });

  it('reads accounts the end-to-end scenario opened, and their scenario grid', async () => {
    const trades = await N.events.getTrades();
    expect(trades.length).toBeGreaterThan(0);
    const id = trades.at(-1)!.args.takerId!;
    const [st, grid] = await Promise.all([N.clearinghouse.getAccountState(id), N.clearinghouse.getScenarioGrid(id)]);
    expect(grid).toHaveLength(SCENARIOS);
    expect(fromWad(st.equity)).toBeGreaterThan(0);
  });

  it('replays the recorded refusals and decodes the same errors', async () => {
    const proofs = proofRefusals(46630);
    expect(proofs.length).toBeGreaterThan(0);
    for (const p of proofs) {
      const why = await N.explainTx(p.tx);
      expect(why?.refusal.code, p.label).toBe(p.expectedError);
    }
  });
});
