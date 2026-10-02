import { type Address } from 'viem';
import { aggregatorAbi, erc20Abi, marketDataHubAbi, mockStockTokenAbi, riskParamsAbi } from './abi/index';
import { symbolOf } from './addresses';
import { baseSession } from './calendar';
import { decodeRefusal } from './refusal';
import { sessionOf, type NovationContext, type Session } from './types';

export type HaltReason = 'answer' | 'stale' | 'paused' | 'oraclePaused' | 'implausible' | 'multiplier' | 'sequencer';

/** RiskParams.underlying(token). WAD unless noted. */
export interface UnderlyingParams {
  enabled: boolean;
  index: number;
  feed: Address;
  strikeStep: bigint;
  volFloor: bigint;
  volCap: bigint;
  lambda: bigint;
  shockK: bigint;
  minShock: bigint;
  /** Plain days. */
  horizonDays: bigint;
  volUp: bigint;
  volDown: bigint;
  multExtended: bigint;
  multWeekend: bigint;
  multHoliday: bigint;
  multHalted: bigint;
  maxOpenInterest: bigint;
  /** Seconds. */
  maxStaleRegular: number;
  maxStaleExtended: number;
  maxStaleClosed: number;
  volStaleness: number;
  /** Plausibility band, WAD USD per raw token. */
  minPrice: bigint;
  maxPrice: bigint;
}

/** RiskParams.globals(). WAD unless noted. */
export interface GlobalParams {
  mmRatio: bigint;
  diversificationCredit: bigint;
  shortOptionMinPct: bigint;
  feeRate: bigint;
  feeCapOfPremium: bigint;
  insuranceShare: bigint;
  startDiscount: bigint;
  maxDiscount: bigint;
  maxFractionPerBid: bigint;
  liquidationPenalty: bigint;
  /** Seconds. */
  auctionDuration: number;
  maxSettlementLag: number;
  haltWindow: number;
  /** Weeks. */
  maxWeeksOut: number;
  maxStrikeDeviation: bigint;
  /** WAD annual, signed. */
  rate: bigint;
  minTradeQty: bigint;
  dustEquity: bigint;
}

export interface VolState {
  r2: bigint;
  dt: bigint;
  lastRoundId: bigint;
  lastPrice: bigint;
  lastUpdatedAt: number;
  lastPokeTs: number;
}

/** One underlying as the hub sees it, with the reason it is halted (if it is). */
export interface MarketStatus {
  token: Address;
  symbol: string;
  name: string;
  index: number;
  params: UnderlyingParams;
  /** WAD; null when the feed has no usable answer (NoPrice) or it is outside the band (ImplausiblePrice). */
  spot: bigint | null;
  /** The feed's latest WAD answer, even when the hub refuses it. */
  feedPrice: bigint | null;
  session: Session;
  ok: boolean;
  markVol: bigint;
  vol: VolState;
  /** markVol is at volCap because a printed round has sat unfolded for volStaleness (hub.volStale). */
  volStale?: boolean;
  /** The vol has folded in the feed's latest round (hub.volCurrent); a liquidation needs it. */
  volCurrent?: boolean;
  feed: { address: Address; description: string; decimals: number; roundId: bigint; updatedAt: number; answer: bigint };
  /** ERC-8056 scaled UI amount: shares per raw token, WAD. */
  uiMultiplier: bigint;
  /** When the next multiplier takes effect (0: none scheduled). */
  multiplierEffectiveAt: number;
  paused: boolean;
  oraclePaused: boolean;
  haltReason?: HaltReason;
}

const p = (ctx: NovationContext) => ({ address: ctx.deployment.riskParams, abi: riskParamsAbi }) as const;
const h = (ctx: NovationContext) => ({ address: ctx.deployment.hub, abi: marketDataHubAbi }) as const;

export async function getGlobals(ctx: NovationContext): Promise<GlobalParams> {
  const g = await ctx.client.readContract({ ...p(ctx), functionName: 'globals' });
  return {
    mmRatio: g.mmRatio,
    diversificationCredit: g.diversificationCredit,
    shortOptionMinPct: g.shortOptionMinPct,
    feeRate: g.feeRate,
    feeCapOfPremium: g.feeCapOfPremium,
    insuranceShare: g.insuranceShare,
    startDiscount: g.startDiscount,
    maxDiscount: g.maxDiscount,
    maxFractionPerBid: g.maxFractionPerBid,
    liquidationPenalty: g.liquidationPenalty,
    auctionDuration: Number(g.auctionDuration),
    maxSettlementLag: Number(g.maxSettlementLag),
    haltWindow: Number(g.haltWindow),
    maxWeeksOut: Number(g.maxWeeksOut),
    maxStrikeDeviation: g.maxStrikeDeviation,
    rate: BigInt(g.rate),
    minTradeQty: g.minTradeQty,
    dustEquity: g.dustEquity,
  };
}

