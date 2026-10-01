/**
 * Rehearses the next weekly settlement against a fork of the live chain, with the deployed
 * contracts and the real open positions:
 *   1. forks the chain with anvil (local only: nothing is sent to the real network);
 *   2. re-prints every mock feed at its current answer a few minutes before the close (what the
 *      feed mirror does on the day), then moves the fork's clock past the close;
 *   3. runs the keeper's settlement jobs for real on the fork: settleExpiry with the hint it finds,
 *      settleAccount payers first, claim, roll.
 * The Stylus kernel can't execute on anvil, so jobs that price a book (vol sync, liquidation scan)
 * are left out; settlement itself never calls the kernel.
 *
 *   tsx scripts/fork-rehearsal.ts [--expiry <unix>] [--after 900] [--pre 300]
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createPublicClient, defineChain, http, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chainById, fmtCloseEt, getDeployment, getPool, mockAggregatorAbi, nextWeeklyExpiry, type Address } from '@novation/sdk';
import { createKeeper, createLogger, deriveKeeperKey, loadDotEnv, tick } from '../src/index';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (typeof a === 'object' && a ? resolve(a.port) : reject(new Error('no port'))));
    });
  });
}

async function main() {
  loadDotEnv();
  const log = createLogger();
  const chainId = 46630;
  const upstream = process.env.RH_TESTNET_RPC ?? chainById(chainId)!.rpcUrls.default.http[0]!;
  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined;
  const key = (process.env.KEEPER_PRIVATE_KEY as Hex | undefined) ?? (deployerKey ? deriveKeeperKey(deployerKey) : undefined);
  if (!key) throw new Error('set DEPLOYER_PRIVATE_KEY (or KEEPER_PRIVATE_KEY) in .env');

  const port = await freePort();
  const anvil = spawn('anvil', ['--fork-url', upstream, '--port', String(port), '--silent', '--no-rate-limit'], { stdio: 'ignore' });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const rpc = async (method: string, params: unknown[] = []) => {
    const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = (await r.json()) as { result?: unknown; error?: { message: string } };
    if (j.error) throw new Error(j.error.message);
    return j.result;
  };
  try {
    for (let i = 0; ; i++) {
      try {
        await rpc('eth_chainId');
        break;
      } catch (e) {
        if (i > 300) throw e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const chain = defineChain({ ...chainById(chainId)!, rpcUrls: { default: { http: [rpcUrl] } }, blockExplorers: undefined });
    const client = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 50 }) as PublicClient;
    const deployment = getDeployment(chainId);
    const forkNow = Number((await client.getBlock()).timestamp);
    const expiry = flag('expiry') ? Number(flag('expiry')) : nextWeeklyExpiry(forkNow);
    const pre = Number(flag('pre') ?? 300);
    const after = Number(flag('after') ?? 900);
    log('info', 'rehearsal', 'fork', { upstream: 'RH testnet', forkBlock: await client.getBlockNumber(), forkNow, expiry, close: fmtCloseEt(expiry) });

    // the mirror's last pre-close prints: every feed re-printed at its current answer
    const printer = privateKeyToAccount(key);
    await rpc('anvil_setBalance', [printer.address, '0x56BC75E2D63100000']);
    await rpc('evm_setNextBlockTimestamp', [expiry - pre]);
    await rpc('evm_mine');
    const { createWalletClient } = await import('viem');
    const w = createWalletClient({ account: printer, chain, transport: http(rpcUrl) });
    for (const [sym, feed] of Object.entries(deployment.feeds)) {
      const r = await client.readContract({ address: feed as Address, abi: mockAggregatorAbi, functionName: 'latestRoundData' });
      const hash = await w.writeContract({ address: feed as Address, abi: mockAggregatorAbi, functionName: 'pushRound', args: [r[1], BigInt(expiry - pre)] });
      await client.waitForTransactionReceipt({ hash });
      log('info', 'rehearsal', 'pre-close print', { underlying: sym, answer: r[1], updatedAt: expiry - pre });
    }
    await rpc('evm_setNextBlockTimestamp', [expiry + after]);
    await rpc('evm_mine');

    const k = createKeeper({ chain, deployment, key, rpcUrl, client, pollingInterval: 50, log, opts: { settleDelaySec: Math.min(after, 900) } });
    const sent = await tick(k, ['settleExpiry', 'settleAccounts', 'claim', 'roll']);
    const pool = await getPool(k.ctx, expiry);
    log('info', 'rehearsal', 'result', {
      txs: sent.length,
      reverted: sent.filter((t) => t.status !== 'success').length,
      labels: sent.map((t) => t.label),
      pool,
    });
    if (sent.some((t) => t.status !== 'success')) process.exitCode = 1;
  } finally {
    anvil.kill();
  }
}

main().catch((e) => {
  process.stderr.write(`${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
