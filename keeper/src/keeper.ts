/**
 * The keeper's context: one Novation deployment, one signing key, the state carried between ticks
 * (series cache, accounts seen in events, settled expiries) and the send path every job uses.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  aggregatorAbi,
  auctionHouseAbi,
  clearinghouseAbi,
  getEvents,
  getSettlementPrice,
  listSeries as readSeries,
  optionVaultAbi,
  WAD,
  type Deployment,
  type NovationContext,
  type SeriesInfo,
} from '@novation/sdk';
import { createLogger, why, type Logger } from './log';
import type { Round, RoundReader } from './hint';

export interface KeeperOptions {
  /** Minimum seconds between two syncVol of one underlying (0: on every new round). */
  syncVolEverySec: number;
  /** Grid around spot, in percent (the seed script's grid). */
  gridPcts: number[];
  /** Weekly expiries kept listed. */
  expiriesAhead: number;
  /** Of those, skip one closing sooner than this (seconds): a series listed that late barely trades. */
  minListTenorSec: number;
  /** Seconds after an expiry before settling it (lets a feed mirror catch up with late rounds). */
  settleDelaySec: number;
  /** Minimum seconds between two queue-only rolls of one vault. */
  rollEverySec: number;
  /** Most the keeper pays in one auction bid, WAD USDG. */
  bidBudget: bigint;
  /** The bidder subaccount needs at least this much cash to bid, WAD USDG. */
  minBidderCash: bigint;
  /** A deficit-sale remainder at or below this (WAD USDG) is paid in rather than bid for. */
  dustSweep: bigint;
  /** Simulate only: log what would be sent. */
  dryRun: boolean;
}

export const DEFAULT_OPTIONS: KeeperOptions = {
  syncVolEverySec: 0,
  gridPcts: [5, 10, 15, 20],
  expiriesAhead: 2,
  minListTenorSec: 0,
  settleDelaySec: 0,
  rollEverySec: 3600,
  bidBudget: 2_000n * WAD,
  minBidderCash: 10n * WAD,
  dustSweep: WAD / 100n,
  dryRun: false,
};

export interface TxRecord {
  job: string;
  label: string;
  hash: Hash;
  status: 'success' | 'reverted';
  gasUsed: bigint;
  block: bigint;
  url?: string;
}

export interface KeeperState {
  /** Series by id; never change once listed. */
  series: Map<number, SeriesInfo>;
  /** Next block to scan for events. */
  cursor?: bigint;
  /** Every account that traded or received a position in an auction. */
  accounts: Set<bigint>;
  /** `${id}:${expiry}` that settled as net receivers (AccountSettled with net > 0). */
  claims: Set<string>;
  /** `${id}:${expiry}` with a deficit sale started. */
  deficitSales: Set<string>;
  /** `${underlying}:${expiry}` -> settlement price, once settled in the registry. */
  settled: Map<string, bigint>;
  /** Vault subaccount id -> vault address. */
  vaultIds: Map<bigint, Address>;
  /** Last queue roll per vault (chain time). */
  lastRoll: Map<string, number>;
}

export interface Keeper {
  ctx: NovationContext;
  client: PublicClient;
  wallet: WalletClient;
  account: PrivateKeyAccount;
  chain: Chain;
  opts: KeeperOptions;
  state: KeeperState;
  log: Logger;
  /** Every transaction this process sent. */
  txs: TxRecord[];
}

export function createKeeper(a: {
  chain: Chain;
  deployment: Deployment;
  key: Hex;
  rpcUrl?: string;
  client?: PublicClient;
  opts?: Partial<KeeperOptions>;
  log?: Logger;
  pollingInterval?: number;
}): Keeper {
  const transport = http(a.rpcUrl, { batch: { batchSize: 100, wait: 10 }, retryCount: 3 });
  const client =
    a.client ??
    (createPublicClient({
      chain: a.chain,
      transport,
      pollingInterval: a.pollingInterval ?? 500,
      batch: a.chain.contracts?.multicall3 ? { multicall: { batchSize: 4096, wait: 10 } } : undefined,
    }) as PublicClient);
  const account = privateKeyToAccount(a.key);
  const wallet = createWalletClient({ account, chain: a.chain, transport, pollingInterval: a.pollingInterval ?? 500 });
  return {
    ctx: { client, deployment: a.deployment },
    client,
    wallet,
    account,
    chain: a.chain,
    opts: { ...DEFAULT_OPTIONS, ...a.opts },
    state: {
      series: new Map(),
      accounts: new Set(),
      claims: new Set(),
      deficitSales: new Set(),
      settled: new Map(),
      vaultIds: new Map(),
      lastRoll: new Map(),
    },
    log: a.log ?? createLogger(),
    txs: [],
  };
}

/** Chain time: the latest block's timestamp (not the host clock). */
export async function chainNow(k: Keeper): Promise<number> {
  return Number((await k.client.getBlock({ blockTag: 'latest' })).timestamp);
}

export function txUrl(k: Keeper, hash: Hash): string | undefined {
  const base = k.chain.blockExplorers?.default.url;
  return base ? `${base}/tx/${hash}` : undefined;
}

type Simulated = { request: unknown; result?: unknown };

/** Gas limit for an estimate: +25%. */
export function padGas(estimate: bigint): bigint {
  return (estimate * 125n) / 100n;
}

