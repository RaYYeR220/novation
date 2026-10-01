import type { Abi, Address, ContractEventName, GetContractEventsReturnType } from 'viem';
import { auctionHouseAbi, clearinghouseAbi, insuranceFundAbi, optionVaultAbi, rfqVenueAbi, seriesRegistryAbi } from './abi/index';
import type { NovationContext } from './types';

/** Blocks per eth_getLogs request. Robinhood Chain makes ~4 blocks a second. */
export const DEFAULT_LOG_CHUNK = 50_000n;

export interface EventScan {
  /** Default: the deployment block. */
  fromBlock?: bigint;
  /** Default: the latest block. */
  toBlock?: bigint;
  /** Blocks per request; halved automatically when the node refuses a range. */
  chunk?: bigint;
}

function tooWide(e: unknown): boolean {
  const m = String((e as { details?: string; message?: string })?.details ?? (e as Error)?.message ?? e).toLowerCase();
  return /range|too many|limit|exceed|10000|query returned more|block range/.test(m);
}

/**
 * eth_getLogs for one event, in block chunks from the deployment block, in chain order. A chunk the
 * node refuses as too wide is split in half until it passes.
 */
export async function getEvents<const abi extends Abi, eventName extends ContractEventName<abi>>(
  ctx: NovationContext,
  q: { address: Address | Address[]; abi: abi; eventName: eventName; args?: Record<string, unknown> } & EventScan,
): Promise<GetContractEventsReturnType<abi, eventName>> {
  const from = q.fromBlock ?? ctx.deployment.block;
  const to = q.toBlock ?? (await ctx.client.getBlockNumber());
  let chunk = q.chunk ?? DEFAULT_LOG_CHUNK;
  const out: unknown[] = [];
  let start = from;
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
    } catch (e) {
      if (chunk > 1n && tooWide(e)) {
        chunk = chunk / 2n;
        continue;
      }
      throw e;
    }
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

/** Block timestamps (unix seconds), fetched once per block. */
export async function getBlockTimes(ctx: NovationContext, blocks: bigint[], cache = new Map<bigint, number>()): Promise<Map<bigint, number>> {
  const missing = [...new Set(blocks)].filter((b) => !cache.has(b));
  const got = await Promise.all(missing.map((b) => ctx.client.getBlock({ blockNumber: b })));
  got.forEach((b) => cache.set(b.number, Number(b.timestamp)));
  return cache;
}
