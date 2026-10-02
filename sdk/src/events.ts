import type { Abi, Address, ContractEventName, GetContractEventsReturnType } from 'viem';
import { auctionHouseAbi, clearinghouseAbi, insuranceFundAbi, optionVaultAbi, rfqVenueAbi, seriesRegistryAbi } from './abi/index';
import type { NovationContext } from './types';

export interface EventScan {
  /** Default: the deployment block. */
  fromBlock?: bigint;
  /** Default: the latest block. */
  toBlock?: bigint;
  /**
   * Blocks per request. Default: the whole range in one request, split in half only when the node
   * refuses it as too wide. At least 1.
   */
  chunk?: bigint;
  /** Where scanned ranges are kept; default the context's `eventCache`, if any. */
  cache?: EventCache;
}

/** Logs already scanned for one (contract, event, filter, start block), up to block `to`. */
export interface CachedScan {
  from: bigint;
  to: bigint;
  logs: unknown[];
}

/** Scanned ranges per (contract, event, filter): a later scan to the latest block fetches only new blocks. */
export interface EventCache {
  get(key: string): CachedScan | undefined;
  set(key: string, scan: CachedScan): void;
}

/** An in-memory EventCache. */
export function memoryEventCache(): EventCache {
  const m = new Map<string, CachedScan>();
  return { get: (k) => m.get(k), set: (k, v) => void m.set(k, v) };
}

const RETRIES = 4;

/**
 * Blocks behind the head that a cache never keeps: a load-balanced node a few blocks behind, or a
 * short reorg, can't leave a permanent gap. Each scan fetches this tail again.
 */
export const UNSAFE_TAIL_BLOCKS = 32n;

/** Every message, detail and status in an error's cause chain, lowercased. */
function errorText(e: unknown): string {
  const parts: unknown[] = [];
  const seen = new Set<unknown>();
  let x = e as { details?: string; shortMessage?: string; message?: string; status?: number; cause?: unknown } | undefined;
  while (x && typeof x === 'object' && !seen.has(x)) {
    seen.add(x);
    parts.push(x.status, x.details, x.shortMessage, x.message);
    x = x.cause as typeof x;
  }
  if (typeof e === 'string') parts.push(e);
  return parts.filter(Boolean).join(' ').toLowerCase();
}

/** JSON-RPC error codes anywhere in the cause chain. */
function errorCodes(e: unknown): number[] {
  const out: number[] = [];
  const seen = new Set<unknown>();
  let x = e as { code?: unknown; cause?: unknown } | undefined;
  while (x && typeof x === 'object' && !seen.has(x)) {
    seen.add(x);
    if (typeof x.code === 'number') out.push(x.code);
    x = x.cause as typeof x;
  }
  return out;
}

/** The node throttled the request (HTTP 429, "rate limit"): wait and retry, never shrink the range for it. */
export function isRateLimited(e: unknown): boolean {
  return /\b429\b|rate.?limit|too many requests|throttl|capacity exceeded/.test(errorText(e));
}

const RANGE_WORDING = new RegExp(
  [
    'query returned more than',
    'block range',
    'range (is )?too (large|wide|big|long)',
    'exceeds? (the )?(max(imum)?|allowed) (block )?range',
    'max(imum)? (block )?range',
    'response size (exceeded|is larger|too (large|big))',
    'log response size',
    'too many (results|logs|blocks)',
    'requested too many',
    'is limited to( a)? [0-9,]+',
    'range limit',
    'results? limit',
    '[0-9,]+ results',
    'exceeds? (the )?(max|maximum) ',
  ].join('|'),
);

/**
 * The node refused the block range itself (too many blocks or results in one eth_getLogs), in the
 * wordings and codes common providers use (-32005 limit exceeded, -32602 invalid range). Never a
 * rate limit: that is retried at the same range.
 */
