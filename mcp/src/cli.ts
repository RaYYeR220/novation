import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fromWad } from '@novation/sdk';
import { ConfigError, loadConfig } from './config';
import { createServer } from './server';
import { sessionFromConfig, StartupRefused, verifyAgent } from './session';

// stdout carries the MCP protocol: everything human goes to stderr
const log = (m: string) => process.stderr.write(`novation-mcp: ${m}\n`);

async function main() {
  const cfg = loadConfig();
  const s = sessionFromConfig(cfg);
  if (s.agent) {
    const v = await verifyAgent(s);
    const p = v.policy;
    log(
      `agent ${v.agent} trades subaccount ${v.accountId} (owner ${v.owner}) on chain ${cfg.chainId}: ` +
        `budget ${fromWad(p.maxWorstLoss)} USDG, premium cap ${fromWad(p.maxPremiumPerTrade)} USDG, policy expires ${new Date(p.expiresAt * 1000).toISOString()}`,
    );
  } else {
    log(`read-only mode on chain ${cfg.chainId} (no NOVATION_AGENT_KEY): trading tools are off`);
  }
  const server = createServer(s);
  await server.connect(new StdioServerTransport());
}

main().catch((e: unknown) => {
  if (e instanceof StartupRefused || e instanceof ConfigError) log(`refusing to start: ${e.message}`);
  else log(`failed to start: ${(e as { shortMessage?: string }).shortMessage ?? (e as Error).message ?? String(e)}`);
  process.exit(1);
});