export async function getUnderlyingParams(ctx: NovationContext, token: Address): Promise<UnderlyingParams> {
  const u = await ctx.client.readContract({ ...p(ctx), functionName: 'underlying', args: [token] });
  return {
    enabled: u.enabled,
    index: Number(u.index),
    feed: u.feed,
    strikeStep: u.strikeStep,
    volFloor: BigInt(u.volFloor),
    volCap: BigInt(u.volCap),
    lambda: BigInt(u.lambda),
    shockK: BigInt(u.shockK),
    minShock: BigInt(u.minShock),
    horizonDays: BigInt(u.horizonDays),
    volUp: BigInt(u.volUp),
    volDown: BigInt(u.volDown),
    multExtended: BigInt(u.multExtended),
    multWeekend: BigInt(u.multWeekend),
    multHoliday: BigInt(u.multHoliday),
    multHalted: BigInt(u.multHalted),
    maxOpenInterest: u.maxOpenInterest,
    maxStaleRegular: Number(u.maxStaleRegular),
    maxStaleExtended: Number(u.maxStaleExtended),
    maxStaleClosed: Number(u.maxStaleClosed),
    volStaleness: Number(u.volStaleness),
    minPrice: u.minPrice,
    maxPrice: u.maxPrice,
  };
}

/** RiskParams' underlyings in index order (the order the allowedMask bits follow). */
export async function getUnderlyingTokens(ctx: NovationContext): Promise<Address[]> {
  const n = await ctx.client.readContract({ ...p(ctx), functionName: 'underlyingCount' });
  return Promise.all(
    Array.from({ length: Number(n) }, (_, i) => ctx.client.readContract({ ...p(ctx), functionName: 'underlyingAt', args: [i] })),
  );
}

export async function getOpeningPaused(ctx: NovationContext): Promise<boolean> {
  return ctx.client.readContract({ ...p(ctx), functionName: 'openingPaused' });
}

/** hub.spot: WAD price, session, ok. Throws RefusalError-shaped errors (NoPrice, ImplausiblePrice) as viem errors. */
export async function getSpot(ctx: NovationContext, token: Address): Promise<{ price: bigint; session: Session; ok: boolean }> {
  const [price, s, ok] = await ctx.client.readContract({ ...h(ctx), functionName: 'spot', args: [token] });
  return { price, session: sessionOf(s), ok };
}

export async function getSession(ctx: NovationContext, token: Address): Promise<Session> {
  return sessionOf(await ctx.client.readContract({ ...h(ctx), functionName: 'session', args: [token] }));
}

export async function getMarkVol(ctx: NovationContext, token: Address): Promise<bigint> {
  return ctx.client.readContract({ ...h(ctx), functionName: 'markVol', args: [token] });
}

/**
 * Whether markVol has fallen back to volCap because the estimate is stale: a round the feed printed
 * has sat unfolded for longer than volStaleness (true before initVol). Anyone lifts it with syncVol.
 */
export async function getVolStale(ctx: NovationContext, token: Address): Promise<boolean> {
  return ctx.client.readContract({ ...h(ctx), functionName: 'volStale', args: [token] });
}

/** Whether the vol estimate has folded in the feed's latest round (liquidations require it). */
export async function getVolCurrent(ctx: NovationContext, token: Address): Promise<boolean> {
  return ctx.client.readContract({ ...h(ctx), functionName: 'volCurrent', args: [token] });
}

export async function getVolState(ctx: NovationContext, token: Address): Promise<VolState> {
  const [r2, dt, lastRoundId, lastPrice, lastUpdatedAt, lastPokeTs] = await ctx.client.readContract({
    ...h(ctx),
    functionName: 'volState',
    args: [token],
  });
  return { r2, dt, lastRoundId: BigInt(lastRoundId), lastPrice, lastUpdatedAt: Number(lastUpdatedAt), lastPokeTs: Number(lastPokeTs) };
}

/** Reads a uint view the token may not implement; undefined if it reverts. */
async function maybe<T>(f: () => Promise<T>): Promise<T | undefined> {
  try {
    return await f();
  } catch {
    return undefined;
  }
}

