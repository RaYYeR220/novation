import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { decodeRevertData, getDeployment, novationErrorsAbi, WAD } from '@novation/sdk';
import { encodeErrorResult } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { ConfigError, createServer, createSession, DEFAULT_REFUSAL_GAS, loadConfig, READ_TOOLS, refusalLine, refusalView, TRADE_TOOLS, tools } from '../../src/index';
import { amountOf, num, qtyOf, scenarioOf, seriesLabel, ToolInputError, wadOf } from '../../src/format';

const KEY = '0x' + '11'.repeat(32);

describe('config', () => {
  it('defaults to read-only on Robinhood Chain testnet', () => {
    const c = loadConfig({});
    expect(c.chainId).toBe(46630);
    expect(c.agentKey).toBeUndefined();
    expect(c.account).toBeUndefined();
    expect(c.refusalGas).toBe(DEFAULT_REFUSAL_GAS);
    expect(c.allowForcedSend).toBe(false);
    expect(c.deployment.clearinghouse).toBe(getDeployment(46630).clearinghouse);
  });

  it('reads the agent key, account and refusal gas', () => {
    const c = loadConfig({ NOVATION_AGENT_KEY: KEY.slice(2), NOVATION_ACCOUNT: '42', NOVATION_REFUSAL_GAS: '3000000', NOVATION_RPC_URL: 'http://localhost:1' });
    expect(c.agentKey).toBe(KEY);
    expect(c.account).toBe(42n);
    expect(c.refusalGas).toBe(3_000_000n);
    expect(c.rpcUrl).toBe('http://localhost:1');
    expect(loadConfig({ NOVATION_ALLOW_FORCED_SEND: '1' }).allowForcedSend).toBe(true);
    expect(loadConfig({ NOVATION_ALLOW_FORCED_SEND: '0' }).allowForcedSend).toBe(false);
  });

  it('rejects malformed settings', () => {
    expect(() => loadConfig({ NOVATION_AGENT_KEY: '0x1234' })).toThrow(ConfigError);
    expect(() => loadConfig({ NOVATION_ACCOUNT: 'seven' })).toThrow(/subaccount id/);
    expect(() => loadConfig({ NOVATION_CHAIN_ID: '1' })).toThrow(/no Novation deployment/);
    expect(() => loadConfig({ NOVATION_DEPLOYMENT: '/nonexistent/31337.json' })).toThrow(/cannot read/);
    expect(() => loadConfig({ NOVATION_ALLOW_FORCED_SEND: 'yes' })).toThrow(/1 or 0/);
  });
});

