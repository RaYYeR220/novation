/**
 * An AI agent's session through the MCP server, end to end, on a live chain:
 *
 *   1. derives an owner key and an agent key from the deployer key and funds each with a little gas;
 *   2. the owner mints mock USDG, opens a subaccount, deposits, and grants the agent a risk budget of
 *      1.5x the initial margin of one call;
 *   3. starts the MCP server over stdio with the agent key only, and calls its tools the way an
 *      agent would: risk_budget, what_if_margin, buy 1 call (in budget, sent), buy 3 more (refused
 *      in simulation, not sent), the same ticket with send_even_if_refused (the revert is mined),
 *      then explain_refusal on that transaction;
 *   4. prints the transcript and writes every transaction hash to mcp/out/<chainId>.json.
 *
 * Env (from the repo's .env): DEPLOYER_PRIVATE_KEY, RH_TESTNET_RPC. DEMO_RPC_URL, DEMO_DEPLOYER_KEY
 * and DEMO_DEPLOYMENT point it at another chain (a local anvil, say).
 *
 *   pnpm --filter @novation/mcp demo
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  fromWad,
  getDeployment,
  getUnderlyingParams,
  parseDeployment,
  simulateApprove,
  simulateCreateSubaccount,
  simulateDeposit,
  simulateGrantAgent,
  simulateMint,
  toWad,
  WAD,
} from '@novation/sdk';
import { concat, createWalletClient, formatEther, http, keccak256, maxUint256, parseEther, stringToHex, type Hash, type Hex, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createSession, tools } from '../src/index';

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP = join(HERE, '..');
const ROOT = join(MCP, '..');

function dotenv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = { ...dotenv(join(ROOT, '.env')), ...process.env } as Record<string, string | undefined>;
const deployerKey = (env.DEMO_DEPLOYER_KEY ?? env.DEPLOYER_PRIVATE_KEY) as Hex | undefined;
if (!deployerKey) throw new Error('DEPLOYER_PRIVATE_KEY is not set (.env at the repo root)');
const rpcUrl = env.DEMO_RPC_URL ?? env.RH_TESTNET_RPC;
const deployment = env.DEMO_DEPLOYMENT ? parseDeployment(JSON.parse(readFileSync(env.DEMO_DEPLOYMENT, 'utf8'))) : getDeployment(46630);

/** Keys derived from the deployer key, so a rerun reuses the same addresses. */
const derive = (tag: string) => keccak256(concat([deployerKey, stringToHex(tag)]));
const ownerKey = derive('agent-owner');
const agentKey = derive('agent');
const deployer = privateKeyToAccount(deployerKey);
const owner = privateKeyToAccount(ownerKey);
const agentAddr = privateKeyToAccount(agentKey).address;

/** Gas money: top up to `target` when the balance is under `floor`. Testnet gas is ~0.01 gwei. */
const FUND = { owner: { floor: parseEther('0.00004'), target: parseEther('0.0001') }, agent: { floor: parseEther('0.0001'), target: parseEther('0.0002') } };
const DEPOSIT_USDG = 100n;
const PREMIUM_CAP = 25n * WAD;
const POLICY_DAYS = 7;

const s = createSession({ deployment, rpcUrl });
const client = s.n.client;
const chain = s.chain;
const explorer = chain.blockExplorers?.default.url;
const wallet = (k: Hex) => createWalletClient({ account: privateKeyToAccount(k), chain, transport: http(rpcUrl) });

interface TxRecord {
  label: string;
  tx: Hash;
  url?: string;
  status: string;
  gasUsed: number;
  block: number;
}
const txs: TxRecord[] = [];
const transcript: { tool: string; arguments: Record<string, unknown>; summary: string; result: unknown }[] = [];
const say = (m: string) => console.log(m);

