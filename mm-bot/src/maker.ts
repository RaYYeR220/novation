/**
 * The maker: reads the market and its own book, prices a side, checks its own margin after the
 * fill with the clearinghouse's marginAfter (an eth_call of the real margin procedure), and only
 * then signs. A quote that would leave the maker below initial margin (plus a buffer) is refused
 * and never signed.
 *
 * Every live quote it has signed is held as a reservation until it expires: against the series'
 * inventory cap, and, for the margin check, as the standalone initial margin of the position it
 * would open. The sum of standalone margins bounds what any set of fills can add to the account's
 * requirement (the kernel's worst-case loss is a maximum over shared scenarios, so it is
 * subadditive), so the check holds even if every live quote fills.
 */
import type { Hex, LocalAccount } from 'viem';
import {
  aggregatorAbi,
  baseSession,
  decodeRefusal,
  getGlobals,
  getMarginAfter,
  getMarkVol,
  getOpeningPaused,
  getPositionsRaw,
  getQuoteFilled,
  getRfqDomain,
  getSeries,
  getSpot,
  getUnderlyingParams,
  getVolStale,
  isAuthorized,
  kernelMargin,
  quoteHash,
  randomNonce,
  rfqPremium,
  shockRange,
  signQuote,
  type GlobalParams,
  type NovationContext,
  type RfqQuote,
  type SeriesInfo,
  type Session,
  type UnderlyingParams,
} from '@novation/sdk';
import {
  checkMakerMargin,
  checkMarket,
  checkSeries,
  DEFAULT_PRICING,
  makerDelta,
  priceSide,
  refuse,
  validatePricing,
  type MarketView,
  type PricingConfig,
  type QuoteRefusal,
  type Side,
} from './pricing';

const ZERO = '0x0000000000000000000000000000000000000000';

export interface MakerConfig {
  ctx: NovationContext;
  /** Owner or authorised agent of `makerId`; signs every quote. */
  signer: LocalAccount;
  makerId: bigint;
  pricing?: Partial<PricingConfig>;
  /** Most live quotes at once, all clients together (default 100). */
  maxOutstanding?: number;
  /** Most live quotes one client may hold (default 6). */
  maxOutstandingPerClient?: number;
  /** Most requests waiting their turn; beyond it requests are refused as Busy (default 32). */
  maxQueue?: number;
  /** How long one market read is reused (ms). */
  marketCacheMs?: number;
  /** How long an unknown series id is remembered as unknown (ms, default 60 s). */
  unknownSeriesMs?: number;
  /** Wall clock in unix seconds (tests pin it). */
  clock?: () => number;
}

export interface SignedQuote {
  side: Side;
  /** Firm (POST, full TTL) or indicative (GET, short TTL). Both are signed and fillable. */
  firm: boolean;
  quote: RfqQuote;
  signature: Hex;
  /** RfqVenue.hashQuote(quote). */
  hash: Hex;
  /** What a fill of the whole maxQty costs or pays (WAD USDG, the venue's rounding). */
  premium: bigint;
  /** The vol the side was priced at and the clearinghouse's mark per contract (WAD). */
  vol: bigint;
  mark: bigint;
  spot: bigint;
  session: Session;
}

export type QuoteResult = { ok: true; quote: SignedQuote } | { ok: false; side: Side; refusal: QuoteRefusal };

export interface QuoteRequest {
  seriesId: number;
  side: Side;
  /** WAD contracts; the configured default when omitted. */
  qty?: bigint;
}

export interface QuoteOptions {
  /** Who asked (an IP or account): live quotes per client are capped. */
  client?: string;
  /** A firm quote lives `ttl`; an indicative one `indicativeTtl`. */
  firm?: boolean;
}

/** Anything that turns a request into signed quotes: the Maker, or a stub in tests. */
export interface QuoteSource {
  quote(req: QuoteRequest, opts?: QuoteOptions): Promise<QuoteResult>;
  quoteSides(seriesId: number, sides: readonly Side[], qty?: bigint, opts?: QuoteOptions): Promise<QuoteResult[]>;
  info(): Promise<MakerInfo>;
}

