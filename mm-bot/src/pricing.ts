/**
 * Quote pricing. Pure: every input comes in as data, nothing reads the chain.
 *
 * The shape follows the option vaults' quote (OptionVaultBase.quote), made two-sided:
 *
 *   vol     = the hub's mark vol (what the clearinghouse marks positions at)
 *   m       = |ln(K / S)|
 *   volMid  = vol * (1 + skewSlope * m)
 *   ask vol = volMid * (1 + inventorySlope * shortUse) + sessionVolAdd[session] + volSpread
 *   bid vol = volMid * (1 - inventorySlope * longUse)  - sessionVolAdd[session] - volSpread
 *   ask     = ceil(max(px(ask vol), mark) * (1 + priceSpread))
 *   bid     = floor(min(px(bid vol), mark) * (1 - priceSpread))
 *
 * shortUse / longUse is the maker's position in the series after the quote (and the quotes it
 * still has outstanding there) as a fraction of its inventory cap: the ask rises as the maker gets
 * shorter, the bid falls as it gets longer. The session add widens both sides while the stock
 * market is closed. The ask never goes below the mark and the bid never above it, so a fill never
 * hands the counterparty value against the clearinghouse's own mark.
 */
import { mulWadUp, type AccountState, type SeriesInfo, type Session } from '@novation/sdk';
import { bsPrice, lnWad } from './bs';

const WAD = 10n ** 18n;
/** Prices are rounded to whole micro-USDG (USDG has 6 decimals). */
export const PRICE_TICK = 10n ** 12n;

/** The taker's side: `buy` means the taker buys and the maker sells. */
export type Side = 'buy' | 'sell';
export const SIDES: readonly Side[] = ['buy', 'sell'];

export interface PricingConfig {
  /** Absolute vol added to the ask and taken off the bid (WAD, 0.05 = 5 vol points). */
  volSpread: bigint;
  /** Fraction added to the ask price and taken off the bid price (WAD). */
  priceSpread: bigint;
  /** Vol add per unit of |ln(K/S)|, as a fraction of vol (WAD). */
  skewSlope: bigint;
  /** Vol add (ask) or cut (bid) at full use of the inventory cap, as a fraction of vol (WAD). */
  inventorySlope: bigint;
  /** Absolute vol that widens each side, per session (WAD). HALTED never quotes. */
  sessionVolAdd: Record<Exclude<Session, 'HALTED'>, bigint>;
  /** Largest size one quote may carry (WAD contracts). */
  maxQtyPerQuote: bigint;
  /** Largest |position| the maker holds in one series, counting outstanding quotes (WAD contracts). */
  maxInventoryPerSeries: bigint;
  /** Size quoted when the request names none (WAD contracts). */
  defaultQty: bigint;
  /** No quotes on a series this close to expiry (seconds). */
  minTimeToExpiry: number;
  /** The bot's own bound on the feed's age (seconds), on top of the hub's per-session limit. */
  maxPriceAge?: number;
  /** After the fill the maker must keep equity >= IM * (1 + marginBuffer) (WAD). */
  marginBuffer: bigint;
  /** Lifetime of a firm quote (POST /quote-request), seconds. */
  ttl: number;
  /** Lifetime of an indicative quote (GET /quotes), seconds: shorter, so it holds inventory briefly. */
  indicativeTtl: number;
}

export const DEFAULT_PRICING: PricingConfig = {
  volSpread: 5n * 10n ** 16n,
  priceSpread: 10n ** 16n,
  skewSlope: 10n ** 17n,
  inventorySlope: 2n * 10n ** 17n,
  sessionVolAdd: { REGULAR: 0n, EXTENDED: 2n * 10n ** 16n, WEEKEND: 5n * 10n ** 16n, HOLIDAY: 5n * 10n ** 16n },
  maxQtyPerQuote: 10n * WAD,
  maxInventoryPerSeries: 50n * WAD,
  defaultQty: WAD,
  minTimeToExpiry: 15 * 60,
  marginBuffer: 2n * 10n ** 17n,
  ttl: 60,
  indicativeTtl: 15,
};

/** The longest quote lifetime the config accepts (seconds). */
export const MAX_TTL = 300;