/**
 * Simulates, then sends and waits. A simulation that reverts is a skip, logged with its reason
 * (a decoded refusal code when known) and returned as null; nothing is signed. Every sent
 * transaction is logged as one `tx` line with its hash, status and gas.
 */
export async function execute(
  k: Keeper,
  job: string,
  label: string,
  simulate: () => Promise<Simulated>,
  fields: Record<string, unknown> = {},
): Promise<TxRecord | null> {
  let sim: Simulated;
  try {
    sim = await simulate();
  } catch (e) {
    const code = (e as { refusal?: { code?: string } })?.refusal?.code;
    k.log(code ? 'info' : 'warn', job, 'skip', { label, reason: why(e), ...fields });
    return null;
  }
  if (k.opts.dryRun) {
    k.log('info', job, 'dry-run', { label, result: sim.result, ...fields });
    return null;
  }
  // signed locally by the keeper's own key, with the gas estimate padded 25%: on an Arbitrum chain
  // the L1 part of the fee can move between estimate and inclusion
  const req = sim.request as Parameters<WalletClient['writeContract']>[0];
  const estimate = await k.client.estimateContractGas(req as Parameters<PublicClient['estimateContractGas']>[0]);
  const hash = await k.wallet.writeContract({ ...req, account: k.account, gas: padGas(estimate) });
  const rc = await k.client.waitForTransactionReceipt({ hash, timeout: 180_000 });
  const rec: TxRecord = { job, label, hash, status: rc.status, gasUsed: rc.gasUsed, block: rc.blockNumber, url: txUrl(k, hash) };
  k.txs.push(rec);
  k.log(rc.status === 'success' ? 'info' : 'error', job, 'tx', { ...rec, ...fields });
  return rec;
}

// ---------------------------------------------------------------- shared reads

/** A feed's rounds through the aggregator ABI; a missing or reverting round reads as zeros. */
export function feedReader(k: Keeper, feed: Address): RoundReader {
  const c = k.client;
  return {
    async latest(): Promise<Round> {
      const r = await c.readContract({ address: feed, abi: aggregatorAbi, functionName: 'latestRoundData' });
      return { id: BigInt(r[0]), answer: r[1], updatedAt: Number(r[3]) };
    },
    async round(id: bigint): Promise<Round> {
      try {
        const r = await c.readContract({ address: feed, abi: aggregatorAbi, functionName: 'getRoundData', args: [id] });
        return { id, answer: r[1], updatedAt: Number(r[3]) };
      } catch {
        return { id, answer: 0n, updatedAt: 0 };
      }
    },
  };
}

export async function settlementOf(k: Keeper, underlying: Address, expiry: number): Promise<bigint | null> {
  const key = `${underlying.toLowerCase()}:${expiry}`;
  const hit = k.state.settled.get(key);
  if (hit !== undefined) return hit;
  const s = await getSettlementPrice(k.ctx, underlying, expiry);
  if (!s.settled) return null;
  k.state.settled.set(key, s.price);
  return s.price;
}

/**
 * Brings the state up to the chain head: new series, and the events that name accounts (Traded,
 * LiquidationBid), receivers to claim for (AccountSettled with net > 0) and deficit sales. The
 * scan is incremental from the last block seen (the deployment block at first).
 */
export async function refresh(k: Keeper): Promise<void> {
  const { ctx, state } = k;
  await readSeries(ctx, { cache: state.series });

  if (state.vaultIds.size !== ctx.deployment.vaults.length) {
    for (const v of ctx.deployment.vaults) {
      const id = await k.client.readContract({ address: v.address, abi: optionVaultAbi, functionName: 'vaultId' });
      state.vaultIds.set(id, v.address);
    }
  }

  const to = await k.client.getBlockNumber({ cacheTime: 0 }); // uncached: a tx just sent must be in the scan
  const from = state.cursor ?? ctx.deployment.block;
  if (from > to) return;
  const scan = { fromBlock: from, toBlock: to };
  const ch = { address: ctx.deployment.clearinghouse, abi: clearinghouseAbi } as const;
  const ah = { address: ctx.deployment.auctionHouse, abi: auctionHouseAbi } as const;
  const [trades, bids, settledAccts, sales] = await Promise.all([
    getEvents(ctx, { ...ch, eventName: 'Traded', ...scan }),
    getEvents(ctx, { ...ah, eventName: 'LiquidationBid', ...scan }),
    getEvents(ctx, { ...ch, eventName: 'AccountSettled', ...scan }),
    getEvents(ctx, { ...ah, eventName: 'DeficitSaleStarted', ...scan }),
  ]);
  for (const t of trades) {
    if (t.args.takerId !== undefined) state.accounts.add(t.args.takerId);
    if (t.args.makerId !== undefined) state.accounts.add(t.args.makerId);
  }
  for (const b of bids) if (b.args.bidderId !== undefined) state.accounts.add(b.args.bidderId);
  for (const s of settledAccts) if ((s.args.net ?? 0n) > 0n) state.claims.add(`${s.args.id}:${s.args.expiry}`);
  for (const s of sales) state.deficitSales.add(`${s.args.id}:${s.args.expiry}`);
  state.cursor = to + 1n;
}

export { why };
