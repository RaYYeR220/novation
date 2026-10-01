import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { privateKeyToAccount } from 'viem/accounts';
import { hashQuote, rfqDomain, signQuote, toWad, verifyQuote, WAD, type RfqQuote } from '@novation/sdk';
import { createRfqHandler, fromJson, parseQty, type QuoteJson, type RfqEvent } from '../../src/handler';
import type { MakerInfo, QuoteResult, QuoteSource, QuoteRequest } from '../../src/maker';
import type { QuoteRefusal, Side } from '../../src/pricing';
import { serve } from '../../src/server';

/** anvil's account 5 (public test mnemonic): signs the stub's quotes. */
const signer = privateKeyToAccount('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba');
const VENUE = '0x56562573b74A6cD6ca96cfb794A63625A48edf08' as const;
const domain = rfqDomain(46630, VENUE);

class Stub implements QuoteSource {
  calls: { seriesId: number; sides: readonly Side[]; qty?: bigint }[] = [];
  refusals: Partial<Record<Side, QuoteRefusal>> = {};
  fail = false;

  async quoteSides(seriesId: number, sides: readonly Side[], qty?: bigint): Promise<QuoteResult[]> {
    this.calls.push({ seriesId, sides, qty });
    if (this.fail) throw new Error('rpc https://secret.example/key down');
    return Promise.all(sides.map((side) => this.make(seriesId, side, qty ?? WAD)));
  }

  async quote(req: QuoteRequest): Promise<QuoteResult> {
    return (await this.quoteSides(req.seriesId, [req.side], req.qty))[0] as QuoteResult;
  }

  async info(): Promise<MakerInfo> {
    return { chainId: 46630, venue: VENUE, maker: signer.address, makerId: 7n, ttl: 60, maxQtyPerQuote: 10n * WAD, maxInventoryPerSeries: 50n * WAD, defaultQty: WAD, outstanding: 0 };
  }

  private async make(seriesId: number, side: Side, qty: bigint): Promise<QuoteResult> {
    const refusal = this.refusals[side];
    if (refusal) return { ok: false, side, refusal };
    const quote: RfqQuote = {
      signer: signer.address,
      makerId: 7n,
      seriesId,
      makerSells: side === 'buy',
      maxQty: qty,
      price: side === 'buy' ? toWad('4.25') : toWad('3.75'),
      deadline: 1_790_000_060n,
      nonce: 2n ** 200n + 5n,
    };
    const signature = await signQuote(signer, quote, domain);
    return {
      ok: true,
      quote: { side, quote, signature, hash: hashQuote(quote, domain), premium: (quote.price * qty) / WAD, vol: toWad(0.55), mark: toWad(4), spot: toWad(200), session: 'REGULAR' },
    };
  }
}