/**
 * Throws unless every setting is in range: spreads, slopes, session adds and the margin buffer
 * non-negative and bounded, the price spread below 100%, sizes positive, the default size within
 * the per-quote cap, lifetimes between 1 s and MAX_TTL. Returns the config.
 */
export function validatePricing(c: PricingConfig): PricingConfig {
  const bad = (what: string): never => {
    throw new RangeError(`pricing config: ${what}`);
  };
  const within = (name: string, v: bigint, max: bigint) => {
    if (v < 0n || v > max) bad(`${name} must be between 0 and ${fmt(max)}, got ${fmt(v)}`);
  };
  within('volSpread', c.volSpread, 2n * WAD);
  if (c.priceSpread < 0n || c.priceSpread >= WAD / 2n) bad(`priceSpread must be at least 0 and below 0.5, got ${fmt(c.priceSpread)}`);
  within('skewSlope', c.skewSlope, 10n * WAD);
  within('inventorySlope', c.inventorySlope, 10n * WAD);
  for (const [k, v] of Object.entries(c.sessionVolAdd)) within(`sessionVolAdd.${k}`, v, 2n * WAD);
  within('marginBuffer', c.marginBuffer, 10n * WAD);
  if (c.maxQtyPerQuote <= 0n) bad('maxQtyPerQuote must be positive');
  if (c.maxInventoryPerSeries <= 0n) bad('maxInventoryPerSeries must be positive');
  if (c.defaultQty <= 0n || c.defaultQty > c.maxQtyPerQuote) bad('defaultQty must be positive and at most maxQtyPerQuote');
  const secs = (name: string, v: number, min: number, max: number) => {
    if (!Number.isInteger(v) || v < min || v > max) bad(`${name} must be a whole number of seconds from ${min} to ${max}, got ${v}`);
  };
  secs('ttl', c.ttl, 1, MAX_TTL);
  secs('indicativeTtl', c.indicativeTtl, 1, c.ttl);
  secs('minTimeToExpiry', c.minTimeToExpiry, 0, 30 * 86400);
  if (c.maxPriceAge !== undefined) secs('maxPriceAge', c.maxPriceAge, 1, 30 * 86400);
  return c;
}

/** What the pricer needs to know about the underlying, read at one block. */
export interface MarketView {
  /** Block timestamp, unix seconds. */
  now: number;
  /** WAD USD per raw token. */
  spot: bigint;
  session: Session;
  /** The hub's spot `ok` flag. */
  ok: boolean;
  /** The feed's latest round time. */
  feedUpdatedAt: number;
  /** The hub's staleness limit for the current base session (seconds). */
  maxStale: number;
  /** The hub's mark vol (WAD). */
  markVol: bigint;
  /** hub.volStale: markVol has fallen back to volCap (a printed round sat unfolded for volStaleness). */
  volStale: boolean;
  /** Annual rate (WAD, signed). */
  rate: bigint;
  /** The clearinghouse's minimum trade size (WAD contracts). */
  minTradeQty: bigint;
}

export type RefusalCode =
  | 'BadRequest'
  | 'UnknownSeries'
  | 'Halted'
  | 'StalePrice'
  | 'StaleVol'
  | 'Expired'
  | 'NearExpiry'
  | 'QtyTooSmall'
  | 'SizeCap'
  | 'InventoryCap'
  | 'NoBid'
  | 'MakerMargin'
  | 'MakerCash'
  | 'Unavailable'
  | 'Busy'
  | 'ClientLimit';

export interface QuoteRefusal {
  code: RefusalCode;
  message: string;
  /** Internal detail for the operator's logs; never sent to the client. */
  detail?: string;
}

export const refuse = (code: RefusalCode, message: string): QuoteRefusal => ({ code, message });

export interface PricedSide {
  side: Side;
  /** WAD USDG per contract. */
  price: bigint;
  /** WAD contracts. */
  qty: bigint;
  /** The vol the side was priced at, before the price spread (WAD). */
  vol: bigint;
  /** px(mark vol): the clearinghouse's mark for one contract (WAD). */
  mark: bigint;
}

