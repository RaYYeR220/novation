import type { Address } from 'viem';
import { auctionHouseAbi, clearinghouseAbi, insuranceFundAbi } from './abi/index';
import { addTradableSeconds } from './calendar';
import { getGlobals, type GlobalParams } from './hub';
import { getSeries } from './registry';
import type { AccountState, AgentPolicy, NovationContext, PositionInfo, SeriesInfo } from './types';
import { mulWad, mulWadUp } from './units';

const ch = (ctx: NovationContext) => ({ address: ctx.deployment.clearinghouse, abi: clearinghouseAbi }) as const;

type RawState = {
  cash: bigint;
  mtm: bigint;
  settledValue: bigint;
  deficit: bigint;
  equity: bigint;
  im: bigint;
  mm: bigint;
  worstScenario: bigint;
  healthy: boolean;
  liquidatable: boolean;
};

const state = (s: RawState): AccountState => ({ ...s, worstScenario: Number(s.worstScenario) });
const id = (v: bigint | number) => BigInt(v);

export async function getAccountState(ctx: NovationContext, account: bigint | number): Promise<AccountState> {
  return state(await ctx.client.readContract({ ...ch(ctx), functionName: 'accountState', args: [id(account)] }));
}

/**
 * The account as if `qtyDelta` (WAD, signed) were added to `seriesId` and `cashDelta` (WAD, signed)
 * to its cash: the clearinghouse's own margin procedure, run as an eth_call. Reverts
 * InsufficientCash when the cash would go negative.
 */
export async function getMarginAfter(
  ctx: NovationContext,
  account: bigint | number,
  seriesId: number,
  qtyDelta: bigint,
  cashDelta: bigint,
): Promise<AccountState> {
  return state(
    await ctx.client.readContract({ ...ch(ctx), functionName: 'marginAfter', args: [id(account), seriesId, qtyDelta, cashDelta] }),
  );
}

/** Correlated PnL of the account's live risk in the kernel's 39 scenarios (index = v * 13 + j), WAD. */
export async function getScenarioGrid(ctx: NovationContext, account: bigint | number): Promise<bigint[]> {
  return [...(await ctx.client.readContract({ ...ch(ctx), functionName: 'scenarioGrid', args: [id(account)] }))];
}

export async function getPositionsRaw(ctx: NovationContext, account: bigint | number): Promise<{ seriesId: number; qty: bigint }[]> {
  const ps = await ctx.client.readContract({ ...ch(ctx), functionName: 'positionsOf', args: [id(account)] });
  return ps.map((p) => ({ seriesId: Number(p.seriesId), qty: BigInt(p.qty) }));
}

/** Positions joined with their series. `cache` (series id -> series) avoids re-reading the registry. */
export async function getPositions(
  ctx: NovationContext,
  account: bigint | number,
  cache?: Map<number, SeriesInfo>,
): Promise<PositionInfo[]> {
  const raw = await getPositionsRaw(ctx, account);
  return Promise.all(
    raw.map(async (p) => {
      let s = cache?.get(p.seriesId);
      if (!s) {
        s = await getSeries(ctx, p.seriesId);
        cache?.set(p.seriesId, s);
      }
      return { ...s, seriesId: p.seriesId, qty: p.qty };
    }),
  );
}

export async function getCash(ctx: NovationContext, account: bigint | number): Promise<bigint> {
  return ctx.client.readContract({ ...ch(ctx), functionName: 'cashOf', args: [id(account)] });
}

/** Collateral tokens with a balance, and the WAD amount of each. */
export async function getCollateral(ctx: NovationContext, account: bigint | number): Promise<{ token: Address; amount: bigint }[]> {
  const tokens = await ctx.client.readContract({ ...ch(ctx), functionName: 'collateralTokensOf', args: [id(account)] });
  const amounts = await Promise.all(
    tokens.map((t) => ctx.client.readContract({ ...ch(ctx), functionName: 'collateralOf', args: [id(account), t] })),
  );
  return tokens.map((token, i) => ({ token, amount: amounts[i] as bigint }));
}

export async function getOwnerOf(ctx: NovationContext, account: bigint | number): Promise<Address> {
  return ctx.client.readContract({ ...ch(ctx), functionName: 'ownerOf', args: [id(account)] });
}

/** The subaccounts `owner` created, oldest first. */
export async function getSubaccountsOf(ctx: NovationContext, owner: Address): Promise<bigint[]> {
  return [...(await ctx.client.readContract({ ...ch(ctx), functionName: 'subaccountsOf', args: [owner] }))];
}

