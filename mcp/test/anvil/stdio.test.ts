import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getSpot, getUnderlyingParams, whatIfTrade, WAD } from '@novation/sdk';
import { READ_TOOLS, tools, TRADE_TOOLS } from '../../src/index';
import { AGENT, AGENT_KEY, blockTime, fundAgent, grant, local, openAccount, OWNER_KEY, rpcUrl, session, type Local } from './fixture';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'novation-mcp.mjs');
const l = local();
const d = describe.skipIf(!l);

function spawnServer(env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN],
    env: { ...(process.env as Record<string, string>), ...env },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (b: Buffer) => (stderr += b.toString()));
  const client = new Client({ name: 'novation-mcp-test', version: '0.0.0' });
  return { client, transport, stderr: () => stderr };
}

d('MCP server over stdio (real client, real server process)', () => {
  const L = l as Local;
  let deploymentPath: string;
  let id: bigint;
  let callId: number;
  let budget: bigint;
  const open: Client[] = [];

  beforeAll(async () => {
    deploymentPath = join(mkdtempSync(join(tmpdir(), 'novation-mcp-')), '31337.json');
    writeFileSync(deploymentPath, JSON.stringify(inject('anvil')!.deployment));
    id = await openAccount(L, 0, 1_000n);
    await fundAgent(L);
    const NVDA = L.ctx.deployment.tokens.NVDA!;
    const cc = L.ctx.deployment.vaults.find((v) => v.type === 'coveredCall' && v.underlying === 'NVDA')!.address;
    const ro = session(L, { account: id });
    const spot = (await getSpot(L.ctx, NVDA)).price;
    callId = (await tools.getChain(ro, { underlying: 'NVDA', type: 'call' })).series!.find((x) => x.vaultAsk !== null)!.seriesId;
    const premium = await ro.n.vault.getVaultQuote(cc, callId, WAD, true);
    budget = ((await whatIfTrade(L.ctx, { account: id, seriesId: callId, qty: WAD, premium, spot })).after.im * 3n) / 2n;
    const idx = (await getUnderlyingParams(L.ctx, NVDA)).index;
    await grant(L, id, AGENT, { maxWorstLoss: budget, maxPremiumPerTrade: 100n * WAD, allowedMask: 1n << BigInt(idx), expiresAt: (await blockTime(L)) + 86_400 });
  });

  afterAll(async () => {
    await Promise.all(open.map((c) => c.close().catch(() => undefined)));
  });

  const base = () => ({ NOVATION_DEPLOYMENT: deploymentPath, NOVATION_RPC_URL: rpcUrl() });

  it('serves the agent: lists every tool, reports the budget, returns a structured refusal', async () => {
    const { client, transport } = spawnServer({ ...base(), NOVATION_AGENT_KEY: AGENT_KEY, NOVATION_ACCOUNT: id.toString() });
    await client.connect(transport);
    open.push(client);

    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...READ_TOOLS, ...TRADE_TOOLS].sort());

    const b = await client.callTool({ name: 'risk_budget', arguments: {} });
    expect(b.isError).toBeFalsy();
    const bs = b.structuredContent as { account: string; policy: { budget: number; allowedUnderlyings: string[] }; used: number };
    expect(bs.account).toBe(id.toString());
    expect(bs.policy.budget).toBeCloseTo(Number(budget) / 1e18, 5);
    expect(bs.policy.allowedUnderlyings).toEqual(['NVDA']);

    const r = await client.callTool({ name: 'buy_from_vault', arguments: { series_id: callId, qty: 5 } });
    expect(r.isError).toBeFalsy();
    const rs = r.structuredContent as { status: string; sent: boolean; refusal: { code: string; numbers: Record<string, number>; message: string } };
    expect(rs.status).toBe('refused');
    expect(rs.sent).toBe(false);
    expect(rs.refusal.code).toBe('AgentRiskBudgetExceeded');
    expect(rs.refusal.numbers.worstLoss).toBeGreaterThan(rs.refusal.numbers.budget!);
    expect((r.content as { text: string }[])[0]!.text).toMatch(/^REFUSED \(not sent\): AgentRiskBudgetExceeded/);

    const bad = await client.callTool({ name: 'quote', arguments: { series_id: 999_999 } });
    expect(bad.isError).toBe(true);
  });

  it('runs read-only without a key: no trading tools', async () => {
    const { client, transport } = spawnServer(base());
    await client.connect(transport);
    open.push(client);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...READ_TOOLS].sort());
    const p = await client.callTool({ name: 'portfolio', arguments: { account: id.toString() } });
    expect((p.structuredContent as { cash: number }).cash).toBe(1_000);
  });

  it('refuses to start with the owner key', async () => {
    const { client, transport, stderr } = spawnServer({ ...base(), NOVATION_AGENT_KEY: OWNER_KEY, NOVATION_ACCOUNT: id.toString() });
    await expect(client.connect(transport)).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 200));
    expect(stderr()).toMatch(/refusing to start: NOVATION_AGENT_KEY is the owner key/);
    await transport.close().catch(() => undefined);
  });
});
