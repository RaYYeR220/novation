/**
 * keeper CLI.
 *
 *   tsx src/cli.ts --once                 one tick of every job
 *   tsx src/cli.ts --loop 120             a tick every 120 s, forever
 *   tsx src/cli.ts address                the keeper address
 *   tsx src/cli.ts fund [--eth 0.0005]    top the keeper's gas up from the deployer key
 *   tsx src/cli.ts setup [--usdg 5000]    open and fund the keeper's bidding subaccount (testnet)
 *   tsx src/cli.ts hint [--expiry next|<unix>] [--now <unix>] [--underlying NVDA]
 *                                         dry-run the settlement hint finder (no transaction)
 *   tsx src/cli.ts demo [--underlying NVDA] [--expiry next|<unix>] [--qty 1]
 *                                         open a small book on an expiry from the keeper's own
 *                                         subaccounts, so its settlement has a payer (testnet)
 *
 * Options: --jobs a,b  --dry-run  --debug  --sync-vol-every <s>  --min-list-tenor <s>
 *          --list-per-tick <n>  --settle-delay <s>  --roll-every <s>  --gas-reserve <eth>
 *          --bid | --no-bid  --bid-cap <usdg>  --confirmations <n>  --chain-id <id>  --rpc <url>
 *          --deployment <path to contracts/deployments/<chainId>.json>
 * Keys come from the repo's .env: KEEPER_PRIVATE_KEY, or on the testnet a key derived from
 * DEPLOYER_PRIVATE_KEY.
 */
import { readFileSync } from 'node:fs';
import { decodeFunctionResult, encodeFunctionData, formatEther, parseEther, type Hex } from 'viem';
import {
  chainById,
  fmtCloseEt,
  fromWad,
  getDeployment,
  getUnderlyingTokens,
  nextWeeklyExpiry,
  parseDeployment,
  seriesRegistryAbi,
  symbolOf,
  WAD,
  type Address,
} from '@novation/sdk';
import { loadDotEnv } from './env';
import { JOB_NAMES, tick, type JobName } from './jobs/index';
import { hintFor } from './jobs/settleExpiry';
import { chainNow, createKeeper, isTestChain, type Keeper } from './keeper';
import { keeperKeyFromEnv } from './keys';
import { createLogger, why } from './log';
import { ensureSubaccounts, fundSubaccount, topUpKeeper } from './setup';
import { openDemoPosition } from './demo';

