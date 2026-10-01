/**
 * The RFQ relay as one web-standard handler: (Request) => Promise<Response>. It runs as is in a
 * Next.js route handler, any fetch-style runtime, or behind node:http (server.ts).
 *
 *   GET  {base}/                       maker info: chain, venue, maker, subaccount, caps
 *   GET  {base}/quotes?series=&side=&qty=
 *                                      signed quotes; both sides unless `side` is given
 *   POST {base}/quote-request          {"series": 12, "side": "buy", "qty": "2.5"} -> one firm quote
 *
 * `side` is the taker's: buy = the taker buys from the maker. `qty` is in contracts (decimal).
 * Every quote is EIP-712 signed for RfqVenue and expires `ttl` seconds after it is made.
 */
import { fromWad, toWad, type RfqQuote } from '@novation/sdk';
import { Maker, type MakerConfig, type QuoteResult, type QuoteSource, type SignedQuote } from './maker';
import { SIDES, type QuoteRefusal, type Side } from './pricing';

export interface RfqHandlerConfig {
  /** A Maker (or any QuoteSource), or the config to build one. */
  maker: QuoteSource | MakerConfig;
  /** Where the handler is mounted, e.g. "/api/rfq". Requests outside it get 404. */
  basePath?: string;
  /** Access-Control-Allow-Origin to send (e.g. "*"); no CORS headers when omitted. */
  cors?: string;
  /** Called once per request, for logging. */
  onEvent?: (e: RfqEvent) => void;
}

export interface RfqEvent {
  method: string;
  path: string;
  status: number;
  ms: number;
  quotes?: { side: Side; hash: `0x${string}`; price: string; qty: string; deadline: string }[];
  refusals?: { side: Side; code: string }[];
  error?: string;
}

/** A signed quote as JSON: integers as decimal strings, plus floats for display. */
export interface QuoteJson {
  side: Side;
  quote: {
    signer: `0x${string}`;
    makerId: string;
    seriesId: number;
    makerSells: boolean;
    maxQty: string;
    price: string;
    deadline: string;
    nonce: string;
  };
  signature: `0x${string}`;
  hash: `0x${string}`;
  /** WAD USDG a fill of the whole maxQty costs (taker buys) or pays (taker sells). */
  premium: string;
  chainId: number;
  venue: `0x${string}`;
  expiresAt: number;
  display: { price: number; qty: number; premium: number; vol: number; mark: number; spot: number; session: string };
}

const MAX_QTY = 10n ** 9n * 10n ** 18n;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function isSource(m: QuoteSource | MakerConfig): m is QuoteSource {
  return typeof (m as QuoteSource).quoteSides === 'function';
}

/** Builds the relay handler. See the module comment for the routes. */
export function createRfqHandler(config: RfqHandlerConfig): (req: Request) => Promise<Response> {
  const maker: QuoteSource = isSource(config.maker) ? config.maker : new Maker(config.maker);
  const base = (config.basePath ?? '').replace(/\/+$/, '');
  let chain: { chainId: number; venue: `0x${string}` } | undefined;
  const chainInfo = async (): Promise<{ chainId: number; venue: `0x${string}` }> => {
    if (!chain) {
      const i = await maker.info();
      chain = { chainId: i.chainId, venue: i.venue };
    }
    return chain;
  };

  const headers = (extra: Record<string, string> = {}): Headers => {
    const h = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
    if (config.cors) {
      h.set('access-control-allow-origin', config.cors);
      h.set('access-control-allow-methods', 'GET, POST, OPTIONS');
      h.set('access-control-allow-headers', 'content-type');
    }
    return h;
  };
  const json = (status: number, body: unknown, extra?: Record<string, string>) =>
    new Response(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)), { status, headers: headers(extra) });

  return async function handle(req: Request): Promise<Response> {
    const t0 = Date.now();
    const url = new URL(req.url);
    let path = url.pathname.replace(/\/+$/, '') || '/';
    const event: RfqEvent = { method: req.method, path, status: 0, ms: 0 };
    const done = (r: Response) => {
      event.status = r.status;
      event.ms = Date.now() - t0;
      config.onEvent?.(event);
      return r;
    };

    try {
      if (base) {
        if (path !== base && !path.startsWith(`${base}/`)) throw new HttpError(404, 'NotFound', `No route ${path}.`);
        path = path.slice(base.length) || '/';
      }
      if (req.method === 'OPTIONS') return done(new Response(null, { status: 204, headers: headers() }));

      if (path === '/' || path === '/health') {
        allow(req, ['GET']);
        const info = await maker.info();
        return done(json(200, { ok: true, ...info }));
      }

      if (path === '/quotes') {
        allow(req, ['GET']);
        const seriesId = parseSeries(url.searchParams.get('series'));
        const sideParam = url.searchParams.get('side');
        const sides = sideParam === null || sideParam === '' ? SIDES : [parseSide(sideParam)];
        const q = url.searchParams.get('qty');
        const qty = q === null || q === '' ? undefined : parseQty(q);
        const results = await maker.quoteSides(seriesId, sides, qty);
        const { chainId, venue } = await chainInfo();
        const quotes = results.filter(isOk).map((r) => toJson(r.quote, chainId, venue));
        const refusals = results.filter((r) => !r.ok).map((r) => ({ side: r.side, ...(r as { refusal: QuoteRefusal }).refusal }));
        record(event, quotes, refusals);
        return done(json(quotes.length > 0 ? 200 : 422, { series: seriesId, quotes, refusals }));
      }

      if (path === '/quote-request') {
        allow(req, ['POST']);
        const body = await readBody(req);
        const seriesId = parseSeries(body.series ?? body.seriesId);
        const side = parseSide(body.side);
        if (body.qty === undefined || body.qty === null || body.qty === '') throw new HttpError(400, 'BadRequest', 'qty is required.');
        const qty = parseQty(body.qty);
        const r = await maker.quote({ seriesId, side, qty });
        const { chainId, venue } = await chainInfo();
        if (!r.ok) {
          record(event, [], [{ side, ...r.refusal }]);
          return done(json(422, { error: r.refusal }));
        }
        const out = toJson(r.quote, chainId, venue);
        record(event, [out], []);
        return done(json(200, out));
      }

      throw new HttpError(404, 'NotFound', `No route ${path}.`);
    } catch (e) {
      if (e instanceof HttpError) {
        event.error = e.code;
        const extra = e.status === 405 ? { allow: e.message.replace(/^.*: /, '') } : undefined;
        return done(json(e.status, { error: { code: e.code, message: e.message } }, extra));
      }
      event.error = e instanceof Error ? e.message.split('\n')[0] : String(e);
      return done(json(500, { error: { code: 'Internal', message: 'The maker could not handle the request.' } }));
    }
  };
}

