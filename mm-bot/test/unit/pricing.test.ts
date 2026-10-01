import { describe, expect, it } from 'vitest';
import { toWad, WAD } from '@novation/sdk';
import { bsPrice } from '../../src/bs';
import {
  checkMakerMargin,
  checkMarket,
  DEFAULT_PRICING,
  makerDelta,
  moneyness,
  positionAfter,
  PRICE_TICK,
  priceSide,
  type MarketView,
  type PricedSide,
  type PricingConfig,
  type Side,
} from '../../src/pricing';

const NOW = 1_790_000_000;
const market = (o: Partial<MarketView> = {}): MarketView => ({
  now: NOW,
  spot: toWad(200),
  session: 'REGULAR',
  ok: true,
  feedUpdatedAt: NOW - 120,
  maxStale: 93_600,
  markVol: toWad(0.5),
  volStale: false,
  rate: 0n,
  minTradeQty: toWad(0.01),
  ...o,
});
const call = (strike = 210, days = 7) => ({ expiry: NOW + days * 86400, strike: toWad(strike), isCall: true });
const cfg = (o: Partial<PricingConfig> = {}): PricingConfig => ({ ...DEFAULT_PRICING, ...o });

function price(o: { side: Side; m?: MarketView; s?: ReturnType<typeof call>; qty?: bigint; position?: bigint; reserved?: { buy: bigint; sell: bigint }; c?: PricingConfig }): PricedSide {
  const r = priceSide({ market: o.m ?? market(), series: o.s ?? call(), side: o.side, qty: o.qty ?? WAD, position: o.position ?? 0n, reserved: o.reserved, cfg: o.c ?? cfg() });
  if (!r.ok) throw new Error(`refused: ${r.refusal.code}`);
  return r.quote;
}

function refusal(o: Parameters<typeof price>[0]): string {
  const r = priceSide({ market: o.m ?? market(), series: o.s ?? call(), side: o.side, qty: o.qty ?? WAD, position: o.position ?? 0n, reserved: o.reserved, cfg: o.c ?? cfg() });
  if (r.ok) throw new Error('expected a refusal');
  return r.refusal.code;
}

describe('two-sided price', () => {
  it('asks above the mark and bids below it, on whole micro-USDG', () => {
    const ask = price({ side: 'buy' });
    const bid = price({ side: 'sell' });
    const mark = bsPrice(toWad(200), toWad(210), 7n * 86400n, toWad(0.5), 0n, true);
    expect(ask.mark).toBe(mark);
    expect(bid.mark).toBe(mark);
    expect(ask.price).toBeGreaterThan(mark);
    expect(bid.price).toBeLessThan(mark);
    expect(ask.price % PRICE_TICK).toBe(0n);
    expect(bid.price % PRICE_TICK).toBe(0n);
  });

  it('prices each side at mark vol with the skew, plus or minus the vol spread', () => {
    const c = cfg({ inventorySlope: 0n });
    const m = moneyness(toWad(210), toWad(200));
    const volMid = (toWad(0.5) * (WAD + (c.skewSlope * m) / WAD)) / WAD;
    expect(price({ side: 'buy', c }).vol).toBe(volMid + c.volSpread);
    expect(price({ side: 'sell', c }).vol).toBe(volMid - c.volSpread);
    // the quote's own size counts as inventory
    expect(price({ side: 'buy' }).vol).toBeGreaterThan(volMid + c.volSpread);
    // the ask is px(ask vol) marked up by the price spread, rounded up to the tick
    const px = bsPrice(toWad(200), toWad(210), 7n * 86400n, volMid + c.volSpread, 0n, true);
    const ask = price({ side: 'buy', c }).price;
    expect(ask).toBeGreaterThanOrEqual((px * (WAD + c.priceSpread)) / WAD);
    expect(ask - (px * (WAD + c.priceSpread)) / WAD).toBeLessThanOrEqual(PRICE_TICK);
  });

  it('puts more vol on strikes further from spot', () => {
    expect(price({ side: 'buy', s: call(240) }).vol).toBeGreaterThan(price({ side: 'buy', s: call(202) }).vol);
  });

  it('widens while the stock market is closed', () => {
    const width = (m: MarketView) => price({ side: 'buy', m }).price - price({ side: 'sell', m }).price;
    expect(width(market({ session: 'WEEKEND' }))).toBeGreaterThan(width(market({ session: 'EXTENDED' })));
    expect(width(market({ session: 'EXTENDED' }))).toBeGreaterThan(width(market()));
  });

  it('leans on inventory: a short maker asks more, a long maker bids less', () => {
    expect(price({ side: 'buy', position: -toWad(30) }).price).toBeGreaterThan(price({ side: 'buy' }).price);
    expect(price({ side: 'sell', position: toWad(30) }).price).toBeLessThan(price({ side: 'sell' }).price);
    // outstanding quotes count as inventory too
    expect(price({ side: 'buy', reserved: { buy: toWad(30), sell: 0n } }).price).toBe(price({ side: 'buy', position: -toWad(30) }).price);
  });

  it('never bids above the mark or asks below it, whatever the config', () => {
    const loose = cfg({ volSpread: 0n, priceSpread: 0n, skewSlope: 5n * WAD, inventorySlope: 0n });
    const ask = price({ side: 'buy', c: loose, s: call(260) });
    const bid = price({ side: 'sell', c: loose, s: call(260) });
    expect(bid.price).toBeLessThanOrEqual(bid.mark);
    expect(ask.price).toBeGreaterThanOrEqual(ask.mark);
  });

  it('has no bid for an option worth less than a tick, and asks at least a tick', () => {
    expect(refusal({ side: 'sell', s: call(1000, 1) })).toBe('NoBid');
    expect(price({ side: 'buy', s: call(1000, 1) }).price).toBe(PRICE_TICK);
  });
});