function parse(argv: string[]) {
  const flags: Record<string, string | true> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const nxt = argv[i + 1];
      if (nxt !== undefined && !nxt.startsWith('--')) {
        flags[a.slice(2)] = nxt;
        i++;
      } else flags[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { cmd: pos[0] ?? 'run', flags };
}

const num = (v: string | true | undefined, d: number) => (typeof v === 'string' ? Number(v) : d);

async function main() {
  loadDotEnv();
  const { cmd, flags } = parse(process.argv.slice(2));
  const log = createLogger({ debug: flags.debug === true });
  const chainId = num(flags['chain-id'], 46630);
  const chain = chainById(chainId);
  if (!chain) throw new Error(`unknown chain ${chainId}`);
  const rpcUrl =
    (typeof flags.rpc === 'string' ? flags.rpc : undefined) ??
    (chainId === 46630 ? process.env.RH_TESTNET_RPC : process.env.RH_MAINNET_RPC) ??
    chain.rpcUrls.default.http[0];
  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined;
  const key = keeperKeyFromEnv(chainId);
  const testnet = isTestChain(chainId);
  const deployment =
    typeof flags.deployment === 'string' ? parseDeployment(JSON.parse(readFileSync(flags.deployment, 'utf8'))) : getDeployment(chainId);
  if (deployment.chainId !== chainId) throw new Error(`the deployment is for chain ${deployment.chainId}, not ${chainId}`);

  const jobs = typeof flags.jobs === 'string' ? (flags.jobs.split(',') as JobName[]) : JOB_NAMES;
  for (const j of jobs) if (!JOB_NAMES.includes(j)) throw new Error(`unknown job ${j}; jobs: ${JOB_NAMES.join(', ')}`);

  const k: Keeper = createKeeper({
    chain,
    deployment,
    key,
    rpcUrl,
    log,
    opts: {
      syncVolEverySec: num(flags['sync-vol-every'], 3600),
      minListTenorSec: num(flags['min-list-tenor'], 2 * 86400),
      listPerTick: num(flags['list-per-tick'], 16),
      settleDelaySec: num(flags['settle-delay'], 900),
      rollEverySec: num(flags['roll-every'], 3600),
      gasReserve: parseEther(typeof flags['gas-reserve'] === 'string' ? flags['gas-reserve'] : '0.0001'),
      // bidding is opt-in: on by default on the testnet (mock USDG), off elsewhere unless --bid
      bid: flags['no-bid'] === true ? false : flags.bid === true || testnet,
      bidExposureCap: BigInt(Math.round(num(flags['bid-cap'], 5000))) * WAD,
      confirmations: num(flags.confirmations, 5),
      dryRun: flags['dry-run'] === true,
    },
  });

  const testnetOnly = (what: string) => {
    if (!testnet) throw new Error(`${what} mints mock tokens and runs on the testnet or a local chain only, not on chain ${chainId}`);
  };

  switch (cmd) {
    case 'address': {
      const bal = await k.client.getBalance({ address: k.account.address });
      log('info', 'cli', 'keeper', { address: k.account.address, eth: formatEther(bal), chainId });
      return;
    }
    case 'fund': {
      if (!deployerKey) throw new Error('fund needs DEPLOYER_PRIVATE_KEY');
      const target = parseEther(typeof flags.eth === 'string' ? flags.eth : '0.0005');
      await topUpKeeper({ client: k.client, chain, rpcUrl, deployerKey, keeper: k.account.address, target, log });
      return;
    }
    case 'setup': {
      testnetOnly('setup');
      const [bidder] = await ensureSubaccounts(k, 1);
      await fundSubaccount(k, bidder!, BigInt(Math.round(num(flags.usdg, 5000))) * WAD);
      log('info', 'setup', 'bidder', { id: bidder });
      return;
    }
    case 'hint':
      return hintCmd(k, flags);
    case 'demo': {
      testnetOnly('demo');
      const now = await chainNow(k);
      const expiry = typeof flags.expiry === 'string' && flags.expiry !== 'next' ? Number(flags.expiry) : nextWeeklyExpiry(now);
      const qty = BigInt(Math.round(num(flags.qty, 1) * 1e6)) * 10n ** 12n;
      const r = await openDemoPosition(k, { underlying: typeof flags.underlying === 'string' ? flags.underlying : 'NVDA', expiry, qty });
      log('info', 'demo', 'done', { ...r });
      return;
    }
    case 'run':
      break;
    default:
      throw new Error(`unknown command ${cmd}`);
  }

  const loop = flags.loop;
  if (typeof loop === 'string') {
    const every = Number(loop) * 1000;
    log('info', 'cli', 'start', { keeper: k.account.address, chainId, every: Number(loop), jobs, opts: k.opts });
    for (;;) {
      try {
        await tick(k, jobs);
      } catch (e) {
        log('error', 'tick', 'failed', { reason: why(e) });
      }
      await new Promise((r) => setTimeout(r, every));
    }
  }
  log('info', 'cli', 'start', { keeper: k.account.address, chainId, once: true, jobs, opts: k.opts });
  await tick(k, jobs);
}

/**
 * Dry run of the hint finder: for each underlying, the round settleExpiry would get at `--now`
 * (default: chain time) for `--expiry` (default: the next weekly expiry), and the registry's own
 * answer to that call, an eth_call with the block time overridden to `--now`.
 */
async function hintCmd(k: Keeper, flags: Record<string, string | true>) {
  const chainTime = await chainNow(k);
  const expiry = typeof flags.expiry === 'string' && flags.expiry !== 'next' ? Number(flags.expiry) : nextWeeklyExpiry(chainTime);
  const now = typeof flags.now === 'string' ? Number(flags.now) : chainTime;
  const tokens = (await getUnderlyingTokens(k.ctx)).filter(
    (u) => typeof flags.underlying !== 'string' || symbolOf(k.ctx.deployment, u) === flags.underlying,
  );
  for (const u of tokens) {
    const sym = symbolOf(k.ctx.deployment, u) ?? u;
    const h = await hintFor(k, u, expiry, now);
    const base = { underlying: sym, expiry, close: fmtCloseEt(expiry), now, simulatedNow: now !== chainTime };
    if (h.kind !== 'ready') {
      k.log('info', 'hint', h.kind, { ...base, reason: h.reason, round: h.round?.id, roundUpdatedAt: h.round?.updatedAt, reads: h.reads });
      continue;
    }
    const registry = await checkOnRegistry(k, u, expiry, h.hint, h.method, now);
    k.log('info', 'hint', 'ready', {
      ...base,
      method: h.method,
      proof: h.proof,
      hint: h.hint,
      roundUpdatedAt: h.round.updatedAt,
      answer: h.round.answer,
      next: h.next?.id,
      nextUpdatedAt: h.next?.updatedAt,
      reads: h.reads,
      registry,
    });
  }
}

/** SeriesRegistry.settleExpiry(u, expiry, hint) as an eth_call at block time `now`: the price, or the revert. */
async function checkOnRegistry(k: Keeper, u: Address, expiry: number, hint: bigint, method: 'settleExpiry' | 'settleExpiryFallback' | 'settleExpiryLastResort', now: number) {
  const data = encodeFunctionData({ abi: seriesRegistryAbi, functionName: method, args: [u, BigInt(expiry), hint] });
  try {
    const r = await k.client.call({ to: k.ctx.deployment.registry, data, account: k.account.address, blockOverrides: { time: BigInt(now) } });
    const price = decodeFunctionResult({ abi: seriesRegistryAbi, functionName: method, data: r.data! });
    return { ok: true, price: fromWad(price) };
  } catch (e) {
    return { ok: false, reason: why(e) };
  }
}

main().catch((e) => {
  process.stderr.write(`${why(e)}\n`);
  process.exit(1);
});