/**
 * Everything the hub decides an underlying's session from, read in one go: the feed's latest
 * round, staleness, pauses, the plausibility band and the multiplier window, plus mark vol. The
 * halt reason follows MarketDataHub._evaluate's order of checks.
 */
export async function getMarket(ctx: NovationContext, token: Address, opts: { now?: number } = {}): Promise<MarketStatus> {
  const c = ctx.client;
  const params = await getUnderlyingParams(ctx, token);
  const tok = { address: token, abi: mockStockTokenAbi } as const;
  const feed = { address: params.feed, abi: aggregatorAbi } as const;
  const [session, spotR, markVol, vol, round, decimals, description, name, sym, ui, ea, paused, oraclePaused, globals, now, volStale, volCurrent] =
    await Promise.all([
      getSession(ctx, token),
      getSpot(ctx, token).then(
        (r) => r,
        (e: unknown) => ({ error: decodeRefusal(e)?.code ?? 'unreadable' }),
      ),
      maybe(() => getMarkVol(ctx, token)),
      getVolState(ctx, token),
      maybe(() => c.readContract({ ...feed, functionName: 'latestRoundData' })),
      maybe(() => c.readContract({ ...feed, functionName: 'decimals' })),
      maybe(() => c.readContract({ ...feed, functionName: 'description' })),
      maybe(() => c.readContract({ address: token, abi: erc20Abi, functionName: 'name' })),
      maybe(() => c.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' })),
      maybe(() => c.readContract({ ...tok, functionName: 'uiMultiplier' })),
      maybe(() => c.readContract({ ...tok, functionName: 'effectiveAt' })),
      maybe(() => c.readContract({ ...tok, functionName: 'paused' })),
      maybe(() => c.readContract({ ...tok, functionName: 'oraclePaused' })),
      getGlobals(ctx),
      opts.now !== undefined ? Promise.resolve(opts.now) : c.getBlock().then((b) => Number(b.timestamp)),
      maybe(() => getVolStale(ctx, token)),
      maybe(() => getVolCurrent(ctx, token)),
    ]);

  const dec = decimals ?? 8;
  const answer = round ? round[1] : 0n;
  const updatedAt = round ? Number(round[3]) : 0;
  const feedPrice = answer > 0n && dec <= 18 ? answer * 10n ** BigInt(18 - dec) : null;
  const spot = 'price' in spotR ? spotR.price : null;
  const symbol = symbolOf(ctx.deployment, token) ?? sym ?? token;

  let haltReason: HaltReason | undefined;
  if (session === 'HALTED') {
    const base = baseSession(now);
    const limit = base === 'REGULAR' ? params.maxStaleRegular : base === 'EXTENDED' ? params.maxStaleExtended : params.maxStaleClosed;
    const effectiveAt = Number(ea ?? 0n);
    if (feedPrice === null) haltReason = 'answer';
    else if (updatedAt > now || now - updatedAt > limit) haltReason = 'stale';
    else if (paused !== false) haltReason = 'paused';
    else if (oraclePaused !== false) haltReason = 'oraclePaused';
    else if (feedPrice < params.minPrice || feedPrice > params.maxPrice) haltReason = 'implausible';
    else if (ea === undefined || (effectiveAt !== 0 && now + globals.haltWindow >= effectiveAt && (effectiveAt >= now || now - effectiveAt <= 3600)))
      haltReason = 'multiplier';
    else haltReason = 'sequencer';
  }

  return {
    token,
    symbol,
    name: name ?? symbol,
    index: params.index,
    params,
    spot,
    feedPrice,
    session,
    ok: session !== 'HALTED',
    markVol: markVol ?? 0n,
    vol,
    ...(volStale !== undefined ? { volStale } : {}),
    ...(volCurrent !== undefined ? { volCurrent } : {}),
    feed: {
      address: params.feed,
      description: description ?? '',
      decimals: dec,
      roundId: round ? BigInt(round[0]) : 0n,
      updatedAt,
      answer,
    },
    uiMultiplier: ui ?? 10n ** 18n,
    multiplierEffectiveAt: Number(ea ?? 0n),
    paused: paused ?? false,
    oraclePaused: oraclePaused ?? false,
    ...(haltReason ? { haltReason } : {}),
  };
}

/** getMarket for every underlying in RiskParams, in index order. */
export async function getMarkets(ctx: NovationContext, opts: { now?: number } = {}): Promise<MarketStatus[]> {
  const now = opts.now ?? Number((await ctx.client.getBlock()).timestamp);
  const tokens = await getUnderlyingTokens(ctx);
  return Promise.all(tokens.map((t) => getMarket(ctx, t, { now })));
}
