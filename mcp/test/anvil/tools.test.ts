import { beforeAll, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  getAgentPolicy,
  getRfqDomain,
  getSpot,
  getUnderlyingParams,
  randomNonce,
  signQuote,
  simulateRevokeAgent,
  whatIfTrade,
  WAD,
  type RfqQuote,
} from '@novation/sdk';
import { StartupRefused, tools, verifyAgent, type Session } from '../../src/index';
import { AGENT, AGENT_KEY, blockTime, fundAgent, grant, local, MAKER_KEY, openAccount, OWNER_KEY, send, session, type Local } from './fixture';

type R = Record<string, any>;

const l = local();
const d = describe.skipIf(!l);

async function refusedStart(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof StartupRefused) return e.message;
    throw e;
  }
  throw new Error('expected the server to refuse to start');
}

d('MCP tool handlers on a local chain', () => {
  const L = l as Local;
  let id: bigint;
  let callId: number;
  let budget: bigint;
  let im1: bigint;
  let ro: Session;
  let agent: Session;

  beforeAll(async () => {
    id = await openAccount(L, 0, 2_000n);
    await fundAgent(L);
    ro = session(L, { account: id });

    // the first NVDA call the covered-call vault offers, from get_chain itself
    const chain = await tools.getChain(ro, { underlying: 'NVDA', type: 'call' });
    const offered = chain.series?.find((x) => x.vaultAsk !== null);
    expect(offered).toBeDefined();
    callId = offered!.seriesId;

    // budget: 1.5x the initial margin of one call, as the demo grants it
    const NVDA = L.ctx.deployment.tokens.NVDA!;
    const cc = L.ctx.deployment.vaults.find((v) => v.type === 'coveredCall' && v.underlying === 'NVDA')!.address;
    const premium = await ro.n.vault.getVaultQuote(cc, callId, WAD, true);
    const what = await whatIfTrade(L.ctx, { account: id, seriesId: callId, qty: WAD, premium, spot: (await getSpot(L.ctx, NVDA)).price });
    im1 = what.after.im;
    budget = (im1 * 3n) / 2n;
    const idx = (await getUnderlyingParams(L.ctx, NVDA)).index;
    await grant(L, id, AGENT, { maxWorstLoss: budget, maxPremiumPerTrade: 100n * WAD, allowedMask: 1n << BigInt(idx), expiresAt: (await blockTime(L)) + 86_400 });
    agent = session(L, { agentKey: AGENT_KEY, account: id });
  });

  it('starts only for a live agent of the account, never with the owner key', async () => {
    const v = await verifyAgent(agent);
    expect(v.accountId).toBe(id);
    expect(v.policy.maxWorstLoss).toBe(budget);

    expect(await refusedStart(verifyAgent(session(L, { agentKey: OWNER_KEY, account: id })))).toMatch(/owner key/);
    expect(await refusedStart(verifyAgent(session(L, { agentKey: MAKER_KEY, account: id })))).toMatch(/no AgentPolicy/);
    expect(await refusedStart(verifyAgent(session(L, { agentKey: AGENT_KEY, account: 999_999n })))).toMatch(/does not exist/);

    // revoked: the policy is gone, so the server won't start
    const k = generatePrivateKey();
    const a = privateKeyToAccount(k).address;
    await grant(L, id, a, { maxWorstLoss: WAD, maxPremiumPerTrade: WAD, allowedMask: 1n, expiresAt: (await blockTime(L)) + 3600 });
    await verifyAgent(session(L, { agentKey: k, account: id }));
    const w = L.wallets[0]!;
    await send(L, w.wallet, (await simulateRevokeAgent(L.ctx, w.account.address, id, a)).request);
    expect(await refusedStart(verifyAgent(session(L, { agentKey: k, account: id })))).toMatch(/no AgentPolicy/);
  });

  it('finds the account from the AgentGranted log when none is configured', async () => {
    const k = generatePrivateKey();
    await grant(L, id, privateKeyToAccount(k).address, { maxWorstLoss: WAD, maxPremiumPerTrade: WAD, allowedMask: 1n, expiresAt: (await blockTime(L)) + 3600 });
    const s = session(L, { agentKey: k });
    expect((await verifyAgent(s)).accountId).toBe(id);
    expect(s.accountId).toBe(id);
    expect(await refusedStart(verifyAgent(session(L, { agentKey: generatePrivateKey() })))).toMatch(/no live AgentPolicy/);
  });

  it('reads markets, the chain, quotes and the portfolio', async () => {
    const u = await tools.listUnderlyings(ro);
    expect(u.underlyings.map((x) => x.symbol)).toEqual(['NVDA', 'TSLA', 'AAPL', 'SPY']);
    expect(u.underlyings.every((x) => x.tradeable && x.spot! > 0)).toBe(true);

    const chain = await tools.getChain(ro, { underlying: 'nvda', type: 'call', qty: 1 });
    expect(chain.series!.length).toBe(8);
    const row = chain.series!.find((x) => x.seriesId === callId)!;
    expect(row.vaultAsk).toBeGreaterThan(0);
    expect(row.delta).toBeGreaterThan(0.05);
    expect(chain.series!.some((x) => x.notOffered === 'not far enough out of the money')).toBe(true);

    const q: R = await tools.quote(ro, { series_id: callId, qty: 2 });
    expect(q.quotable).toBe(true);
    expect(q.premium).toBeCloseTo(2 * row.vaultAsk!, 0);
    expect(q.totalCost).toBeCloseTo(q.premium + q.fee, 5);
    // the vault buys back only what it is short
    const bid: R = await tools.quote(ro, { series_id: callId, qty: 1_000, side: 'sell' });
    expect(bid.quotable).toBe(false);
    expect(bid.refusal?.code).toBe('ExceedsShort');

    const p = await tools.portfolio(ro, {});
    expect(p.cash).toBe(2_000);
    expect(p.positions).toEqual([]);
    expect(p.scenarioGrid.rows).toHaveLength(3);
  });

  it('reports the risk budget and predicts the agent rules before trading', async () => {
    const b = await tools.riskBudget(agent, {});
    expect(b.policy.live).toBe(true);
    expect(b.policy.allowedUnderlyings).toEqual(['NVDA']);
    expect(b.used).toBe(0);
    expect(b.headroom).toBeCloseTo(Number(budget) / 1e18, 5);

    const one: R = await tools.whatIfMargin(agent, { series_id: callId, qty: 1 });
    expect(one.predictedRefusal).toBeNull();
    expect(one.after.initialMargin).toBeCloseTo(Number(im1) / 1e18, 3);

    const four: R = await tools.whatIfMargin(agent, { series_id: callId, qty: '4' });
    expect(four.predictedRefusal).toBe('AgentRiskBudgetExceeded');
    expect(four.summary).toMatch(/^WOULD BE REFUSED/);
  });

  let refusedHash: `0x${string}`;

  it('buys inside the budget, refuses over it without sending, and mines the refusal on request', async () => {
    const fill = await tools.buyFromVault(agent, { series_id: callId, qty: 1 });
    expect(fill.status).toBe('filled');
    expect(fill.sent).toBe(true);
    expect((await L.client.getTransactionReceipt({ hash: fill.txHash as `0x${string}` })).status).toBe('success');
    expect((fill.budget as { used: number }).used).toBeLessThanOrEqual(Number(budget) / 1e18);

    const nonce = await L.client.getTransactionCount({ address: AGENT });
    const refused = await tools.buyFromVault(agent, { series_id: callId, qty: 3 });
    expect(refused.status).toBe('refused');
    expect(refused.sent).toBe(false);
    const r = refused.refusal as { code: string; numbers: Record<string, number> };
    expect(r.code).toBe('AgentRiskBudgetExceeded');
    expect(r.numbers.budget).toBeCloseTo(Number(budget) / 1e18, 6);
    expect(r.numbers.worstLoss).toBeGreaterThan(r.numbers.budget!);
    expect(await L.client.getTransactionCount({ address: AGENT })).toBe(nonce);

    const mined = await tools.buyFromVault(agent, { series_id: callId, qty: 3, send_even_if_refused: true });
    expect(mined.status).toBe('refused');
    expect(mined.sent).toBe(true);
    refusedHash = mined.txHash as `0x${string}`;
    expect((await L.client.getTransactionReceipt({ hash: refusedHash })).status).toBe('reverted');
    expect((mined.refusal as { code: string }).code).toBe('AgentRiskBudgetExceeded');
  });

  it('explains a mined refusal from its hash', async () => {
    const x = await tools.explainRefusal(agent, { tx_hash: refusedHash });
    expect(x.status).toBe('reverted');
    expect(x.refusal?.code).toBe('AgentRiskBudgetExceeded');
    expect(x.call?.function).toBe('buy');
    expect(x.summary).toMatch(/refused on-chain: AgentRiskBudgetExceeded/);
    // read-only mode explains it too: it needs no key
    expect((await tools.explainRefusal(ro, { tx_hash: refusedHash })).refusal?.numbers.budget).toBeCloseTo(Number(budget) / 1e18, 6);
  });

  it('sells back to the vault: cutting risk always passes the budget', async () => {
    const sold = await tools.sellToVault(agent, { series_id: callId, qty: 1 });
    expect(sold.status).toBe('filled');
    const b = await tools.riskBudget(agent, {});
    expect(b.used).toBe(0);
    expect((await tools.portfolio(agent, {})).positions).toEqual([]);
    const ok = await tools.explainRefusal(agent, { tx_hash: sold.txHash as string });
    expect(ok.status).toBe('success');
  });

  it("fills a maker's signed RFQ quote and refuses a tampered one", async () => {
    const makerId = await openAccount(L, 1, 5_000n);
    const maker = L.wallets[1]!.account;
    const cc = L.ctx.deployment.vaults.find((v) => v.type === 'coveredCall' && v.underlying === 'NVDA')!.address;
    const ask = await agent.n.vault.getVaultQuote(cc, callId, WAD, true);
    const q: RfqQuote = {
      signer: maker.address,
      makerId,
      seriesId: callId,
      makerSells: true,
      maxQty: 2n * WAD,
      price: ask,
      deadline: BigInt((await blockTime(L)) + 3600),
      nonce: randomNonce(),
    };
    const signature = await signQuote(maker, q, getRfqDomain(L.ctx));
    const json = Object.fromEntries(Object.entries(q).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])) as unknown as tools.QuoteJson;

    const fill = await tools.fillRfq(agent, { quote: json, signature, qty: 1 });
    expect(fill.status).toBe('filled');
    expect(fill.premium).toBeCloseTo(Number(ask) / 1e18, 5);

    const tampered = await tools.fillRfq(agent, { quote: { ...json, price: (q.price + 1n).toString() }, signature, qty: 1 });
    expect(tampered.status).toBe('refused');
    expect((tampered.refusal as { code: string }).code).toBe('BadSignature');

    // 1 left on the quote, but a second contract would take the account past its budget
    const over = await tools.fillRfq(agent, { quote: json, signature });
    expect(over.status).toBe('refused');
    expect((over.refusal as { code: string }).code).toBe('AgentRiskBudgetExceeded');
    expect((await getAgentPolicy(L.ctx, id, AGENT)).maxWorstLoss).toBe(budget);
  });
});