const get = (h: (r: Request) => Promise<Response>, path: string) => h(new Request(`http://maker.test${path}`));
const post = (h: (r: Request) => Promise<Response>, path: string, body: unknown) =>
  h(new Request(`http://maker.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }));

describe('GET /quotes', () => {
  it('returns both sides, signed, with integers as strings', async () => {
    const stub = new Stub();
    const h = createRfqHandler({ maker: stub });
    const r = await get(h, '/quotes?series=12');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = (await r.json()) as { series: number; quotes: QuoteJson[]; refusals: unknown[] };
    expect(body.series).toBe(12);
    expect(body.refusals).toEqual([]);
    expect(body.quotes.map((q) => q.side)).toEqual(['buy', 'sell']);
    expect(stub.calls).toEqual([{ seriesId: 12, sides: ['buy', 'sell'], qty: undefined }]);
    const [ask, bid] = body.quotes as [QuoteJson, QuoteJson];
    expect(ask.quote).toMatchObject({ seriesId: 12, makerSells: true, makerId: '7', maxQty: WAD.toString(), price: toWad('4.25').toString() });
    expect(bid.quote.makerSells).toBe(false);
    expect(ask.chainId).toBe(46630);
    expect(ask.venue).toBe(VENUE);
    expect(ask.expiresAt).toBe(1_790_000_060);
    expect(ask.display).toMatchObject({ price: 4.25, qty: 1, vol: 0.55, session: 'REGULAR' });
    // the JSON survives the trip back into a quote the venue would accept
    const { quote, signature } = fromJson(ask);
    expect(quote.nonce).toBe(2n ** 200n + 5n);
    expect(await verifyQuote(quote, signature, domain)).toBe(true);
    expect(await verifyQuote({ ...quote, price: quote.price - 1n }, signature, domain)).toBe(false);
  });

  it('quotes one side at the requested size', async () => {
    const stub = new Stub();
    const r = await get(createRfqHandler({ maker: stub }), '/quotes?series=3&side=sell&qty=2.5');
    expect(r.status).toBe(200);
    expect(stub.calls).toEqual([{ seriesId: 3, sides: ['sell'], qty: toWad('2.5') }]);
    const body = (await r.json()) as { quotes: QuoteJson[] };
    expect(body.quotes).toHaveLength(1);
    expect(body.quotes[0]!.quote.maxQty).toBe(toWad('2.5').toString());
  });

  it('returns one side and the refusal of the other, and 422 when both are refused', async () => {
    const stub = new Stub();
    stub.refusals.sell = { code: 'NoBid', message: 'no bid' };
    const h = createRfqHandler({ maker: stub });
    const one = await get(h, '/quotes?series=3');
    expect(one.status).toBe(200);
    const b1 = (await one.json()) as { quotes: QuoteJson[]; refusals: { side: string; code: string }[] };
    expect(b1.quotes.map((q) => q.side)).toEqual(['buy']);
    expect(b1.refusals).toEqual([{ side: 'sell', code: 'NoBid', message: 'no bid' }]);

    stub.refusals.buy = { code: 'Halted', message: 'halted' };
    const none = await get(h, '/quotes?series=3');
    expect(none.status).toBe(422);
    const b2 = (await none.json()) as { quotes: QuoteJson[]; refusals: { code: string }[] };
    expect(b2.quotes).toEqual([]);
    expect(b2.refusals.map((x) => x.code)).toEqual(['Halted', 'NoBid']);
  });

  it('rejects malformed parameters without calling the maker', async () => {
    const stub = new Stub();
    const h = createRfqHandler({ maker: stub });
    for (const q of ['', '?series=0', '?series=abc', '?series=1.5', '?series=-2', '?series=1&side=long', '?series=1&qty=-1', '?series=1&qty=1e3', '?series=1&qty=0', '?series=99999999999']) {
      const r = await get(h, `/quotes${q}`);
      expect(r.status, q).toBe(400);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe('BadRequest');
    }
    expect(stub.calls).toEqual([]);
  });
});

describe('POST /quote-request', () => {
  it('returns one firm quote for the size', async () => {
    const stub = new Stub();
    const r = await post(createRfqHandler({ maker: stub }), '/quote-request', { series: 5, side: 'buy', qty: '3' });
    expect(r.status).toBe(200);
    const q = (await r.json()) as QuoteJson;
    expect(q.side).toBe('buy');
    expect(q.quote.maxQty).toBe((3n * WAD).toString());
    expect(q.premium).toBe(((toWad('4.25') * 3n * WAD) / WAD).toString());
    expect(stub.calls).toEqual([{ seriesId: 5, sides: ['buy'], qty: 3n * WAD }]);
  });

  it('accepts seriesId and a numeric qty', async () => {
    const stub = new Stub();
    const r = await post(createRfqHandler({ maker: stub }), '/quote-request', { seriesId: '5', side: 'sell', qty: 0.5 });
    expect(r.status).toBe(200);
    expect(stub.calls[0]).toEqual({ seriesId: 5, sides: ['sell'], qty: WAD / 2n });
  });

  it('returns the refusal with 422 and no signature', async () => {
    const stub = new Stub();
    stub.refusals.buy = { code: 'MakerMargin', message: 'below IM' };
    const r = await post(createRfqHandler({ maker: stub }), '/quote-request', { series: 5, side: 'buy', qty: '40' });
    expect(r.status).toBe(422);
    const body = await r.text();
    expect(JSON.parse(body)).toEqual({ error: { code: 'MakerMargin', message: 'below IM' } });
    expect(body).not.toContain('signature');
  });

  it('needs a JSON object with series, side and qty', async () => {
    const stub = new Stub();
    const h = createRfqHandler({ maker: stub });
    for (const b of ['not json', '[1,2]', { side: 'buy', qty: '1' }, { series: 5, qty: '1' }, { series: 5, side: 'buy' }, { series: 5, side: 'buy', qty: 'lots' }]) {
      const r = await post(h, '/quote-request', b);
      expect(r.status, JSON.stringify(b)).toBe(400);
    }
    expect((await post(h, '/quote-request', 'x'.repeat(5000))).status).toBe(413);
    expect(stub.calls).toEqual([]);
  });
});

describe('routing', () => {
  it('serves maker info at the root', async () => {
    const r = await get(createRfqHandler({ maker: new Stub() }), '/');
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, chainId: 46630, venue: VENUE, makerId: '7', ttl: 60, maxQtyPerQuote: (10n * WAD).toString() });
  });

  it('answers wrong methods with 405 and unknown paths with 404', async () => {
    const h = createRfqHandler({ maker: new Stub() });
    const r = await post(h, '/quotes?series=1', {});
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('GET');
    expect((await get(h, '/quote-request')).status).toBe(405);
    expect((await get(h, '/nope')).status).toBe(404);
  });

  it('mounts under a base path', async () => {
    const h = createRfqHandler({ maker: new Stub(), basePath: '/api/rfq/' });
    expect((await get(h, '/api/rfq/quotes?series=1&side=buy')).status).toBe(200);
    expect((await get(h, '/api/rfq')).status).toBe(200);
    expect((await get(h, '/quotes?series=1')).status).toBe(404);
    expect((await get(h, '/api/rfqx/quotes?series=1')).status).toBe(404);
  });

  it('sends CORS headers and answers preflight when asked to', async () => {
    const h = createRfqHandler({ maker: new Stub(), cors: '*' });
    const pre = await h(new Request('http://maker.test/quote-request', { method: 'OPTIONS' }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
    expect(pre.headers.get('access-control-allow-methods')).toContain('POST');
    expect((await get(createRfqHandler({ maker: new Stub() }), '/')).headers.get('access-control-allow-origin')).toBeNull();
  });

  it('turns a maker failure into a 500 that leaks nothing', async () => {
    const stub = new Stub();
    stub.fail = true;
    const events: RfqEvent[] = [];
    const r = await get(createRfqHandler({ maker: stub, onEvent: (e) => events.push(e) }), '/quotes?series=1');
    expect(r.status).toBe(500);
    const text = await r.text();
    expect(text).not.toContain('secret');
    expect(events[0]).toMatchObject({ method: 'GET', path: '/quotes', status: 500 });
  });

  it('reports each request with its quotes and refusals', async () => {
    const stub = new Stub();
    stub.refusals.sell = { code: 'NoBid', message: 'no bid' };
    const events: RfqEvent[] = [];
    await get(createRfqHandler({ maker: stub, onEvent: (e) => events.push(e) }), '/quotes?series=4');
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe(200);
    expect(events[0]!.quotes?.map((q) => q.side)).toEqual(['buy']);
    expect(events[0]!.refusals).toEqual([{ side: 'sell', code: 'NoBid' }]);
  });
});

describe('parseQty', () => {
  it('reads decimal contracts into WAD', () => {
    expect(parseQty('1')).toBe(WAD);
    expect(parseQty('0.01')).toBe(WAD / 100n);
    expect(parseQty(2.5)).toBe((5n * WAD) / 2n);
    expect(() => parseQty('1.0000000000000000001')).toThrow();
    expect(() => parseQty('0')).toThrow();
  });
});

describe('node:http server', () => {
  let server: Server;
  let base: string;
  const stub = new Stub();

  beforeAll(async () => {
    server = await serve(createRfqHandler({ maker: stub }), { port: 0 });
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('passes GET and POST through to the handler', async () => {
    const g = await fetch(`${base}/quotes?series=8&side=buy&qty=1`);
    expect(g.status).toBe(200);
    expect(((await g.json()) as { quotes: QuoteJson[] }).quotes[0]!.quote.seriesId).toBe(8);
    const p = await fetch(`${base}/quote-request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ series: 9, side: 'sell', qty: '2' }) });
    expect(p.status).toBe(200);
    expect(((await p.json()) as QuoteJson).quote).toMatchObject({ seriesId: 9, makerSells: false, maxQty: (2n * WAD).toString() });
    expect((await fetch(`${base}/missing`)).status).toBe(404);
  });
});