describe('formatting', () => {
  it('converts amounts both ways', () => {
    expect(num(1234567890123456789n)).toBe(1.234568);
    expect(wadOf(1.5, 'qty')).toBe(15n * 10n ** 17n);
    expect(wadOf('-3', 'qty')).toBe(-3n * WAD);
    expect(() => wadOf('1e3', 'qty')).toThrow(ToolInputError);
    expect(() => wadOf('abc', 'qty')).toThrow(/decimal/);
    expect(() => wadOf('1.1234567890123456789', 'qty')).toThrow(/18 decimals/);
  });

  it('caps quantities and amounts', () => {
    expect(qtyOf('1000000', 'qty')).toBe(1_000_000n * WAD);
    expect(() => qtyOf('1000000.000000000000000001', 'qty')).toThrow(/capped at 1000000 contracts/);
    expect(() => qtyOf(0, 'qty')).toThrow(/non-zero/);
    expect(() => qtyOf(-1, 'qty')).toThrow(/positive/);
    expect(qtyOf(-2, 'qty', true)).toBe(-2n * WAD);
    expect(() => qtyOf(-2_000_000, 'qty', true)).toThrow(/capped/);
    expect(amountOf(0, 'premium')).toBe(0n);
    expect(() => amountOf(-1, 'premium')).toThrow(/negative/);
    expect(() => amountOf('1000000001', 'premium')).toThrow(/capped at 1000000000 USDG/);
  });

  it('labels series and decodes the scenario layout', () => {
    const d = getDeployment(46630);
    const s = { id: 5, underlying: d.tokens.NVDA!, expiry: 1790971200, isCall: true, strike: 255n * WAD };
    expect(seriesLabel(d, s)).toBe('NVDA 2026-10-02 255 C');
    expect(scenarioOf(0)).toEqual({ priceMoveOfRange: -1, vol: 'vol down' });
    expect(scenarioOf(19)).toEqual({ priceMoveOfRange: 0, vol: 'base vol' });
    expect(scenarioOf(38)).toEqual({ priceMoveOfRange: 1, vol: 'vol up' });
  });

  it('turns a budget revert into a Refusal with its numbers', () => {
    const data = encodeErrorResult({ abi: novationErrorsAbi, errorName: 'AgentRiskBudgetExceeded', args: [7n, 12_345n * 10n ** 15n, 9n * WAD] });
    const r = refusalView(decodeRevertData(data)!);
    expect(r).toEqual({ code: 'AgentRiskBudgetExceeded', message: "Worst-case loss after this trade exceeds the agent's risk budget.", numbers: { id: 7, worstLoss: 12.345, budget: 9 } });
    expect(refusalLine(r)).toBe("AgentRiskBudgetExceeded: worst-case loss after the trade 12.345 USDG > the agent's budget 9 USDG");
  });

  it('parses a signed quote from JSON', () => {
    const q = tools.parseQuote({
      signer: '0x4108064852c95135844be338fc8bcbdf91c41acf',
      makerId: '3',
      seriesId: 12,
      makerSells: true,
      maxQty: '2000000000000000000',
      price: '1500000000000000000',
      deadline: 1790971200,
      nonce: '99',
    });
    expect(q).toEqual({
      signer: '0x4108064852c95135844be338fc8bcBdF91C41ACF',
      makerId: 3n,
      seriesId: 12,
      makerSells: true,
      maxQty: 2n * WAD,
      price: 15n * 10n ** 17n,
      deadline: 1790971200n,
      nonce: 99n,
    });
    expect(() => tools.parseQuote({ ...({} as tools.QuoteJson), signer: 'nobody' })).toThrow(/signer/);
    const ok = { signer: '0x4108064852c95135844be338fc8bcbdf91c41acf', makerId: 1, seriesId: 1, makerSells: true, maxQty: 1, price: 1, deadline: 1, nonce: 1 };
    expect(() => tools.parseQuote({ ...ok, seriesId: String(2 ** 32) })).toThrow(/uint32/);
    expect(() => tools.parseQuote({ ...ok, deadline: (2n ** 64n).toString() })).toThrow(/uint64/);
    expect(() => tools.parseQuote({ ...ok, nonce: '1'.repeat(79) })).toThrow(/integer/);
  });
});

describe('server', () => {
  const session = (agentKey?: `0x${string}`) =>
    // no network: listing tools and validating arguments never touch the RPC
    createSession({ deployment: getDeployment(46630), rpcUrl: 'http://127.0.0.1:9', agentKey, account: agentKey ? 1n : undefined });

  async function connect() {
    const server = createServer(session());
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'unit', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  }

  it('offers only read tools without an agent key, every one with a description', async () => {
    const c = await connect();
    const list = (await c.listTools()).tools;
    expect(list.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort());
    expect(list.every((t) => (t.description ?? '').length > 40 && t.annotations?.readOnlyHint === true)).toBe(true);
    const r = await c.callTool({ name: 'risk_budget', arguments: {} });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0]!.text).toMatch(/pass an account id/);
  });

  it('refuses to serve an agent key that was never verified on-chain', () => {
    expect(() => createServer(session(generatePrivateKey()))).toThrow(/verifyAgent/);
  });

  it('rejects out-of-range arguments in the schema, before any handler runs', async () => {
    const c = await connect();
    for (const args of [{ series_id: 5, qty: 2_000_000 }, { series_id: 5, qty: '1.1234567890123456789' }, { series_id: -1 }, { series_id: 2 ** 32 }]) {
      const r = await c.callTool({ name: 'quote', arguments: args });
      expect(r.isError).toBe(true);
    }
    const w = await c.callTool({ name: 'what_if_margin', arguments: { series_id: 5, qty: 1, premium: 2_000_000_000 } });
    expect(w.isError).toBe(true);
  });

  it('never names owner-only operations', () => {
    expect([...READ_TOOLS, ...TRADE_TOOLS].join(' ')).not.toMatch(/withdraw|deposit|grant|revoke/);
  });
});
