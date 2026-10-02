import type { Address } from 'viem';
import { riskKernelAbi } from './abi/index';
import { getCollateral, getPositionsRaw } from './clearinghouse';
import { getGlobals, getMarkVol, getSpot, getUnderlyingParams, type GlobalParams, type UnderlyingParams } from './hub';
import { decodeRefusal } from './refusal';
import { getSeries, getSettlementPrice } from './registry';
import type { NovationContext, SeriesInfo, Session } from './types';
import { mulWad, sqrtWad, WAD } from './units';

export interface KParams {
  nowTs: bigint;
  rate: bigint;
  diversificationCredit: bigint;
  shortOptionMinPct: bigint;
}
export interface KUnderlying {
  spot: bigint;
  vol: bigint;
  shockRange: bigint;
  volUp: bigint;
  volDown: bigint;
  tokenQty: bigint;
}
export interface KPosition {
  u: bigint;
  isCall: boolean;
  expiry: bigint;
  strike: bigint;
  qty: bigint;
}
export interface KMarginOut {
  mtm: bigint;
  lossIM: bigint;
  lossCorr: bigint;
  lossIndep: bigint;
  shortMin: bigint;
  worstScenario: number;
}
export interface KernelInput {
  params: KParams;
  us: KUnderlying[];
  ps: KPosition[];
  /** The token behind each entry of `us`. */
  tokens: Address[];
  /** Expired positions the registry has settled: they leave the kernel (worth their payoff). */
  settled: { seriesId: number; qty: bigint }[];
}

export const PRICE_POINTS = 13;
export const VOL_POINTS = 3;
export const SCENARIOS = 39;
/** Vol index 1 (base vol), price index 6 (no move). */
export const BASE_SCENARIO = 19;
const MAX_SHOCK_RANGE = 9n * 10n ** 17n;

const k = (ctx: NovationContext) => ({ address: ctx.deployment.kernel, abi: riskKernelAbi }) as const;

/** The session's shock multiplier for an underlying (WAD). */
export function sessionMultiplier(p: UnderlyingParams, session: Session): bigint {
  switch (session) {
    case 'REGULAR':
      return WAD;
    case 'EXTENDED':
      return p.multExtended;
    case 'WEEKEND':
      return p.multWeekend;
    case 'HOLIDAY':
      return p.multHoliday;
    default:
      return p.multHalted;
  }
}

/**
 * MarginLogic's shock range, bit for bit:
 *   base = max(minShock, shockK * vol * sqrt(horizonDays / 365)); range = min(0.9, base * sessionMult)
 */
export function shockRange(p: UnderlyingParams, vol: bigint, session: Session): bigint {
  let base = mulWad(p.shockK, mulWad(vol, sqrtWad((p.horizonDays * WAD) / 365n)));
  if (base < p.minShock) base = p.minShock;
  const range = mulWad(base, sessionMultiplier(p, session));
  return range > MAX_SHOCK_RANGE ? MAX_SHOCK_RANGE : range;
}

export async function kernelMargin(ctx: NovationContext, input: Pick<KernelInput, 'params' | 'us' | 'ps'>): Promise<{ out: KMarginOut; perUnderlyingWorst: bigint[] }> {
  const [out, worst] = await ctx.client.readContract({ ...k(ctx), functionName: 'margin', args: [input.params, input.us, input.ps] });
  return {
    out: { mtm: out.mtm, lossIM: out.lossIM, lossCorr: out.lossCorr, lossIndep: out.lossIndep, shortMin: out.shortMin, worstScenario: Number(out.worstScenario) },
    perUnderlyingWorst: [...worst],
  };
}

export async function kernelScenarioGrid(ctx: NovationContext, input: Pick<KernelInput, 'params' | 'us' | 'ps'>): Promise<bigint[]> {
  return [...(await ctx.client.readContract({ ...k(ctx), functionName: 'scenarioGrid', args: [input.params, input.us, input.ps] }))];
}

/** The kernel's Black-Scholes: price, delta, gamma, vega, theta (WAD). `tau` in seconds. */
export async function bsQuote(
  ctx: NovationContext,
  a: { spot: bigint; strike: bigint; tau: bigint; vol: bigint; rate: bigint; isCall: boolean },
): Promise<{ price: bigint; delta: bigint; gamma: bigint; vega: bigint; theta: bigint }> {
  const [price, delta, gamma, vega, theta] = await ctx.client.readContract({
    ...k(ctx),
    functionName: 'bsQuote',
    args: [a.spot, a.strike, a.tau, a.vol, a.rate, a.isCall],
  });
  return { price, delta, gamma, vega, theta };
}

export interface BuildInputOptions {
  /** Use this session's shocks for every underlying instead of the hub's. */
  session?: Session;
  /** A hypothetical position change, as marginAfter applies it. */
  whatIf?: { seriesId: number; qtyDelta: bigint };
  /** Unix seconds for KParams.nowTs (default: the latest block). */
  now?: number;
  globals?: GlobalParams;
  seriesCache?: Map<number, SeriesInfo>;
}

/**
 * The kernel input the clearinghouse builds for an account (MarginLogic._input): collateral tokens
 * first, then option underlyings in first-seen order; settled expired positions left out;
 * collateral-only underlyings the hub can't price dropped. `session` swaps in another session's
 * shock multiplier, e.g. to price the weekend gap on a weekday.
 */
