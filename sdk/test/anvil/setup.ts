/**
 * Local chain for the integration tests: anvil, the Solidity KernelReference as the risk kernel,
 * then the repo's own forge scripts (DeployMocks, Deploy, Seed) exactly as they run on testnet.
 * They write contracts/deployments/31337.json, which the tests read and which is removed after.
 *
 * Skipped (tests see `anvil: null`) when ANVIL=off or forge/anvil are not installed.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CONTRACTS = join(ROOT, 'contracts');
const DEPLOYMENT = join(CONTRACTS, 'deployments', '31337.json');
/** anvil's first default account (the public test mnemonic); deploys and seeds. */
export const ANVIL_DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

declare module 'vitest' {
  export interface ProvidedContext {
    anvil: { rpcUrl: string; deployment: unknown } | null;
  }
}

function has(bin: string): boolean {
  return spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (typeof a === 'object' && a ? resolve(a.port) : reject(new Error('no port'))));
    });
  });
}

function run(args: string[], env: Record<string, string> = {}): string {
  const r = spawnSync('forge', args, { cwd: CONTRACTS, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`forge ${args.slice(0, 2).join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

async function rpcUp(url: string, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' });
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`anvil did not come up at ${url}`);
}

export default async function setup(project: TestProject) {
  if (process.env.ANVIL === 'off' || !has('anvil') || !has('forge')) {
    project.provide('anvil', null);
    return;
  }
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const anvil: ChildProcess = spawn(
    'anvil',
    ['--port', String(port), '--chain-id', '31337', '--gas-limit', '1000000000', '--code-size-limit', '200000', '--silent'],
    { stdio: 'ignore' },
  );
  const stop = () => {
    anvil.kill();
    if (existsSync(DEPLOYMENT)) rmSync(DEPLOYMENT);
  };
  try {
    await rpcUp(rpcUrl);
    const key = ANVIL_DEPLOYER_KEY;
    const created = run(['create', 'src/kernel/KernelReference.sol:KernelReference', '--rpc-url', rpcUrl, '--private-key', key, '--broadcast']);
    const kernel = /Deployed to:\s*(0x[0-9a-fA-F]{40})/.exec(created)?.[1];
    if (!kernel) throw new Error(`KernelReference address not found in:\n${created}`);
    writeFileSync(DEPLOYMENT, JSON.stringify({ chainId: 31337, kernel: { address: kernel, type: 'solidity' }, kernelReference: kernel }, null, 2));

    const now = Math.floor(Date.now() / 1000);
    const seed: Record<string, string> = {
      SEED_NVDA_ANSWER: String(190n * 10n ** 8n),
      SEED_TSLA_ANSWER: String(440n * 10n ** 8n),
      SEED_AAPL_ANSWER: String(255n * 10n ** 8n),
      SEED_SPY_ANSWER: String(665n * 10n ** 8n),
      SEED_NVDA_UPDATED_AT: String(now - 60),
      SEED_TSLA_UPDATED_AT: String(now - 60),
      SEED_AAPL_UPDATED_AT: String(now - 60),
      SEED_SPY_UPDATED_AT: String(now - 60),
      DEPLOYER_PRIVATE_KEY: key,
    };
    const script = (name: string) => run(['script', `script/${name}`, '--rpc-url', rpcUrl, '--broadcast', '--slow', '--private-key', key], seed);
    script('DeployMocks.s.sol');
    script('Deploy.s.sol');
    script('Seed.s.sol');
    const deployment = JSON.parse(readFileSync(DEPLOYMENT, 'utf8'));
    project.provide('anvil', { rpcUrl, deployment });
  } catch (e) {
    stop();
    throw e;
  }
  return stop;
}