async function record(label: string, hash: Hash): Promise<TxRecord> {
  const rc = await client.waitForTransactionReceipt({ hash });
  const r = { label, tx: hash, ...(explorer ? { url: `${explorer}/tx/${hash}` } : {}), status: rc.status, gasUsed: Number(rc.gasUsed), block: Number(rc.blockNumber) };
  txs.push(r);
  say(`  ${rc.status === 'success' ? 'ok ' : 'REV'} ${label}  ${hash}`);
  if (rc.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
  return r;
}

async function sendSim(w: WalletClient, label: string, sim: { request: unknown }) {
  return record(label, await w.writeContract({ ...(sim.request as object), account: w.account!, chain } as Parameters<WalletClient['writeContract']>[0]));
}

async function fund(who: 'owner' | 'agent', to: `0x${string}`) {
  const bal = await client.getBalance({ address: to });
  const f = FUND[who];
  if (bal >= f.floor) {
    say(`  ${who} holds ${formatEther(bal)} ETH: no top-up`);
    return;
  }
  const value = f.target - bal;
  const hash = await wallet(deployerKey!).sendTransaction({ to, value, account: deployer, chain });
  await record(`fund ${who} with ${formatEther(value)} ETH of gas`, hash);
}

async function main() {
  say(`== Novation: an AI agent with an on-chain risk budget, over MCP (chain ${chain.id}) ==`);
  say(`owner ${owner.address}  (keccak256(deployerKey ‖ "agent-owner"))`);
  say(`agent ${agentAddr}  (keccak256(deployerKey ‖ "agent"))`);
  say(`deployer balance ${formatEther(await client.getBalance({ address: deployer.address }))} ETH`);

  say('\n[1] gas for the owner and the agent');
  await fund('owner', owner.address);
  await fund('agent', agentAddr);

  say('\n[2] the owner opens an account and grants the agent a budget');
  const ow = wallet(ownerKey);
  const USDG = deployment.tokens.USDG!;
  const NVDA = deployment.tokens.NVDA!;
  const raw = DEPOSIT_USDG * 10n ** 6n;
  await sendSim(ow, `owner mints ${DEPOSIT_USDG} mock USDG`, await simulateMint(s.n.ctx, owner, USDG, owner.address, raw));
  await sendSim(ow, 'owner approves the clearinghouse', await simulateApprove(s.n.ctx, owner, USDG, deployment.clearinghouse, maxUint256));
  const created = await simulateCreateSubaccount(s.n.ctx, owner);
  const id = created.result;
  await sendSim(ow, `owner creates subaccount ${id}`, created);
  await sendSim(ow, `owner deposits ${DEPOSIT_USDG} USDG`, await simulateDeposit(s.n.ctx, owner, id, USDG, raw));

  // the nearest NVDA call the covered-call vault sells, and the initial margin of one
  const ro = createSession({ deployment, rpcUrl, account: id });
  const chainView = await tools.getChain(ro, { underlying: 'NVDA', type: 'call' });
  const row = chainView.series?.find((x) => x.vaultAsk !== null);
  if (!row) throw new Error('the NVDA covered-call vault offers no call right now');
  const one = (await tools.whatIfMargin(ro, { series_id: row.seriesId, qty: 1 })) as { after?: { initialMargin: number } };
  if (!one.after) throw new Error(`no what-if for ${row.label}: ${JSON.stringify(one)}`);
  const im1 = one.after.initialMargin;
  const budget = toWad((im1 * 1.5).toFixed(6));
  say(`  series ${row.label} (#${row.seriesId}): ask ${row.vaultAsk} USDG, initial margin after 1 call ${im1} USDG`);

  const idx = (await getUnderlyingParams(s.n.ctx, NVDA)).index;
  const expiresAt = Number((await client.getBlock()).timestamp) + POLICY_DAYS * 86_400;
  const policy = { maxWorstLoss: budget, maxPremiumPerTrade: PREMIUM_CAP, allowedMask: 1n << BigInt(idx), expiresAt };
  await sendSim(
    ow,
    `owner grants the agent: budget ${fromWad(budget)} USDG (1.5x one call), premium cap ${fromWad(PREMIUM_CAP)} USDG, NVDA only, ${POLICY_DAYS} days`,
    await simulateGrantAgent(s.n.ctx, owner, id, agentAddr, policy),
  );

  say('\n[3] the agent connects to the MCP server (it holds the agent key, never the owner key)');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(MCP, 'bin', 'novation-mcp.mjs')],
    env: {
      ...(process.env as Record<string, string>),
      NOVATION_AGENT_KEY: agentKey,
      NOVATION_ACCOUNT: id.toString(),
      NOVATION_CHAIN_ID: String(chain.id),
      ...(rpcUrl ? { NOVATION_RPC_URL: rpcUrl } : {}),
      ...(env.DEMO_DEPLOYMENT ? { NOVATION_DEPLOYMENT: env.DEMO_DEPLOYMENT } : {}),
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (b: Buffer) => process.stdout.write(`  [server] ${b.toString()}`));
  const mcp = new Client({ name: 'novation-demo-agent', version: '0.1.0' });
  await mcp.connect(transport);
  say(`  tools: ${(await mcp.listTools()).tools.map((t) => t.name).join(', ')}`);

  const call = async (tool: string, args: Record<string, unknown>) => {
    say(`\n> ${tool} ${JSON.stringify(args)}`);
    const r = await mcp.callTool({ name: tool, arguments: args });
    const out = (r.structuredContent ?? {}) as Record<string, unknown>;
    const summary = String(out.summary ?? (r.content as { text: string }[])[0]?.text ?? '');
    say(`< ${summary}`);
    if (r.isError) throw new Error(`${tool} failed: ${summary}`);
    transcript.push({ tool, arguments: args, summary, result: out });
    return out;
  };

  const series_id = row.seriesId;
  await call('risk_budget', {});
  await call('what_if_margin', { series_id, qty: 1 });
  const filled = await call('buy_from_vault', { series_id, qty: 1 });
  if (filled.status !== 'filled') throw new Error('the in-budget buy did not fill');
  txs.push({ label: 'agent buys 1 call through MCP (in budget)', tx: filled.txHash as Hash, url: filled.explorerUrl as string | undefined, status: 'success', gasUsed: filled.gasUsed as number, block: filled.block as number });
  await call('what_if_margin', { series_id, qty: 3 });
  const refused = await call('buy_from_vault', { series_id, qty: 3 });
  if (refused.status !== 'refused' || refused.sent !== false) throw new Error('the over-budget buy was not refused in simulation');
  const mined = await call('buy_from_vault', { series_id, qty: 3, send_even_if_refused: true });
  if (mined.status !== 'refused' || mined.sent !== true) throw new Error('the over-budget buy was not mined as a revert');
  txs.push({ label: 'agent buys 3 more calls through MCP with send_even_if_refused (over budget, reverts on-chain)', tx: mined.txHash as Hash, url: mined.explorerUrl as string | undefined, status: 'reverted', gasUsed: mined.gasUsed as number, block: mined.block as number });
  const explained = await call('explain_refusal', { tx_hash: mined.txHash });
  await call('portfolio', {});
  await mcp.close();

  const out = {
    chainId: chain.id,
    date: new Date().toISOString(),
    clearinghouse: deployment.clearinghouse,
    actors: { owner: owner.address, agent: agentAddr, derivation: 'keccak256(deployerKey ‖ "agent-owner"), keccak256(deployerKey ‖ "agent")' },
    account: id.toString(),
    series: { id: series_id, label: row.label },
    policy: { budget: fromWad(budget), premiumCap: fromWad(PREMIUM_CAP), allowed: ['NVDA'], expiresAt: new Date(expiresAt * 1000).toISOString() },
    result: {
      inBudgetFill: filled.txHash,
      refusedInSimulation: refused.refusal,
      minedRefusal: mined.txHash,
      explained: explained.refusal,
    },
    txs,
    transcript: transcript.map((t) => ({ tool: t.tool, arguments: t.arguments, summary: t.summary })),
  };
  mkdirSync(join(MCP, 'out'), { recursive: true });
  const file = join(MCP, 'out', `${chain.id}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  say(`\nwrote ${file}`);
  say(`in-budget fill: ${filled.txHash}`);
  say(`mined refusal:  ${mined.txHash}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
