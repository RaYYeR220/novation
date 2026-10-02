/**
 * The keeper's context: one Novation deployment, one signing key, the state carried between ticks
 * (series cache, accounts seen in events, settled expiries) and the send path every job uses.
 */
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  type Abi,
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
  /** Most series listed in one tick; the rest wait for the next. */
  listPerTick: number;
  /** Seconds after an expiry before settling it (lets a feed mirror catch up with late rounds). */
  settleDelaySec: number;
  /** Minimum seconds between two queue rolls of one vault by the roll job (a payable queue is rolled at once). */
  rollEverySec: number;
  /** Below this balance (wei) the optional work (vol sync, listing, queue-only rolls) is skipped, keeping gas for settlement. */
  gasReserve: bigint;
  /** Bid in liquidations and deficit sales at all (opt-in). */
  bid: boolean;
  /** Most the keeper pays in one auction bid, WAD USDG. */
  bidBudget: bigint;
  /** Most the keeper commits to auction bids over the life of the process, WAD USDG. */
  bidExposureCap: bigint;
  /** The bidder subaccount needs at least this much cash to bid, WAD USDG. */
  minBidderCash: bigint;
  /** A liquidation the keeper can't bid in is (re)started at most this often per account, seconds. */
  restartBackoffSec: number;
  /** A deficit-sale remainder at or below this (WAD USDG) is paid in rather than bid for. */
  dustSweep: bigint;
  /** Event scans stop this many blocks below the head (a lagging RPC node can't skip a block). */
  confirmations: number;
  /** Each event scan re-reads this many blocks before the last one; logs are deduplicated. */
  scanOverlap: number;
  /** How long to wait for a receipt before leaving the transaction open (ms). */
  receiptTimeoutMs: number;
  /** Simulate only: log what would be sent. */
  dryRun: boolean;
}

export const DEFAULT_OPTIONS: KeeperOptions = {
  syncVolEverySec: 0,
  gridPcts: [5, 10, 15, 20],
  expiriesAhead: 2,
  minListTenorSec: 0,
  listPerTick: 16,
  settleDelaySec: 900,
  rollEverySec: 86400,
  gasReserve: 100_000_000_000_000n, // 0.0001 ETH
  bid: false,
  bidBudget: 2_000n * WAD,
  bidExposureCap: 5_000n * WAD,
  minBidderCash: 10n * WAD,
  restartBackoffSec: 6 * 3600,
  dustSweep: WAD / 100n,
  confirmations: 5,
  scanOverlap: 200,
  receiptTimeoutMs: 180_000,
  dryRun: false,
};

/** Chains whose mock tokens mint freely and where the derived keeper key may be used. */
export const TEST_CHAIN_IDS: readonly number[] = [46630, 31337];

export function isTestChain(chainId: number): boolean {
  return TEST_CHAIN_IDS.includes(chainId);
}

/** Per-transaction gas the keeper will ever ask for (Arbitrum's cap is 32M). */
export const MAX_TX_GAS = 31_500_000n;

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
  /** Last queue roll per vault by the roll job (chain time). */
  lastRoll: Map<string, number>;
  /** Event logs already applied, tx:logIndex -> block (pruned below the overlap window). */
  seen: Map<string, bigint>;
  /** Transactions broadcast without a receipt yet; nothing new is sent while one is open. */
  pending: Map<Hash, PendingTx>;
  /** WAD USDG paid into auction bids so far. */
  committed: bigint;
  /** Last time the keeper started a liquidation, per account (chain time). */
  lastStart: Map<bigint, number>;
}