export function isRangeTooWide(e: unknown): boolean {
  if (isRateLimited(e)) return false;
  return RANGE_WORDING.test(errorText(e)) || errorCodes(e).some((c) => c === -32005 || c === -32602);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lower = (a: Address | Address[]) => (Array.isArray(a) ? a.map((x) => x.toLowerCase()).sort().join(',') : a.toLowerCase());
const argKey = (args?: Record<string, unknown>) =>
  JSON.stringify(Object.entries(args ?? {}).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

/**
 * eth_getLogs for one event from the deployment block, in chain order. The whole range goes in one
 * request; a range the node refuses as too wide is split in half until it passes, and a throttled
 * request backs off and retries. With a cache, a scan up to the latest block fetches only the
 * blocks after the cached ones, which stop UNSAFE_TAIL_BLOCKS short of the head.
 */
export async function getEvents<const abi extends Abi, eventName extends ContractEventName<abi>>(
  ctx: NovationContext,
  q: { address: Address | Address[]; abi: abi; eventName: eventName; args?: Record<string, unknown> } & EventScan,
): Promise<GetContractEventsReturnType<abi, eventName>> {
  if (q.chunk !== undefined && q.chunk < 1n) throw new RangeError('getEvents: chunk must be at least 1 block');
  const from = q.fromBlock ?? ctx.deployment.block;
  const cache = q.cache ?? ctx.eventCache;
  const key = `${ctx.deployment.chainId}|${lower(q.address)}|${q.eventName as string}|${argKey(q.args)}|${from}`;
  const to = q.toBlock ?? (await ctx.client.getBlockNumber());
  const hit = q.toBlock === undefined ? cache?.get(key) : undefined;
  if (hit && hit.from === from && hit.to >= to) return hit.logs as GetContractEventsReturnType<abi, eventName>;
  const out: unknown[] = hit && hit.from === from ? [...hit.logs] : [];
  let start = hit && hit.from === from ? hit.to + 1n : from;
  let chunk = q.chunk ?? to - start + 1n;
  let tries = 0;
  while (start <= to) {
    const end = start + chunk - 1n < to ? start + chunk - 1n : to;
    try {
      const logs = await ctx.client.getContractEvents({
        address: q.address,
        abi: q.abi as Abi,
        eventName: q.eventName as string,
        args: q.args as never,
        fromBlock: start,
        toBlock: end,
        strict: true,
      });
      out.push(...logs);
      start = end + 1n;
      tries = 0;
    } catch (e) {
      if (isRateLimited(e) && tries < RETRIES) {
        await sleep(500 * 2 ** tries++);
        continue;
      }
      if (chunk > 1n && isRangeTooWide(e)) {
        chunk = chunk / 2n;
        continue;
      }
      throw e;
    }
  }
  if (cache && q.toBlock === undefined) {
    // keep the tail out of the cache: the next scan fetches it again
    const safe = to - UNSAFE_TAIL_BLOCKS;
    if (safe >= from) cache.set(key, { from, to: safe, logs: out.filter((l) => (l as { blockNumber: bigint }).blockNumber <= safe) });
  }
  return out as GetContractEventsReturnType<abi, eventName>;
}

const ch = (ctx: NovationContext) => ({ address: ctx.deployment.clearinghouse, abi: clearinghouseAbi }) as const;

export function getTrades(ctx: NovationContext, f: { takerId?: bigint; makerId?: bigint; seriesId?: number } & EventScan = {}) {
  const { takerId, makerId, seriesId, ...scan } = f;
  return getEvents(ctx, { ...ch(ctx), eventName: 'Traded', args: { takerId, makerId, seriesId }, ...scan });
}

export function getSubaccountsCreated(ctx: NovationContext, f: { owner?: Address } & EventScan = {}) {
  const { owner, ...scan } = f;
  return getEvents(ctx, { ...ch(ctx), eventName: 'SubaccountCreated', args: { owner }, ...scan });
}

/** AgentGranted and AgentRevoked for one account, merged in chain order. */
export async function getAgentEvents(ctx: NovationContext, id: bigint, scan: EventScan = {}) {
  const [granted, revoked] = await Promise.all([
    getEvents(ctx, { ...ch(ctx), eventName: 'AgentGranted', args: { id }, ...scan }),
    getEvents(ctx, { ...ch(ctx), eventName: 'AgentRevoked', args: { id }, ...scan }),
  ]);
  return [...granted, ...revoked].sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
}

export function getDeposits(ctx: NovationContext, f: { id?: bigint } & EventScan = {}) {
  const { id, ...scan } = f;
  return getEvents(ctx, { ...ch(ctx), eventName: 'Deposited', args: { id }, ...scan });
}

export function getWithdrawals(ctx: NovationContext, f: { id?: bigint } & EventScan = {}) {
  const { id, ...scan } = f;
  return getEvents(ctx, { ...ch(ctx), eventName: 'Withdrawn', args: { id }, ...scan });
}

export function getAccountSettlements(ctx: NovationContext, f: { id?: bigint; expiry?: bigint } & EventScan = {}) {
  const { id, expiry, ...scan } = f;
  return getEvents(ctx, { ...ch(ctx), eventName: 'AccountSettled', args: { id, expiry }, ...scan });
}

export function getClaims(ctx: NovationContext, f: { id?: bigint; expiry?: bigint } & EventScan = {}) {
  const { id, expiry, ...scan } = f;
  return getEvents(ctx, { ...ch(ctx), eventName: 'Claimed', args: { id, expiry }, ...scan });
}

export function getLossesSocialized(ctx: NovationContext, scan: EventScan = {}) {
  return getEvents(ctx, { ...ch(ctx), eventName: 'LossSocialized', ...scan });
}

export function getExpirySettlements(ctx: NovationContext, f: { underlying?: Address; expiry?: bigint } & EventScan = {}) {
  const { underlying, expiry, ...scan } = f;
  return getEvents(ctx, { address: ctx.deployment.registry, abi: seriesRegistryAbi, eventName: 'ExpirySettled', args: { underlying, expiry }, ...scan });
}

export function getSeriesListed(ctx: NovationContext, scan: EventScan = {}) {
  return getEvents(ctx, { address: ctx.deployment.registry, abi: seriesRegistryAbi, eventName: 'SeriesListed', ...scan });
}

export function getQuoteFills(ctx: NovationContext, f: { takerId?: bigint } & EventScan = {}) {
  const { takerId, ...scan } = f;
  return getEvents(ctx, { address: ctx.deployment.rfq, abi: rfqVenueAbi, eventName: 'QuoteFilled', args: { takerId }, ...scan });
}

/** A vault's sales, buybacks, rolls and redemption requests. */
export async function getVaultActivity(ctx: NovationContext, vault: Address, scan: EventScan = {}) {
  const v = { address: vault, abi: optionVaultAbi } as const;
  const [bought, soldBack, rolled, requested, claimed, deposits, withdrawals] = await Promise.all([
    getEvents(ctx, { ...v, eventName: 'Bought', ...scan }),
    getEvents(ctx, { ...v, eventName: 'SoldBack', ...scan }),
    getEvents(ctx, { ...v, eventName: 'Rolled', ...scan }),
    getEvents(ctx, { ...v, eventName: 'RedeemRequested', ...scan }),
    getEvents(ctx, { ...v, eventName: 'RedeemClaimed', ...scan }),
    getEvents(ctx, { ...v, eventName: 'Deposit', ...scan }),
    getEvents(ctx, { ...v, eventName: 'Withdraw', ...scan }),
  ]);
  return { bought, soldBack, rolled, requested, claimed, deposits, withdrawals };
}

export async function getInsuranceEvents(ctx: NovationContext, scan: EventScan = {}) {
  const f = { address: ctx.deployment.insurance, abi: insuranceFundAbi } as const;
  const [covered, recovered, writtenOff] = await Promise.all([
    getEvents(ctx, { ...f, eventName: 'Covered', ...scan }),
    getEvents(ctx, { ...f, eventName: 'Recovered', ...scan }),
    getEvents(ctx, { ...f, eventName: 'WrittenOff', ...scan }),
  ]);
  return { covered, recovered, writtenOff };
}

export async function getAuctionEvents(ctx: NovationContext, scan: EventScan = {}) {
  const a = { address: ctx.deployment.auctionHouse, abi: auctionHouseAbi } as const;
  const [started, bids, ended, saleStarted, saleBids, saleEnded] = await Promise.all([
    getEvents(ctx, { ...a, eventName: 'LiquidationStarted', ...scan }),
    getEvents(ctx, { ...a, eventName: 'LiquidationBid', ...scan }),
    getEvents(ctx, { ...a, eventName: 'LiquidationEnded', ...scan }),
    getEvents(ctx, { ...a, eventName: 'DeficitSaleStarted', ...scan }),
    getEvents(ctx, { ...a, eventName: 'DeficitBid', ...scan }),
    getEvents(ctx, { ...a, eventName: 'DeficitSaleEnded', ...scan }),
  ]);
  return { started, bids, ended, saleStarted, saleBids, saleEnded };
}

/** Block timestamps (unix seconds), fetched once per block; the context's `blockTimes` is the default cache. */
export async function getBlockTimes(ctx: NovationContext, blocks: bigint[], cache = ctx.blockTimes ?? new Map<bigint, number>()): Promise<Map<bigint, number>> {
  const missing = [...new Set(blocks)].filter((b) => !cache.has(b));
  const got = await Promise.all(missing.map((b) => ctx.client.getBlock({ blockNumber: b })));
  got.forEach((b) => cache.set(b.number, Number(b.timestamp)));
  return cache;
}