describe('refusals', () => {
  it('refuses a halted underlying', () => {
    expect(refusal({ side: 'buy', m: market({ session: 'HALTED', ok: false }) })).toBe('Halted');
    expect(refusal({ side: 'sell', m: market({ ok: false }) })).toBe('Halted');
  });

  it('refuses a stale price: past the hub limit, past its own limit, or from the future', () => {
    expect(refusal({ side: 'buy', m: market({ feedUpdatedAt: NOW - 93_601 }) })).toBe('StalePrice');
    expect(price({ side: 'buy', m: market({ feedUpdatedAt: NOW - 93_600 }) }).price).toBeGreaterThan(0n);
    expect(refusal({ side: 'buy', m: market({ feedUpdatedAt: NOW - 600 }), c: cfg({ maxPriceAge: 300 }) })).toBe('StalePrice');
    expect(refusal({ side: 'buy', m: market({ feedUpdatedAt: NOW + 5 }) })).toBe('StalePrice');
    expect(checkMarket(market({ feedUpdatedAt: NOW - 299 }), { maxPriceAge: 300 })).toBeNull();
  });

  it('refuses a stale or missing mark vol', () => {
    expect(refusal({ side: 'buy', m: market({ volStale: true }) })).toBe('StaleVol');
    expect(refusal({ side: 'buy', m: market({ markVol: 0n }) })).toBe('StaleVol');
  });

  it('refuses expired series and series close to expiry', () => {
    expect(refusal({ side: 'buy', s: { ...call(), expiry: NOW } })).toBe('Expired');
    expect(refusal({ side: 'buy', s: { ...call(), expiry: NOW + 600 } })).toBe('NearExpiry');
    expect(price({ side: 'buy', s: { ...call(), expiry: NOW + 900 } }).price).toBeGreaterThan(0n);
  });

  it('caps the size of one quote', () => {
    expect(refusal({ side: 'buy', qty: toWad(10.01) })).toBe('SizeCap');
    expect(price({ side: 'buy', qty: toWad(10) }).qty).toBe(toWad(10));
    expect(refusal({ side: 'buy', qty: toWad(0.001) })).toBe('QtyTooSmall');
    expect(refusal({ side: 'buy', qty: 0n })).toBe('QtyTooSmall');
  });

  it('caps the inventory per series, counting outstanding quotes, but always lets risk come off', () => {
    expect(refusal({ side: 'buy', position: -toWad(45), qty: toWad(6) })).toBe('InventoryCap');
    expect(price({ side: 'buy', position: -toWad(45), qty: toWad(5) }).qty).toBe(toWad(5));
    expect(refusal({ side: 'buy', position: -toWad(40), reserved: { buy: toWad(8), sell: 0n }, qty: toWad(3) })).toBe('InventoryCap');
    // same side for the bid: a long maker
    expect(refusal({ side: 'sell', position: toWad(48), qty: toWad(3) })).toBe('InventoryCap');
    // buying back from a maker short beyond the cap reduces it: allowed
    expect(price({ side: 'sell', position: -toWad(60), qty: toWad(5) }).qty).toBe(toWad(5));
  });

  it('refuses a fill that would leave the maker a dust position', () => {
    expect(refusal({ side: 'sell', position: -toWad(1), qty: toWad(0.995) })).toBe('QtyTooSmall');
    expect(price({ side: 'sell', position: -toWad(1), qty: toWad(1) }).qty).toBe(toWad(1));
  });
});

describe('maker side', () => {
  it('positions and cash move against the taker', () => {
    expect(positionAfter('buy', toWad(2), toWad(1), { buy: 0n, sell: 0n })).toBe(-toWad(1));
    expect(positionAfter('sell', toWad(2), toWad(1), { buy: 0n, sell: toWad(3) })).toBe(toWad(6));
    expect(makerDelta('buy', toWad(2), toWad(9))).toEqual({ qtyDelta: -toWad(2), cashDelta: toWad(9) });
    expect(makerDelta('sell', toWad(2), toWad(9))).toEqual({ qtyDelta: toWad(2), cashDelta: -toWad(9) });
  });

  it('keeps equity at or above IM plus the buffer', () => {
    const buffer = toWad(0.2);
    expect(checkMakerMargin({ equity: toWad(120), im: toWad(100) }, buffer)).toBeNull();
    expect(checkMakerMargin({ equity: toWad(119.99), im: toWad(100) }, buffer)?.code).toBe('MakerMargin');
    expect(checkMakerMargin({ equity: toWad(100), im: toWad(100) }, 0n)).toBeNull();
    expect(checkMakerMargin({ equity: -1n, im: 0n }, buffer)?.code).toBe('MakerMargin');
  });
});
