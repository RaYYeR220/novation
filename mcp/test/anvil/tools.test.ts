import { beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  expiriesOf,
  getAgentPolicy,
  getRfqDomain,
  getSpot,
  getUnderlyingParams,
  listSeries,
  randomNonce,
  signQuote,
  simulatePushRound,
  simulateRevokeAgent,
  whatIfTrade,
  WAD,
  type RfqQuote,
} from '@novation/sdk';
import { createServer, StartupRefused, tools, verifyAgent, type Session } from '../../src/index';
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

async function listed(s: Session) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([createServer(s).connect(a), client.connect(b)]);
  const list = (await client.listTools()).tools;
  await client.close();
  return list;
}

d('MCP tool handlers on a local chain', () => {
  const L = l as Local;
  let id: bigint;
  let makerId: bigint;
  let callId: number;
  let budget: bigint;
  let im1: bigint;
  let ro: Session;
  /** The agent as an operator runs it by default: no forced sends. */
  let agent: Session;
  /** The same agent on a server started with NOVATION_ALLOW_FORCED_SEND=1. */
  let forcing: Session;

  beforeAll(async () => {
    id = await openAccount(L, 0, 2_000n);
    makerId = await openAccount(L, 1, 5_000n);
    await fundAgent(L);
    ro = session(L, { account: id });

    // the first NVDA call the covered-call vault offers, from get_chain itself, on an expiry at
    // least two days out (the vault's delta band leaves nothing to offer an hour before a close)
    const t0 = Number((await L.client.getBlock()).timestamp);
    const expiry = expiriesOf(await listSeries(L.ctx, { underlying: L.ctx.deployment.tokens.NVDA!, liveAt: t0 + 2 * 86400 }))[0]!;
    const chain = await tools.getChain(ro, { underlying: 'NVDA', type: 'call', expiry: String(expiry) });
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
    forcing = session(L, { agentKey: AGENT_KEY, account: id, allowForcedSend: true });
    await verifyAgent(agent);
    await verifyAgent(forcing);
  });

  it('starts only for a live agent that owns no account', async () => {
    const v = await verifyAgent(session(L, { agentKey: AGENT_KEY, account: id }));
    expect(v.accountId).toBe(id);
    expect(v.policy.maxWorstLoss).toBe(budget);

    // the account's own owner, and an agent key that owns some other account
    expect(await refusedStart(verifyAgent(session(L, { agentKey: OWNER_KEY, account: id })))).toMatch(/owns subaccount.*owner key/);
    await grant(L, id, privateKeyToAccount(MAKER_KEY).address, { maxWorstLoss: WAD, maxPremiumPerTrade: WAD, allowedMask: 1n, expiresAt: (await blockTime(L)) + 3600 });
    expect(await refusedStart(verifyAgent(session(L, { agentKey: MAKER_KEY, account: id })))).toMatch(new RegExp(`owns subaccount ${makerId}`));

    expect(await refusedStart(verifyAgent(session(L, { agentKey: generatePrivateKey(), account: id })))).toMatch(/no AgentPolicy/);
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

  it('never trades, or serves trading tools, for a key that was not verified', async () => {
    const unverified = session(L, { agentKey: AGENT_KEY, account: id });
    await expect(tools.buyFromVault(unverified, { series_id: callId, qty: 1 })).rejects.toThrow(/verifyAgent/);
    expect(() => createServer(unverified)).toThrow(/verifyAgent/);

    // verified: the trading tools appear, and send_even_if_refused only when the operator allows it
    const plain = await listed(agent);
    const buy = plain.find((t) => t.name === 'buy_from_vault')!;
    const props = buy.inputSchema.properties as Record<string, { default?: unknown; anyOf?: { maximum?: number }[] }>;
    expect(props.send_even_if_refused).toBeUndefined();
    expect(props.qty!.anyOf?.[0]?.maximum).toBe(1_000_000);
    const forced = (await listed(forcing)).find((t) => t.name === 'buy_from_vault')!;
    expect((forced.inputSchema.properties as Record<string, { default?: unknown }>).send_even_if_refused!.default).toBe(false);
    expect(buy.annotations?.readOnlyHint).toBe(false);
  });

  it('reads markets, the chain, quotes and the portfolio, each with a summary', async () => {
    const u = await tools.listUnderlyings(ro);
    expect(u.underlyings.map((x) => x.symbol)).toEqual(['NVDA', 'TSLA', 'AAPL', 'SPY']);
    expect(u.underlyings.every((x) => x.tradeable && x.spot! > 0)).toBe(true);
    expect(u.summary).toMatch(/^4 underlyings: NVDA \d/);

    // the call's own expiry (two days out or more): the nearest may be too close to its close for the vault
    const chain: R = await tools.getChain(ro, { underlying: 'nvda', type: 'call', qty: 1, expiry: String((await ro.n.registry.getSeries(callId)).expiry) });
    expect(chain.summary).toMatch(/^NVDA \d{4}-\d\d-\d\d: 8 series, [1-9] with a vault ask/);
    expect(chain.series.length).toBe(8);
    const row = chain.series.find((x: R) => x.seriesId === callId);
    expect(row.vaultAsk).toBeGreaterThan(0);
    expect(row.delta).toBeGreaterThan(0.05);
    expect(chain.series.some((x: R) => x.notOffered === 'not far enough out of the money')).toBe(true);

    const q: R = await tools.quote(ro, { series_id: callId, qty: 2 });
    expect(q.quotable).toBe(true);
    expect(q.premium).toBeCloseTo(2 * row.vaultAsk, 0);
    expect(q.totalCost).toBeCloseTo(q.premium + q.fee, 5);
    // the vault buys back only what it is short
    const bid: R = await tools.quote(ro, { series_id: callId, qty: 1_000, side: 'sell' });
    expect(bid.quotable).toBe(false);
    expect(bid.refusal?.code).toBe('ExceedsShort');
    await expect(tools.quote(ro, { series_id: callId, qty: 1_000_001 })).rejects.toThrow(/capped at 1000000 contracts/);

    const p = await tools.portfolio(ro, {});
    expect(p.cash).toBe(2_000);
    expect(p.positions).toEqual([]);
    expect(p.scenarioGrid.rows).toHaveLength(3);
    expect(p.summary).toMatch(/^account \d+: equity 2000 USDG/);
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

  it('buys inside the budget with padded gas, refuses over it without sending, and mines the refusal only when allowed', async () => {
    const fill = await tools.buyFromVault(agent, { series_id: callId, qty: 1 });
    expect(fill.status).toBe('filled');
    expect(fill.sent).toBe(true);
    const rc = await L.client.getTransactionReceipt({ hash: fill.txHash as `0x${string}` });
    expect(rc.status).toBe('success');
    // estimate + 25%: the limit sits well above what the fill used
    const tx = await L.client.getTransaction({ hash: fill.txHash as `0x${string}` });
    expect(tx.gas).toBe(BigInt(fill.gasLimit as number));
    expect(Number(tx.gas)).toBeGreaterThanOrEqual(Number(rc.gasUsed) * 1.2);
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

    // the operator didn't allow forced sends on this server
    await expect(tools.buyFromVault(agent, { series_id: callId, qty: 3, send_even_if_refused: true })).rejects.toThrow(/NOVATION_ALLOW_FORCED_SEND/);
    expect(await L.client.getTransactionCount({ address: AGENT })).toBe(nonce);

    const mined = await tools.buyFromVault(forcing, { series_id: callId, qty: 3, send_even_if_refused: true });
    expect(mined.status).toBe('refused');
    expect(mined.sent).toBe(true);
    refusedHash = mined.txHash as `0x${string}`;
    expect((await L.client.getTransactionReceipt({ hash: refusedHash })).status).toBe('reverted');
    expect((mined.refusal as { code: string }).code).toBe('AgentRiskBudgetExceeded');
  });

  it('reports a transaction that ran out of gas as out of gas, not as a refusal', async () => {
    const starved = session(L, { agentKey: AGENT_KEY, account: id, allowForcedSend: true, refusalGas: 300_000n });
    await verifyAgent(starved);
    const r = await tools.buyFromVault(starved, { series_id: callId, qty: 3, send_even_if_refused: true });
    expect(r.sent).toBe(true);
    expect((await L.client.getTransactionReceipt({ hash: r.txHash as `0x${string}` })).status).toBe('reverted');
    expect(r.status).toBe('out_of_gas');
    expect(r.refusal).toBeNull();
    expect(r.summary).toMatch(/^OUT OF GAS: .*No rule refused it/);
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

  it('sends nothing without a price limit when the vault cannot quote', async () => {
    const nonce = await L.client.getTransactionCount({ address: AGENT });
    const r = await tools.sellToVault(agent, { series_id: callId, qty: 1_000 });
    expect(r.status).toBe('no_quote');
    expect(r.sent).toBe(false);
    expect((r.refusal as { code: string }).code).toBe('ExceedsShort');
    expect(r.summary).toMatch(/Pass min_premium/);
    // an explicit limit goes to the simulation, which refuses it the same way
    const explicit = await tools.sellToVault(agent, { series_id: callId, qty: 1_000, min_premium: 0 });
    expect(explicit.status).toBe('refused');
    expect(explicit.sent).toBe(false);
    expect(await L.client.getTransactionCount({ address: AGENT })).toBe(nonce);
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

  it('catches a vol that is more than one sync behind its feed up, then trades', async () => {
    const feed = L.ctx.deployment.feeds.NVDA as `0x${string}`;
    const maker = L.wallets[1]!;
    const t = await blockTime(L);
    const px = (await getSpot(L.ctx, L.ctx.deployment.tokens.NVDA!)).price / 10n ** 10n;
    for (let i = 0; i < 66; i++) await send(L, maker.wallet, (await simulatePushRound(L.ctx, maker.account.address, feed, px, BigInt(t))).request);
    const nonce = await L.client.getTransactionCount({ address: AGENT });
    const fill = await tools.buyFromVault(agent, { series_id: callId, qty: 1 });
    expect(fill.status).toBe('filled');
    expect(String(fill.note)).toMatch(/VolNotCurrent/);
    // the vault wouldn't quote on the stale vol: two catch-up steps (64 rounds, then the rest), then the trade
    expect(await L.client.getTransactionCount({ address: AGENT })).toBe(nonce + 3);
    expect((await tools.sellToVault(agent, { series_id: callId, qty: 1 })).status).toBe('filled');
  });

  it("fills a maker's signed RFQ quote and refuses a tampered one", async () => {
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