export async function getAgentPolicy(ctx: NovationContext, account: bigint | number, agent: Address): Promise<AgentPolicy> {
  const p = await ctx.client.readContract({ ...ch(ctx), functionName: 'agentPolicy', args: [id(account), agent] });
  return { maxWorstLoss: p.maxWorstLoss, maxPremiumPerTrade: p.maxPremiumPerTrade, allowedMask: BigInt(p.allowedMask), expiresAt: Number(p.expiresAt) };
}

export async function isAuthorized(ctx: NovationContext, account: bigint | number, actor: Address): Promise<boolean> {
  return ctx.client.readContract({ ...ch(ctx), functionName: 'isAuthorized', args: [id(account), actor] });
}

/** Unexpired positions, and expired ones whose expiry isn't settled in the registry yet. */
export async function getPositionStatus(ctx: NovationContext, account: bigint | number): Promise<{ live: bigint; awaiting: bigint }> {
  const [live, awaiting] = await ctx.client.readContract({ ...ch(ctx), functionName: 'positionStatus', args: [id(account)] });
  return { live, awaiting };
}

export async function getUnderlyingsOf(ctx: NovationContext, account: bigint | number): Promise<Address[]> {
  return [...(await ctx.client.readContract({ ...ch(ctx), functionName: 'underlyingsOf', args: [id(account)] }))];
}

/** The expiry's settlement pool: WAD paid in, WAD pending, and short contracts not yet settled. */
export async function getPool(ctx: NovationContext, expiry: number): Promise<{ pool: bigint; pending: bigint; unsettledShortQty: bigint }> {
  const [pool, pending, unsettledShortQty] = await ctx.client.readContract({ ...ch(ctx), functionName: 'pool', args: [BigInt(expiry)] });
  return { pool, pending, unsettledShortQty };
}

export async function getClaimable(ctx: NovationContext, account: bigint | number, expiry: number): Promise<bigint> {
  return ctx.client.readContract({ ...ch(ctx), functionName: 'claimable', args: [id(account), BigInt(expiry)] });
}

export async function getClaimableTotal(ctx: NovationContext, account: bigint | number): Promise<bigint> {
  return ctx.client.readContract({ ...ch(ctx), functionName: 'claimableTotalOf', args: [id(account)] });
}

/** The account's total deficit, and the parts of the `expiry` deficit owed to the fund and the pool. */
export async function getDeficit(
  ctx: NovationContext,
  account: bigint | number,
  expiry = 0,
): Promise<{ total: bigint; bridged: bigint; pending: bigint }> {
  const [total, bridged, pending] = await ctx.client.readContract({ ...ch(ctx), functionName: 'deficitOf', args: [id(account), BigInt(expiry)] });
  return { total, bridged, pending };
}

export async function getDeficitExpiries(ctx: NovationContext, account: bigint | number): Promise<number[]> {
  return (await ctx.client.readContract({ ...ch(ctx), functionName: 'deficitExpiriesOf', args: [id(account)] })).map(Number);
}

export async function getSocializedDebt(ctx: NovationContext, account: bigint | number): Promise<bigint> {
  return ctx.client.readContract({ ...ch(ctx), functionName: 'socializedDebtOf', args: [id(account)] });
}

/**
 * How long a collateral token must stay marked without a usable price (and without a new feed round)
 * before socialization counts it as 0: seconds of market time (the 24/5 window, see tradableSeconds).
 */
export const PRICE_OUTAGE_WRITE_OFF = 72 * 3600;

/**
 * The clearinghouse's record of a collateral token without a usable price (Clearinghouse.priceOutageOf),
 * or null when it isn't marked. `writeOffAt` is when socializeRemainder may count the token as 0:
 * 72 hours of market time after `since` (closed hours don't count), provided its feed prints no new
 * round by then (a new round restarts the clock) and, for a feed that can't be read at all, someone
 * marks it at least once a day.
 */
export async function getPriceOutage(ctx: NovationContext, token: Address): Promise<{ since: number; round: bigint; writeOffAt: number } | null> {
  const [since, round] = await ctx.client.readContract({ ...ch(ctx), functionName: 'priceOutageOf', args: [token] });
  if (since === 0n) return null;
  return { since: Number(since), round, writeOffAt: addTradableSeconds(Number(since), PRICE_OUTAGE_WRITE_OFF) };
}

export async function getCashIndex(ctx: NovationContext): Promise<bigint> {
  return ctx.client.readContract({ ...ch(ctx), functionName: 'cashIndex' });
}

