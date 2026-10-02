import type { Address, Hex, PublicClient } from 'viem';
import type { EventCache } from './events';

/** MarketDataHub sessions, in enum order (Types.sol). */
export const SESSIONS = ['REGULAR', 'EXTENDED', 'WEEKEND', 'HOLIDAY', 'HALTED'] as const;
export type Session = (typeof SESSIONS)[number];

export function sessionOf(i: number | bigint): Session {
  const s = SESSIONS[Number(i)];
  if (!s) throw new RangeError(`unknown session ${i}`);
  return s;
}

export type VaultKind = 'coveredCall' | 'putWrite';

/** contracts/deployments/<chainId>.json. */
export interface Deployment {
  chainId: number;
  /** First block of the core deployment: event scans start here. */
  block: bigint;
  kernel: Address;
  kernelReference?: Address;
  /** Symbol -> token. USDG is the settlement token; the others are stock tokens. */
  tokens: Record<string, Address>;
  /** Symbol -> Chainlink-style feed proxy. */
  feeds: Record<string, Address>;
  timelock: Address;
  guardian: Address;
  riskParams: Address;
  hub: Address;
  registry: Address;
  insurance: Address;
  clearinghouse: Address;
  auctionHouse: Address;
  rfq: Address;
  vaults: { address: Address; type: VaultKind; underlying: string }[];
  /** The linked libraries (TradeLogic, SettlementLogic, VaultPricing, ...), when recorded. */
  libraries?: Record<string, Address>;
}

/** What every SDK helper reads through. */
export interface NovationContext {
  client: PublicClient;
  deployment: Deployment;
  /** Scanned event ranges, so later scans fetch only new blocks (see events.getEvents). */
  eventCache?: EventCache;
  /** Block timestamps by number; blocks never change. */
  blockTimes?: Map<bigint, number>;
}

export interface SeriesInfo {
  id: number;
  underlying: Address;
  /** Unix seconds: a weekly expiry, the close of the last trading day of the week. */
  expiry: number;
  isCall: boolean;
  /** WAD USD per raw token. */
  strike: bigint;
}

export interface PositionInfo extends SeriesInfo {
  seriesId: number;
  /** WAD contracts: > 0 long, < 0 short. */
  qty: bigint;
}

/** Clearinghouse.accountState / marginAfter. Every amount is WAD USDG. */
export interface AccountState {
  cash: bigint;
  mtm: bigint;
  settledValue: bigint;
  deficit: bigint;
  equity: bigint;
  im: bigint;
  mm: bigint;
  worstScenario: number;
  healthy: boolean;
  liquidatable: boolean;
}

export interface AgentPolicy {
  /** WAD USD cap on the account's post-trade lossIM. */
  maxWorstLoss: bigint;
  /** WAD USD. */
  maxPremiumPerTrade: bigint;
  /** Bit i: the underlying with RiskParams index i is allowed. */
  allowedMask: bigint;
  /** Unix seconds. */
  expiresAt: number;
}

/** RfqVenue's signed maker offer. */
export interface RfqQuote {
  signer: Address;
  makerId: bigint;
  seriesId: number;
  /** true: the taker buys from the maker. */
  makerSells: boolean;
  /** WAD contracts. */
  maxQty: bigint;
  /** WAD USDG per contract. */
  price: bigint;
  /** Unix seconds. */
  deadline: bigint;
  nonce: bigint;
}

export type { Address, Hex };