export interface PendingTx {
  hash: Hash;
  nonce: number;
  job: string;
  label: string;
  fields: Record<string, unknown>;
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
      seen: new Map(),
      pending: new Map(),
      committed: 0n,
      lastStart: new Map(),
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

/**
 * Gas limit for an estimate: +25% (on an Arbitrum chain the L1 part of the fee can move between
 * estimate and inclusion), never above MAX_TX_GAS. When +25% would cross it, +5% capped at it.
 */
export function padGas(estimate: bigint): bigint {
  const padded = (estimate * 125n) / 100n;
  if (padded <= MAX_TX_GAS) return padded;
  const tight = (estimate * 105n) / 100n;
  return tight < MAX_TX_GAS ? tight : MAX_TX_GAS;
}

/** The keeper's balance is below the gas reserve: optional work waits. */
export async function belowReserve(k: Keeper): Promise<boolean> {
  return (await k.client.getBalance({ address: k.account.address })) < k.opts.gasReserve;
}

function record(k: Keeper, p: PendingTx, rc: { status: 'success' | 'reverted'; gasUsed: bigint; blockNumber: bigint }, late = false): TxRecord {
  const rec: TxRecord = { job: p.job, label: p.label, hash: p.hash, status: rc.status, gasUsed: rc.gasUsed, block: rc.blockNumber, url: txUrl(k, p.hash) };
  k.txs.push(rec);
  k.state.pending.delete(p.hash);
  k.log(rc.status === 'success' ? 'info' : 'error', p.job, 'tx', { ...rec, ...p.fields, ...(late ? { late: true } : {}) });
  return rec;
}

/**
 * Settles the open transactions: a mined one is logged; one the node no longer knows, or whose
 * nonce another transaction has used, is dropped (its work is re-checked from chain state on the
 * next pass, so nothing is sent twice). True when nothing is open any more.
 */
export async function resolvePending(k: Keeper): Promise<boolean> {
  for (const p of [...k.state.pending.values()]) {
    const rc = await k.client.getTransactionReceipt({ hash: p.hash }).catch(() => null);
    if (rc) {
      record(k, p, rc, true);
      continue;
    }
    const used = await k.client.getTransactionCount({ address: k.account.address, blockTag: 'latest' });
    const known = await k.client.getTransaction({ hash: p.hash }).catch(() => null);
    if (used > p.nonce || !known) {
      k.state.pending.delete(p.hash);
      k.log('warn', p.job, 'dropped', { label: p.label, hash: p.hash, nonce: p.nonce, reason: known ? 'nonce used by another transaction' : 'unknown to the node' });
    }
  }
  return k.state.pending.size === 0;
}

/**
 * Simulates, then sends and waits. A simulation (or gas estimate) that reverts is a skip, logged
 * with its reason (a decoded refusal code when known) and returned as null; nothing is signed.
 * The transaction is signed locally by the keeper key and its hash is known before broadcast: one
 * whose receipt doesn't come in time stays open (resolvePending), and nothing new is sent until it
 * is settled, so a slow inclusion can't lead to the same work being sent twice. Every mined
 * transaction is logged as one `tx` line with its hash, status and gas.
 */
export async function execute(
  k: Keeper,
  job: string,
  label: string,
  simulate: () => Promise<Simulated>,
  fields: Record<string, unknown> = {},
): Promise<TxRecord | null> {
  if (k.state.pending.size && !(await resolvePending(k))) {
    k.log('info', job, 'skip', { label, reason: 'an earlier transaction is still pending', pending: [...k.state.pending.keys()], ...fields });
    return null;
  }
  let sim: Simulated;
  let gas = 0n;
  try {
    sim = await simulate();
    if (!k.opts.dryRun) gas = padGas(await k.client.estimateContractGas(sim.request as Parameters<PublicClient['estimateContractGas']>[0]));
  } catch (e) {
    const code = (e as { refusal?: { code?: string } })?.refusal?.code;
    k.log(code ? 'info' : 'warn', job, 'skip', { label, reason: why(e), ...fields });
    return null;
  }
  if (k.opts.dryRun) {
    k.log('info', job, 'dry-run', { label, result: sim.result, ...fields });
    return null;
  }
  const req = sim.request as { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; value?: bigint };
  const p: PendingTx = { hash: '0x', nonce: 0, job, label, fields };
  try {
    const nonce = await k.client.getTransactionCount({ address: k.account.address, blockTag: 'pending' });
    const prepared = await k.wallet.prepareTransactionRequest({
      account: k.account,
      chain: k.chain,
      to: req.address,
      data: encodeFunctionData({ abi: req.abi, functionName: req.functionName, args: req.args }),
      value: req.value,
      gas,
      nonce,
    });
    const serialized = await k.wallet.signTransaction(prepared as Parameters<WalletClient['signTransaction']>[0]);
    p.hash = keccak256(serialized);
    p.nonce = nonce;
    k.state.pending.set(p.hash, p);
    await k.wallet.sendRawTransaction({ serializedTransaction: serialized });
  } catch (e) {
    k.log('error', job, 'send failed', { label, ...(p.hash !== '0x' ? { hash: p.hash } : {}), reason: why(e), ...fields });
    if (p.hash !== '0x') await resolvePending(k).catch(() => false);
    return null;
  }
  try {
    const rc = await k.client.waitForTransactionReceipt({ hash: p.hash, timeout: k.opts.receiptTimeoutMs });
    return record(k, p, rc);
  } catch (e) {
    k.log('warn', job, 'pending', { label, hash: p.hash, nonce: p.nonce, reason: why(e), ...fields });
    return null;
  }
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
 * Brings the state up to the chain: new series, and the events that name accounts (Traded,
 * LiquidationBid), receivers to claim for (AccountSettled with net > 0) and deficit sales. The
 * scan is incremental from the last block seen (the deployment block at first), stops
 * `confirmations` blocks below the head and re-reads `scanOverlap` blocks before its cursor, so a
 * load-balanced RPC that answers getLogs from a node a few blocks behind can't make it skip a
 * block for good. Each log is applied once, by (transaction, log index).
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

  const head = await k.client.getBlockNumber({ cacheTime: 0 });
  const to = head - BigInt(k.opts.confirmations);
  const start = ctx.deployment.block;
  const overlap = BigInt(k.opts.scanOverlap);
  const from = state.cursor === undefined ? start : state.cursor - overlap > start ? state.cursor - overlap : start;
  if (to < from) return;
  const scan = { fromBlock: from, toBlock: to };
  const ch = { address: ctx.deployment.clearinghouse, abi: clearinghouseAbi } as const;
  const ah = { address: ctx.deployment.auctionHouse, abi: auctionHouseAbi } as const;
  const [trades, bids, settledAccts, sales] = await Promise.all([
    getEvents(ctx, { ...ch, eventName: 'Traded', ...scan }),
    getEvents(ctx, { ...ah, eventName: 'LiquidationBid', ...scan }),
    getEvents(ctx, { ...ch, eventName: 'AccountSettled', ...scan }),
    getEvents(ctx, { ...ah, eventName: 'DeficitSaleStarted', ...scan }),
  ]);
  const fresh = (l: { transactionHash: Hash | null; logIndex: number | null; blockNumber: bigint | null }) => {
    const id = `${l.transactionHash}:${l.logIndex}`;
    if (state.seen.has(id)) return false;
    state.seen.set(id, l.blockNumber ?? to);
    return true;
  };
  for (const t of trades.filter(fresh)) {
    if (t.args.takerId !== undefined) state.accounts.add(t.args.takerId);
    if (t.args.makerId !== undefined) state.accounts.add(t.args.makerId);
  }
  for (const b of bids.filter(fresh)) if (b.args.bidderId !== undefined) state.accounts.add(b.args.bidderId);
  for (const s of settledAccts.filter(fresh)) if ((s.args.net ?? 0n) > 0n) state.claims.add(`${s.args.id}:${s.args.expiry}`);
  for (const s of sales.filter(fresh)) state.deficitSales.add(`${s.args.id}:${s.args.expiry}`);
  state.cursor = to + 1n;
  for (const [id, b] of state.seen) if (b + overlap < state.cursor) state.seen.delete(id);
}

export { why };