function allow(req: Request, methods: string[]) {
  if (!methods.includes(req.method)) throw new HttpError(405, 'MethodNotAllowed', `Allowed: ${methods.join(', ')}`);
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > 4096) throw new HttpError(413, 'BadRequest', 'The body is too large.');
  try {
    const v = JSON.parse(text) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* falls through */
  }
  throw new HttpError(400, 'BadRequest', 'The body must be a JSON object.');
}

function parseSeries(v: unknown): number {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  if (!/^[1-9]\d{0,9}$/.test(s) || Number(s) > 0xffffffff) throw new HttpError(400, 'BadRequest', 'series must be a positive integer id.');
  return Number(s);
}

function parseSide(v: unknown): Side {
  if (v === 'buy' || v === 'sell') return v;
  throw new HttpError(400, 'BadRequest', 'side must be "buy" or "sell" (the taker\'s side).');
}

/** Contracts as a decimal ("1", "2.5") into WAD. */
export function parseQty(v: unknown): bigint {
  const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' ? v.trim() : '';
  if (!/^\d{1,10}(\.\d{1,18})?$/.test(s)) throw new HttpError(400, 'BadRequest', 'qty must be a positive decimal number of contracts.');
  const w = toWad(s);
  if (w <= 0n || w > MAX_QTY) throw new HttpError(400, 'BadRequest', 'qty is out of range.');
  return w;
}

const isOk = (r: QuoteResult): r is { ok: true; quote: SignedQuote } => r.ok;

function record(e: RfqEvent, quotes: QuoteJson[], refusals: { side: Side; code: string }[]) {
  e.quotes = quotes.map((q) => ({ side: q.side, hash: q.hash, price: q.quote.price, qty: q.quote.maxQty, deadline: q.quote.deadline }));
  e.refusals = refusals.map((r) => ({ side: r.side, code: r.code }));
}

export function toJson(s: SignedQuote, chainId: number, venue: `0x${string}`): QuoteJson {
  const q = s.quote;
  return {
    side: s.side,
    quote: {
      signer: q.signer,
      makerId: q.makerId.toString(),
      seriesId: q.seriesId,
      makerSells: q.makerSells,
      maxQty: q.maxQty.toString(),
      price: q.price.toString(),
      deadline: q.deadline.toString(),
      nonce: q.nonce.toString(),
    },
    signature: s.signature,
    hash: s.hash,
    premium: s.premium.toString(),
    chainId,
    venue,
    expiresAt: Number(q.deadline),
    display: {
      price: fromWad(q.price),
      qty: fromWad(q.maxQty),
      premium: fromWad(s.premium),
      vol: fromWad(s.vol),
      mark: fromWad(s.mark),
      spot: fromWad(s.spot),
      session: s.session,
    },
  };
}

/** A QuoteJson back into the RfqVenue struct and signature, ready for simulateRfqFill. */
export function fromJson(j: Pick<QuoteJson, 'quote' | 'signature'>): { quote: RfqQuote; signature: `0x${string}` } {
  const q = j.quote;
  return {
    quote: {
      signer: q.signer,
      makerId: BigInt(q.makerId),
      seriesId: Number(q.seriesId),
      makerSells: Boolean(q.makerSells),
      maxQty: BigInt(q.maxQty),
      price: BigInt(q.price),
      deadline: BigInt(q.deadline),
      nonce: BigInt(q.nonce),
    },
    signature: j.signature,
  };
}