export interface MakerInfo {
  chainId: number;
  venue: `0x${string}`;
  maker: `0x${string}`;
  makerId: bigint;
  ttl: number;
  indicativeTtl: number;
  maxQtyPerQuote: bigint;
  maxInventoryPerSeries: bigint;
  defaultQty: bigint;
  maxOutstandingPerClient: number;
  outstanding: number;
}

/** A live quote as the exposure maths sees it. */
export interface LiveQuote {
  seriesId: number;
  side: Side;
  maxQty: bigint;
  /** WAD contracts not filled yet. */
  remaining: bigint;
  /** Standalone initial margin of the maker's position if all of maxQty fills (WAD). */
  im: bigint;
  /** Premium the maker pays if all of maxQty fills: non-zero only when the maker buys (WAD). */
  cashOut: bigint;
}

export interface Exposure {
  /** WAD contracts on live quotes in this series, by taker side (the inventory check). */
  reserved: { buy: bigint; sell: bigint };
  /** Live quotes on this series and side: folded exactly into the marginAfter call. */
  sameSide: bigint;
  /** Standalone IM of every other live quote, pro rata to what is left, rounded up. */
  otherIm: bigint;
  /** Premium the maker could pay on every other live quote, rounded up. */
  otherCash: bigint;
}

const proRata = (v: bigint, part: bigint, whole: bigint) => (whole === 0n || v === 0n ? 0n : (v * part + whole - 1n) / whole);

/** What the maker's live quotes add up to, seen from a new quote on (seriesId, side). Pure. */
export function exposure(live: readonly LiveQuote[], seriesId: number, side: Side): Exposure {
  const out: Exposure = { reserved: { buy: 0n, sell: 0n }, sameSide: 0n, otherIm: 0n, otherCash: 0n };
  for (const q of live) {
    if (q.remaining <= 0n) continue;
    if (q.seriesId === seriesId) out.reserved[q.side] += q.remaining;
    if (q.seriesId === seriesId && q.side === side) {
      out.sameSide += q.remaining;
      continue;
    }
    out.otherIm += proRata(q.im, q.remaining, q.maxQty);
    out.otherCash += proRata(q.cashOut, q.remaining, q.maxQty);
  }
  return out;
}

interface Reservation {
  seriesId: number;
  side: Side;
  quote: RfqQuote;
  hash: Hex;
  client?: string;
  im: bigint;
  cashOut: bigint;
}

interface MarketRead {
  at: number;
  view: MarketView;
}

const positiveInt = (name: string, v: number) => {
  if (!Number.isInteger(v) || v <= 0) throw new RangeError(`${name} must be a positive whole number, got ${v}`);
  return v;
};

export class Maker implements QuoteSource {
  readonly ctx: NovationContext;
  readonly signer: LocalAccount;
  readonly makerId: bigint;
  readonly pricing: PricingConfig;
  private readonly maxOutstanding: number;
  private readonly maxPerClient: number;
  private readonly maxQueue: number;
  private readonly cacheMs: number;
  private readonly unknownMs: number;
  private readonly clock: () => number;
  private readonly series = new Map<number, SeriesInfo>();
  private readonly unknown = new Map<number, number>();
  private readonly params = new Map<string, UnderlyingParams>();
  private readonly markets = new Map<string, MarketRead>();
  private globals?: { at: number; g: GlobalParams };
  private reservations: Reservation[] = [];
  /** Quotes are made one at a time, so two requests can't both spend the same room. */
  private queue: Promise<unknown> = Promise.resolve();
  private waiting = 0;

