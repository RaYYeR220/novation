/**
 * The maker: reads the market and its own book, prices a side, checks its own margin after the
 * fill with the clearinghouse's marginAfter (an eth_call of the real margin procedure), and only
 * then signs. A quote that would leave the maker below initial margin (plus a buffer) is refused
 * and never signed.
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
  getVolState,
  isAuthorized,
  quoteHash,
  randomNonce,
  rfqPremium,
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
  type MarketView,
  type PricingConfig,
  type QuoteRefusal,
  type Side,
} from './pricing';

export interface MakerConfig {
  ctx: NovationContext;
  /** Owner or authorised agent of `makerId`; signs every quote. */
  signer: LocalAccount;
  makerId: bigint;
  pricing?: Partial<PricingConfig>;
  /** Most quotes outstanding at once (each one holds inventory until it expires). */
  maxOutstanding?: number;
  /** How long one market read is reused (ms). */
  marketCacheMs?: number;
  /** Wall clock in unix seconds (tests pin it). */
  clock?: () => number;
}

export interface SignedQuote {
  side: Side;
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

/** Anything that turns a request into signed quotes: the Maker, or a stub in tests. */
export interface QuoteSource {
  quote(req: QuoteRequest): Promise<QuoteResult>;
  quoteSides(seriesId: number, sides: readonly Side[], qty?: bigint): Promise<QuoteResult[]>;
  info(): Promise<MakerInfo>;
}

export interface MakerInfo {
  chainId: number;
  venue: `0x${string}`;
  maker: `0x${string}`;
  makerId: bigint;
  ttl: number;
  maxQtyPerQuote: bigint;
  maxInventoryPerSeries: bigint;
  defaultQty: bigint;
  outstanding: number;
}

interface Reservation {
  seriesId: number;
  side: Side;
  quote: RfqQuote;
  hash: Hex;
}

interface MarketRead {
  at: number;
  view: MarketView;
}

export class Maker implements QuoteSource {
  readonly ctx: NovationContext;
  readonly signer: LocalAccount;
  readonly makerId: bigint;
  readonly pricing: PricingConfig;
  private readonly maxOutstanding: number;
  private readonly cacheMs: number;
  private readonly clock: () => number;
  private readonly series = new Map<number, SeriesInfo>();
  private readonly params = new Map<string, UnderlyingParams>();
  private readonly markets = new Map<string, MarketRead>();
  private globals?: { at: number; g: GlobalParams };
  private reservations: Reservation[] = [];
  /** Quotes are made one at a time, so two requests can't both spend the same inventory room. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(cfg: MakerConfig) {
    this.ctx = cfg.ctx;
    this.signer = cfg.signer;
    this.makerId = cfg.makerId;
    this.pricing = { ...DEFAULT_PRICING, ...cfg.pricing, sessionVolAdd: { ...DEFAULT_PRICING.sessionVolAdd, ...cfg.pricing?.sessionVolAdd } };
    this.maxOutstanding = cfg.maxOutstanding ?? 100;
    this.cacheMs = cfg.marketCacheMs ?? 2_000;
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
      maxQtyPerQuote: this.pricing.maxQtyPerQuote,
      maxInventoryPerSeries: this.pricing.maxInventoryPerSeries,
      defaultQty: this.pricing.defaultQty,
      outstanding: this.reservations.length,
    };
  }

  quote(req: QuoteRequest): Promise<QuoteResult> {
    return this.quoteSides(req.seriesId, [req.side], req.qty).then((r) => r[0] as QuoteResult);
  }

  /** One quote per side, priced off one read of the market and the maker's book. */
  quoteSides(seriesId: number, sides: readonly Side[], qty?: bigint): Promise<QuoteResult[]> {
    const run = this.queue.then(() => this.make(seriesId, sides, qty));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async make(seriesId: number, sides: readonly Side[], qty?: bigint): Promise<QuoteResult[]> {
    const size = qty ?? this.pricing.defaultQty;
    const all = (refusal: QuoteRefusal): QuoteResult[] => sides.map((side) => ({ ok: false, side, refusal }));

    let s: SeriesInfo;
    try {
      s = await this.seriesInfo(seriesId);
    } catch {
      return all(refuse('UnknownSeries', `No series ${seriesId}.`));
    }

    let market: MarketView;
    try {
      market = await this.market(s.underlying);
    } catch (e) {
      return all(refuse('Unavailable', `The market can't be read: ${short(e)}`));
    }
    const closed = checkMarket(market, this.pricing) ?? checkSeries(s, market.now, this.pricing);
    if (closed) return all(closed);

    const [position, reserved] = await Promise.all([this.position(seriesId), this.reserved(seriesId, market.now)]);
    const out: QuoteResult[] = [];
    for (const side of sides) out.push(await this.one(s, market, side, size, position, reserved));
    return out;
  }

  private async one(
    s: SeriesInfo,
    market: MarketView,
    side: Side,
    qty: bigint,
    position: bigint,
    reserved: { buy: bigint; sell: bigint },
  ): Promise<QuoteResult> {
    const fail = (refusal: QuoteRefusal): QuoteResult => ({ ok: false, side, refusal });
    if (this.reservations.length >= this.maxOutstanding) return fail(refuse('Unavailable', 'Too many quotes outstanding; retry shortly.'));

    const priced = priceSide({ market, series: s, side, qty, position, reserved, cfg: this.pricing });
    if (!priced.ok) return fail(priced.refusal);

    const makerSells = side === 'buy';
    const draft: RfqQuote = {
      signer: this.signer.address,
      makerId: this.makerId,
      seriesId: s.id,
      makerSells,
      maxQty: qty,
      price: priced.quote.price,
      deadline: BigInt(market.now + this.pricing.ttl),
      nonce: randomNonce(),
    };

    // the maker's own margin after this quote and its outstanding quotes on the same side fill
    const pending = reserved[side];
    const premium = rfqPremium(draft, qty);
    const pendingPremium = rfqPremium(draft, qty + pending);
    const { qtyDelta, cashDelta } = makerDelta(side, qty + pending, pendingPremium);
    try {
      const after = await getMarginAfter(this.ctx, this.makerId, s.id, qtyDelta, cashDelta);
      const bad = checkMakerMargin(after, this.pricing.marginBuffer);
      if (bad) return fail(bad);
    } catch (e) {
      const r = decodeRefusal(e);
      if (r?.code === 'InsufficientCash') return fail(refuse('MakerCash', 'The maker does not hold the cash to pay this premium.'));
      return fail(refuse('Unavailable', `The margin check failed: ${r ? r.code : short(e)}`));
    }

    const signature = await signQuote(this.signer, draft, getRfqDomain(this.ctx));
    const hash = quoteHash(this.ctx, draft);
    this.reservations.push({ seriesId: s.id, side, quote: draft, hash });
    return {
      ok: true,
      quote: {
        side,
        quote: draft,
        signature,
        hash,
        premium,
        vol: priced.quote.vol,
        mark: priced.quote.mark,
        spot: market.spot,
        session: market.session,
      },
    };
  }

  /** WAD contracts still fillable on this maker's live quotes in the series, by taker side. */
  private async reserved(seriesId: number, now: number): Promise<{ buy: bigint; sell: bigint }> {
    this.reservations = this.reservations.filter((r) => r.quote.deadline >= BigInt(now));
    const mine = this.reservations.filter((r) => r.seriesId === seriesId);
    const filled = await Promise.all(mine.map((r) => getQuoteFilled(this.ctx, r.hash)));
    const out = { buy: 0n, sell: 0n };
    mine.forEach((r, i) => {
      const f = filled[i] as bigint;
      if (f < r.quote.maxQty) out[r.side] += r.quote.maxQty - f;
    });
    return out;
  }

  private async position(seriesId: number): Promise<bigint> {
    const ps = await getPositionsRaw(this.ctx, this.makerId);
    return ps.find((p) => p.seriesId === seriesId)?.qty ?? 0n;
  }

  private async seriesInfo(id: number): Promise<SeriesInfo> {
    const hit = this.series.get(id);
    if (hit) return hit;
    const s = await getSeries(this.ctx, id);
    if (s.underlying === '0x0000000000000000000000000000000000000000') throw new Error('unknown series');
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
    const [block, g, spot, markVol, vol, round, openingPaused] = await Promise.all([
      this.ctx.client.getBlock(),
      this.globalParams(),
      getSpot(this.ctx, token).catch(() => undefined),
      getMarkVol(this.ctx, token),
      getVolState(this.ctx, token),
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
      volStale: chainNow - vol.lastPokeTs > p.volStaleness,
      rate: g.rate,
      minTradeQty: g.minTradeQty,
    };
    this.markets.set(key, { at: Date.now(), view });
    return view;
  }
}

function short(e: unknown): string {
  const m = e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e);
  return m.split('\n')[0] ?? 'error';
}