/** Long open interest of a series (equal to its short open interest), WAD contracts. */
export async function getOpenInterest(ctx: NovationContext, seriesId: number): Promise<bigint> {
  return ctx.client.readContract({ ...ch(ctx), functionName: 'openInterest', args: [seriesId] });
}

export async function isVenue(ctx: NovationContext, venue: Address): Promise<boolean> {
  return ctx.client.readContract({ ...ch(ctx), functionName: 'isVenue', args: [venue] });
}

/** Everything the app shows for one subaccount, in one round of reads. */
export interface AccountSnapshot {
  id: bigint;
  owner: Address;
  state: AccountState;
  positions: PositionInfo[];
  collateral: { token: Address; amount: bigint }[];
  claimableTotal: bigint;
  deficitExpiries: number[];
}

export async function getAccount(ctx: NovationContext, account: bigint | number, cache?: Map<number, SeriesInfo>): Promise<AccountSnapshot> {
  const [owner, st, positions, collateral, claimableTotal, deficitExpiries] = await Promise.all([
    getOwnerOf(ctx, account),
    getAccountState(ctx, account),
    getPositions(ctx, account, cache),
    getCollateral(ctx, account),
    getClaimableTotal(ctx, account),
    getDeficitExpiries(ctx, account),
  ]);
  return { id: id(account), owner, state: st, positions, collateral, claimableTotal, deficitExpiries };
}

// ---------------------------------------------------------------- insurance and auctions

export async function getInsurance(ctx: NovationContext): Promise<{ balance: bigint; outstanding: bigint }> {
  const f = { address: ctx.deployment.insurance, abi: insuranceFundAbi } as const;
  const [balance, outstanding] = await Promise.all([
    ctx.client.readContract({ ...f, functionName: 'balanceWad' }),
    ctx.client.readContract({ ...f, functionName: 'outstandingWad' }),
  ]);
  return { balance, outstanding };
}

/** The liquidation auction's current discount (WAD) and whether one is running for `account`. */
export async function getLiquidation(ctx: NovationContext, account: bigint | number): Promise<{ discount: bigint; active: boolean }> {
  const [discount, active] = await ctx.client.readContract({
    address: ctx.deployment.auctionHouse,
    abi: auctionHouseAbi,
    functionName: 'liquidationDiscount',
    args: [id(account)],
  });
  return { discount, active };
}

export async function getDeficitSale(ctx: NovationContext, account: bigint | number, expiry: number): Promise<{ discount: bigint; active: boolean }> {
  const [discount, active] = await ctx.client.readContract({
    address: ctx.deployment.auctionHouse,
    abi: auctionHouseAbi,
    functionName: 'deficitDiscount',
    args: [id(account), BigInt(expiry)],
  });
  return { discount, active };
}

// ---------------------------------------------------------------- trade arithmetic

/**
 * The fee TradeLogic charges the taker: min(ceil(feeRate * |qty| * spot), ceil(feeCapOfPremium * premium)).
 * All WAD; `spot` is the hub's spot at trade time.
 */
export function tradeFee(g: Pick<GlobalParams, 'feeRate' | 'feeCapOfPremium'>, absQty: bigint, spot: bigint, premium: bigint): bigint {
  const a = mulWadUp(g.feeRate, mulWad(absQty, spot));
  const b = mulWadUp(g.feeCapOfPremium, premium);
  return a < b ? a : b;
}

/**
 * The taker's cash change for a trade: a buy (qty > 0) pays premium + fee, a sale receives premium
 * and pays fee. Feed it to getMarginAfter as cashDelta.
 */
export function takerCashDelta(qty: bigint, premium: bigint, fee: bigint): bigint {
  return qty > 0n ? -(premium + fee) : premium - fee;
}

/**
 * The pre-sign what-if for a taker: the fee at today's spot and the account state after the trade,
 * both from the chain. Throws (InsufficientCash) like marginAfter when cash can't cover it.
 */
export async function whatIfTrade(
  ctx: NovationContext,
  args: { account: bigint | number; seriesId: number; qty: bigint; premium: bigint; spot: bigint; globals?: GlobalParams },
): Promise<{ fee: bigint; cashDelta: bigint; after: AccountState }> {
  const g = args.globals ?? (await getGlobals(ctx));
  const fee = tradeFee(g, args.qty < 0n ? -args.qty : args.qty, args.spot, args.premium);
  const cashDelta = takerCashDelta(args.qty, args.premium, fee);
  const after = await getMarginAfter(ctx, args.account, args.seriesId, args.qty, cashDelta);
  return { fee, cashDelta, after };
}