export async function buildKernelInput(ctx: NovationContext, account: bigint | number, opts: BuildInputOptions = {}): Promise<KernelInput> {
  const [g, raw, collateral, now] = await Promise.all([
    opts.globals ? Promise.resolve(opts.globals) : getGlobals(ctx),
    getPositionsRaw(ctx, account),
    getCollateral(ctx, account),
    opts.now !== undefined ? Promise.resolve(opts.now) : ctx.client.getBlock().then((b) => Number(b.timestamp)),
  ]);

  // the book, with the what-if applied (zero quantities dropped, a new series appended)
  const book: { seriesId: number; qty: bigint }[] = [];
  let applied = !opts.whatIf || opts.whatIf.qtyDelta === 0n;
  for (const p of raw) {
    let q = p.qty;
    if (!applied && p.seriesId === opts.whatIf!.seriesId) {
      q += opts.whatIf!.qtyDelta;
      applied = true;
    }
    if (q !== 0n) book.push({ seriesId: p.seriesId, qty: q });
  }
  if (!applied) book.push({ seriesId: opts.whatIf!.seriesId, qty: opts.whatIf!.qtyDelta });

  const cache = opts.seriesCache;
  const series = await Promise.all(
    book.map(async (b) => {
      const hit = cache?.get(b.seriesId);
      if (hit) return hit;
      const s = await getSeries(ctx, b.seriesId);
      cache?.set(b.seriesId, s);
      return s;
    }),
  );

  const tokens: Address[] = collateral.map((c) => c.token);
  const hasPosition = new Set<string>();
  const ps: { token: Address; s: SeriesInfo; qty: bigint }[] = [];
  const settled: KernelInput['settled'] = [];
  for (let i = 0; i < book.length; i++) {
    const s = series[i] as SeriesInfo;
    const qty = (book[i] as { qty: bigint }).qty;
    if (s.expiry <= now) {
      const { settled: done } = await getSettlementPrice(ctx, s.underlying, s.expiry);
      if (done) {
        settled.push({ seriesId: s.id, qty });
        continue;
      }
    }
    if (!tokens.some((t) => t.toLowerCase() === s.underlying.toLowerCase())) tokens.push(s.underlying);
    hasPosition.add(s.underlying.toLowerCase());
    ps.push({ token: s.underlying, s, qty });
  }

  const priced = await Promise.all(
    tokens.map(async (t) => {
      const mayDrop = !hasPosition.has(t.toLowerCase());
      let spot: bigint;
      let sess: Session;
      try {
        const r = await getSpot(ctx, t);
        spot = r.price;
        sess = r.session;
      } catch (e) {
        const code = decodeRefusal(e)?.code;
        if (mayDrop && (code === 'NoPrice' || code === 'ImplausiblePrice')) return undefined;
        throw e;
      }
      const [vol, p] = await Promise.all([getMarkVol(ctx, t), getUnderlyingParams(ctx, t)]);
      const tokenQty = collateral.find((c) => c.token.toLowerCase() === t.toLowerCase())?.amount ?? 0n;
      const u: KUnderlying = {
        spot,
        vol,
        shockRange: shockRange(p, vol, opts.session ?? sess),
        volUp: p.volUp,
        volDown: p.volDown,
        tokenQty,
      };
      return { token: t, u };
    }),
  );
  const kept = priced.filter((x): x is { token: Address; u: KUnderlying } => x !== undefined);
  const indexOf = (t: Address) => kept.findIndex((x) => x.token.toLowerCase() === t.toLowerCase());

  return {
    params: { nowTs: BigInt(now), rate: g.rate, diversificationCredit: g.diversificationCredit, shortOptionMinPct: g.shortOptionMinPct },
    us: kept.map((x) => x.u),
    ps: ps.map((x) => ({ u: BigInt(indexOf(x.token)), isCall: x.s.isCall, expiry: BigInt(x.s.expiry), strike: x.s.strike, qty: x.qty })),
    tokens: kept.map((x) => x.token),
    settled,
  };
}

/**
 * The account's 39-scenario grid and initial margin under `session`'s shocks (the hub's current
 * session when omitted), from the kernel itself. With `whatIf`, the book after that trade.
 */
export async function scenarioGridFor(
  ctx: NovationContext,
  account: bigint | number,
  opts: BuildInputOptions = {},
): Promise<{ cells: bigint[]; out: KMarginOut; shockRange: { token: Address; range: bigint }[]; input: KernelInput }> {
  const input = await buildKernelInput(ctx, account, opts);
  if (input.us.length === 0) {
    const zero: KMarginOut = { mtm: 0n, lossIM: 0n, lossCorr: 0n, lossIndep: 0n, shortMin: 0n, worstScenario: 0 };
    return { cells: Array.from({ length: SCENARIOS }, () => 0n), out: zero, shockRange: [], input };
  }
  const [cells, m] = await Promise.all([kernelScenarioGrid(ctx, input), kernelMargin(ctx, input)]);
  return { cells, out: m.out, shockRange: input.tokens.map((token, i) => ({ token, range: (input.us[i] as KUnderlying).shockRange })), input };
}