  constructor(cfg: MakerConfig) {
    this.ctx = cfg.ctx;
    this.signer = cfg.signer;
    this.makerId = cfg.makerId;
    this.pricing = validatePricing({
      ...DEFAULT_PRICING,
      ...cfg.pricing,
      sessionVolAdd: { ...DEFAULT_PRICING.sessionVolAdd, ...cfg.pricing?.sessionVolAdd },
    });
    this.maxOutstanding = positiveInt('maxOutstanding', cfg.maxOutstanding ?? 100);
    this.maxPerClient = positiveInt('maxOutstandingPerClient', cfg.maxOutstandingPerClient ?? 6);
    this.maxQueue = positiveInt('maxQueue', cfg.maxQueue ?? 32);
    this.cacheMs = cfg.marketCacheMs ?? 2_000;
    this.unknownMs = cfg.unknownSeriesMs ?? 60_000;
    this.clock = cfg.clock ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Throws unless the signer can act for the maker account. */
  async assertAuthorized(): Promise<void> {
    if (!(await isAuthorized(this.ctx, this.makerId, this.signer.address))) {
      throw new Error(`${this.signer.address} is neither the owner nor an agent of subaccount ${this.makerId}`);
    }
  }

  async info(): Promise<MakerInfo> {
    return {
      chainId: this.ctx.deployment.chainId,
      venue: this.ctx.deployment.rfq,
      maker: this.signer.address,
      makerId: this.makerId,
      ttl: this.pricing.ttl,
      indicativeTtl: this.pricing.indicativeTtl,
      maxQtyPerQuote: this.pricing.maxQtyPerQuote,
      maxInventoryPerSeries: this.pricing.maxInventoryPerSeries,
      defaultQty: this.pricing.defaultQty,
      maxOutstandingPerClient: this.maxPerClient,
      outstanding: this.reservations.length,
    };
  }

  quote(req: QuoteRequest, opts: QuoteOptions = {}): Promise<QuoteResult> {
    return this.quoteSides(req.seriesId, [req.side], req.qty, opts).then((r) => r[0] as QuoteResult);
  }

  /** One quote per side, priced off one read of the market and the maker's book. */
  quoteSides(seriesId: number, sides: readonly Side[], qty?: bigint, opts: QuoteOptions = {}): Promise<QuoteResult[]> {
    if (this.waiting >= this.maxQueue) {
      return Promise.resolve(sides.map((side) => ({ ok: false, side, refusal: refuse('Busy', 'The maker is busy; retry shortly.') })));
    }
    this.waiting++;
    const run = this.queue.then(() => this.make(seriesId, sides, qty, opts));
    this.queue = run.catch(() => undefined);
    return run.finally(() => {
      this.waiting--;
    });
  }

  private async make(seriesId: number, sides: readonly Side[], qty: bigint | undefined, opts: QuoteOptions): Promise<QuoteResult[]> {
    const size = qty ?? this.pricing.defaultQty;
    const all = (refusal: QuoteRefusal): QuoteResult[] => sides.map((side) => ({ ok: false, side, refusal }));

    let s: SeriesInfo | undefined;
    try {
      s = await this.seriesInfo(seriesId);
    } catch (e) {
      return all(unavailable('The series can\'t be read right now.', e));
    }
    if (!s) return all(refuse('UnknownSeries', `No series ${seriesId}.`));

    let market: MarketView;
    try {
      market = await this.market(s.underlying);
    } catch (e) {
      return all(unavailable('The market can\'t be read right now.', e));
    }
    const closed = checkMarket(market, this.pricing) ?? checkSeries(s, market.now, this.pricing);
    if (closed) return all(closed);

    let position: bigint;
    let live: LiveQuote[];
    try {
      [position, live] = await Promise.all([this.position(seriesId), this.live(market.now)]);
    } catch (e) {
      return all(unavailable('The maker\'s book can\'t be read right now.', e));
    }
    const out: QuoteResult[] = [];
    for (const side of sides) {
      const r = await this.one(s, market, side, size, position, live, opts);
      if (r.ok) {
        const q = r.quote.quote;
        const res = this.reservations.at(-1) as Reservation;
        live.push({ seriesId: s.id, side, maxQty: q.maxQty, remaining: q.maxQty, im: res.im, cashOut: res.cashOut });
      }
      out.push(r);
    }
    return out;
  }

  private async one(
    s: SeriesInfo,
    market: MarketView,
    side: Side,
    qty: bigint,
    position: bigint,
    live: LiveQuote[],
    opts: QuoteOptions,
  ): Promise<QuoteResult> {
    const fail = (refusal: QuoteRefusal): QuoteResult => ({ ok: false, side, refusal });
    if (this.reservations.length >= this.maxOutstanding) return fail(refuse('Busy', 'Too many quotes outstanding; retry shortly.'));
    if (opts.client !== undefined && this.reservations.filter((r) => r.client === opts.client).length >= this.maxPerClient) {
      return fail(refuse('ClientLimit', `At most ${this.maxPerClient} live quotes per client; let some expire first.`));
    }

    const ex = exposure(live, s.id, side);
    const priced = priceSide({ market, series: s, side, qty, position, reserved: ex.reserved, cfg: this.pricing });
    if (!priced.ok) return fail(priced.refusal);

    const makerSells = side === 'buy';
    const ttl = opts.firm ? this.pricing.ttl : this.pricing.indicativeTtl;
    const draft: RfqQuote = {
      signer: this.signer.address,
      makerId: this.makerId,
      seriesId: s.id,
      makerSells,
      maxQty: qty,
      price: priced.quote.price,
      deadline: BigInt(market.now + ttl),
      nonce: randomNonce(),
    };

    // The maker's margin if this quote fills along with every other live quote: the same series
    // and side folded into the position change exactly, the rest added as their standalone margin
    // and, where the maker pays, their premium taken off its cash.
    const premium = rfqPremium(draft, qty);
    const sameSidePremium = rfqPremium(draft, qty + ex.sameSide);
    const { qtyDelta, cashDelta } = makerDelta(side, qty + ex.sameSide, sameSidePremium);
    try {
      const after = await getMarginAfter(this.ctx, this.makerId, s.id, qtyDelta, cashDelta - ex.otherCash);
      const bad = checkMakerMargin(after, this.pricing.marginBuffer, ex.otherIm);
      if (bad) return fail(bad);
    } catch (e) {
      const r = decodeRefusal(e);
      if (r?.code === 'InsufficientCash') return fail(refuse('MakerCash', 'The maker does not hold the cash to pay this premium.'));
      return fail(unavailable('The margin check could not run.', e));
    }

    let im: bigint;
    try {
      im = await this.positionIm(s, market, makerDelta(side, qty, premium).qtyDelta);
    } catch (e) {
      return fail(unavailable('The margin check could not run.', e));
    }

    const signature = await signQuote(this.signer, draft, getRfqDomain(this.ctx));
    const hash = quoteHash(this.ctx, draft);
    this.reservations.push({ seriesId: s.id, side, quote: draft, hash, client: opts.client, im, cashOut: makerSells ? 0n : premium });
    return {
      ok: true,
      quote: { side, firm: Boolean(opts.firm), quote: draft, signature, hash, premium, vol: priced.quote.vol, mark: priced.quote.mark, spot: market.spot, session: market.session },
    };
  }

  /**
   * Initial margin of a position of `makerQty` contracts of the series held on its own, from the
   * risk kernel with the hub's mark vol and the current session's shock range.
   */
  async standaloneIm(seriesId: number, makerQty: bigint): Promise<bigint> {
    const s = await this.seriesInfo(seriesId);
    if (!s) throw new Error(`no series ${seriesId}`);
    return this.positionIm(s, await this.market(s.underlying), makerQty);
  }

  private async positionIm(s: SeriesInfo, market: MarketView, makerQty: bigint): Promise<bigint> {
    if (market.session === 'HALTED') throw new Error('halted');
    const [p, g] = await Promise.all([this.underlyingParams(s.underlying), this.globalParams()]);
    const { out } = await kernelMargin(this.ctx, {
      params: { nowTs: BigInt(market.now), rate: g.rate, diversificationCredit: g.diversificationCredit, shortOptionMinPct: g.shortOptionMinPct },
      us: [{ spot: market.spot, vol: market.markVol, shockRange: shockRange(p, market.markVol, market.session), volUp: p.volUp, volDown: p.volDown, tokenQty: 0n }],
      ps: [{ u: 0n, isCall: s.isCall, expiry: BigInt(s.expiry), strike: s.strike, qty: makerQty }],
    });
    return out.lossIM;
  }

  /** The maker's live quotes with what is left on each (expired ones dropped). */
  private async live(now: number): Promise<LiveQuote[]> {
    this.reservations = this.reservations.filter((r) => r.quote.deadline >= BigInt(now));
    const filled = await Promise.all(this.reservations.map((r) => getQuoteFilled(this.ctx, r.hash)));
    return this.reservations.map((r, i) => {
      const f = filled[i] as bigint;
      return { seriesId: r.seriesId, side: r.side, maxQty: r.quote.maxQty, remaining: f < r.quote.maxQty ? r.quote.maxQty - f : 0n, im: r.im, cashOut: r.cashOut };
    });
  }

  private async position(seriesId: number): Promise<bigint> {
    const ps = await getPositionsRaw(this.ctx, this.makerId);
    return ps.find((p) => p.seriesId === seriesId)?.qty ?? 0n;
  }

  /** The series, or undefined when no such id is listed. Unknown ids are remembered for a while. */
  private async seriesInfo(id: number): Promise<SeriesInfo | undefined> {
    const hit = this.series.get(id);
    if (hit) return hit;
    const until = this.unknown.get(id);
    if (until !== undefined) {
      if (Date.now() < until) return undefined;
      this.unknown.delete(id);
    }
    let s: SeriesInfo | undefined;
    try {
      s = await getSeries(this.ctx, id);
    } catch (e) {
      // the registry reverts on an id it never issued; anything else is a transport problem
      if (!decodeRefusal(e) && !/revert/i.test(e instanceof Error ? e.message : String(e))) throw e;
    }
    if (!s || s.underlying === ZERO) {
      if (this.unknown.size >= 10_000) this.unknown.delete(this.unknown.keys().next().value as number);
      this.unknown.set(id, Date.now() + this.unknownMs);
      return undefined;
    }
    this.series.set(id, s);
    return s;
  }

  private async underlyingParams(token: `0x${string}`): Promise<UnderlyingParams> {
    const key = token.toLowerCase();
    const hit = this.params.get(key);
    if (hit) return hit;
    const p = await getUnderlyingParams(this.ctx, token);
    this.params.set(key, p);
    return p;
  }

  private async globalParams(): Promise<GlobalParams> {
    const t = Date.now();
    if (this.globals && t - this.globals.at < 60_000) return this.globals.g;
    const g = await getGlobals(this.ctx);
    this.globals = { at: t, g };
    return g;
  }

  /** The underlying as the hub sees it at the latest block, reused for marketCacheMs. */
  async market(token: `0x${string}`): Promise<MarketView> {
    const key = token.toLowerCase();
    const hit = this.markets.get(key);
    if (hit && Date.now() - hit.at < this.cacheMs) return { ...hit.view, now: Math.max(hit.view.now, this.clock()) };

    const p = await this.underlyingParams(token);
    const [block, g, spot, markVol, volStale, round, openingPaused] = await Promise.all([
      this.ctx.client.getBlock(),
      this.globalParams(),
      getSpot(this.ctx, token).catch(() => undefined),
      getMarkVol(this.ctx, token),
      // the hub's own test: markVol is at volCap because a printed round has sat unfolded for
      // volStaleness (a silent weekend feed is not stale, a print not yet synced isn't either)
      getVolStale(this.ctx, token),
      this.ctx.client.readContract({ address: p.feed, abi: aggregatorAbi, functionName: 'latestRoundData' }),
      getOpeningPaused(this.ctx),
    ]);
    const chainNow = Number(block.timestamp);
    const base = baseSession(chainNow);
    const view: MarketView = {
      now: Math.max(chainNow, this.clock()),
      spot: spot?.price ?? 0n,
      session: spot?.session ?? 'HALTED',
      ok: Boolean(spot?.ok) && p.enabled && !openingPaused,
      feedUpdatedAt: Number(round[3]),
      maxStale: base === 'REGULAR' ? p.maxStaleRegular : base === 'EXTENDED' ? p.maxStaleExtended : p.maxStaleClosed,
      markVol,
      volStale,
      rate: g.rate,
      minTradeQty: g.minTradeQty,
    };
    this.markets.set(key, { at: Date.now(), view });
    return view;
  }
}

/** A generic refusal for the client; the cause goes in `detail`, for the operator's log only. */
function unavailable(message: string, e: unknown): QuoteRefusal {
  const m = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);
  return { code: 'Unavailable', message, detail: m.split('\n')[0] ?? 'error' };
}