/** Why the underlying can't be quoted right now, or null. */
export function checkMarket(m: MarketView, cfg: Pick<PricingConfig, 'maxPriceAge'>): QuoteRefusal | null {
  if (m.session === 'HALTED' || !m.ok) return refuse('Halted', 'The underlying is halted: no quotes until the hub reopens it.');
  const age = m.now - m.feedUpdatedAt;
  const limit = cfg.maxPriceAge === undefined ? m.maxStale : Math.min(m.maxStale, cfg.maxPriceAge);
  if (m.feedUpdatedAt > m.now || age > limit) return refuse('StalePrice', `The price is ${age}s old; the limit is ${limit}s.`);
  if (m.volStale) return refuse('StaleVol', 'The mark vol is stale.');
  if (m.markVol <= 0n) return refuse('StaleVol', 'The hub has no mark vol.');
  return null;
}

/** Why the series can't be quoted, or null. */
export function checkSeries(s: Pick<SeriesInfo, 'expiry'>, now: number, cfg: Pick<PricingConfig, 'minTimeToExpiry'>): QuoteRefusal | null {
  if (s.expiry <= now) return refuse('Expired', 'The series has expired.');
  if (s.expiry - now < cfg.minTimeToExpiry) return refuse('NearExpiry', `No quotes within ${cfg.minTimeToExpiry}s of expiry.`);
  return null;
}

/**
 * The maker's position in the series after this quote fills in full, counting the quotes it still
 * has outstanding on the same side. Signed WAD (negative: short).
 */
export function positionAfter(side: Side, qty: bigint, position: bigint, reserved: { buy: bigint; sell: bigint }): bigint {
  // the taker buying is the maker selling
  return side === 'buy' ? position - reserved.buy - qty : position + reserved.sell + qty;
}

/** Size and inventory checks for one side: null when `qty` fits. */
export function checkSize(
  side: Side,
  qty: bigint,
  position: bigint,
  reserved: { buy: bigint; sell: bigint },
  minTradeQty: bigint,
  cfg: Pick<PricingConfig, 'maxQtyPerQuote' | 'maxInventoryPerSeries'>,
): QuoteRefusal | null {
  if (qty <= 0n || qty < minTradeQty) return refuse('QtyTooSmall', `The size is below the minimum trade of ${fmt(minTradeQty)}.`);
  if (qty > cfg.maxQtyPerQuote) return refuse('SizeCap', `The size is above the per-quote cap of ${fmt(cfg.maxQtyPerQuote)}.`);
  const after = positionAfter(side, qty, position, reserved);
  const abs = after < 0n ? -after : after;
  const before = side === 'buy' ? position - reserved.buy : position + reserved.sell;
  const absBefore = before < 0n ? -before : before;
  // a quote that reduces exposure is always allowed; one that grows it must stay inside the cap
  if (abs > cfg.maxInventoryPerSeries && abs > absBefore) {
    return refuse('InventoryCap', `The maker would hold ${fmt(after)} contracts; the cap is ${fmt(cfg.maxInventoryPerSeries)}.`);
  }
  // the clearinghouse refuses a position left below the minimum trade (dust)
  if (after !== 0n && abs < minTradeQty) return refuse('QtyTooSmall', 'The fill would leave the maker a dust position.');
  return null;
}

/** |ln(K/S)| in WAD. */
export function moneyness(strike: bigint, spot: bigint): bigint {
  const l = lnWad((strike * WAD) / spot);
  return l < 0n ? -l : l;
}

const mulWad = (a: bigint, b: bigint) => (a * b) / WAD;
const nonNeg = (x: bigint) => (x < 0n ? 0n : x);
const ceilTo = (x: bigint, tick: bigint) => ((x + tick - 1n) / tick) * tick;
const floorTo = (x: bigint, tick: bigint) => (x / tick) * tick;

/**
 * Prices one side of a quote. Runs every check (market, series, size, inventory) first and returns
 * the refusal when one fails. The margin check needs the chain and runs after this, in the maker.
 */
export function priceSide(args: {
  market: MarketView;
  series: Pick<SeriesInfo, 'expiry' | 'strike' | 'isCall'>;
  side: Side;
  qty: bigint;
  /** The maker's signed position in the series (WAD). */
  position: bigint;
  /** WAD contracts on the maker's outstanding quotes in the series, by taker side. */
  reserved?: { buy: bigint; sell: bigint };
  cfg: PricingConfig;
}): { ok: true; quote: PricedSide } | { ok: false; refusal: QuoteRefusal } {
  const { market: m, series: s, side, qty, position, cfg } = args;
  const reserved = args.reserved ?? { buy: 0n, sell: 0n };
  const bad = checkMarket(m, cfg) ?? checkSeries(s, m.now, cfg) ?? checkSize(side, qty, position, reserved, m.minTradeQty, cfg);
  if (bad) return { ok: false, refusal: bad };
  const session = m.session as Exclude<Session, 'HALTED'>; // checkMarket refused HALTED

  const tau = BigInt(s.expiry - m.now);
  const vol = m.markVol;
  const mark = bsPrice(m.spot, s.strike, tau, vol, m.rate, s.isCall);
  const volMid = nonNeg(mulWad(vol, WAD + mulWad(cfg.skewSlope, moneyness(s.strike, m.spot))));
  const after = positionAfter(side, qty, position, reserved);
  const use = (x: bigint) => {
    if (cfg.maxInventoryPerSeries === 0n || x <= 0n) return 0n;
    const u = (x * WAD) / cfg.maxInventoryPerSeries;
    return u > WAD ? WAD : u;
  };
  const widen = cfg.sessionVolAdd[session] + cfg.volSpread;

  // the clamps to the mark run before and after the price spread, so even a config that skipped
  // validation can't ask below the mark or bid above it (or below zero)
  if (side === 'buy') {
    const sideVol = nonNeg(mulWad(volMid, WAD + mulWad(cfg.inventorySlope, use(-after))) + widen);
    let px = bsPrice(m.spot, s.strike, tau, sideVol, m.rate, s.isCall);
    if (px < mark) px = mark;
    let price = ceilTo(mulWadUp(px, nonNeg(WAD + cfg.priceSpread)), PRICE_TICK);
    const floor = ceilTo(mark, PRICE_TICK);
    if (price < floor) price = floor;
    if (price < PRICE_TICK) price = PRICE_TICK;
    return { ok: true, quote: { side, price, qty, vol: sideVol, mark } };
  }

  const cut = mulWad(volMid, mulWad(cfg.inventorySlope, use(after))) + widen;
  const sideVol = volMid > cut ? volMid - cut : 0n;
  let px = sideVol === 0n ? 0n : bsPrice(m.spot, s.strike, tau, sideVol, m.rate, s.isCall);
  if (px > mark) px = mark;
  let price = floorTo(mulWad(px, nonNeg(WAD - cfg.priceSpread)), PRICE_TICK);
  const cap = floorTo(mark, PRICE_TICK);
  if (price > cap) price = cap;
  if (price <= 0n) return { ok: false, refusal: refuse('NoBid', 'The option is worth less than a tick at the bid.') };
  return { ok: true, quote: { side, price, qty, vol: sideVol, mark } };
}

/** The maker's cash and position change when the taker fills `qty` at `premium` (WAD). */
export function makerDelta(side: Side, qty: bigint, premium: bigint): { qtyDelta: bigint; cashDelta: bigint } {
  return side === 'buy' ? { qtyDelta: -qty, cashDelta: premium } : { qtyDelta: qty, cashDelta: -premium };
}

/**
 * Null when the maker's post-fill state keeps equity >= (IM + extraIm) * (1 + buffer); else the
 * refusal. `extraIm` is the margin the maker's other live quotes could add if they fill too.
 */
export function checkMakerMargin(after: Pick<AccountState, 'equity' | 'im'>, buffer: bigint, extraIm = 0n): QuoteRefusal | null {
  const base = after.im + (extraIm > 0n ? extraIm : 0n);
  const need = base + (base * (buffer > 0n ? buffer : 0n) + WAD - 1n) / WAD;
  if (after.equity >= need) return null;
  return refuse('MakerMargin', `The fill would leave the maker with ${fmt(after.equity)} equity against ${fmt(need)} required.`);
}

/** WAD into a short decimal string. */
export function fmt(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const i = a / WAD;
  const f = (a % WAD).toString().padStart(18, '0').replace(/0+$/, '').slice(0, 6);
  return `${neg ? '-' : ''}${i}${f ? `.${f}` : ''}`;
}
