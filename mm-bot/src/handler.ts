/**
 * The RFQ relay as one web-standard handler: (Request) => Promise<Response>. It runs as is in a
 * Next.js route handler, any fetch-style runtime, or behind node:http (server.ts).
 *
 *   GET  {base}/                       maker info: chain, venue, maker, subaccount, caps
 *   GET  {base}/quotes?series=&side=&qty=
 *                                      indicative signed quotes (short TTL); both sides unless
 *                                      `side` is given
 *   POST {base}/quote-request          {"series": 12, "side": "buy", "qty": "2.5"} -> one firm quote
 *
 * `side` is the taker's: buy = the taker buys from the maker. `qty` is in contracts (decimal).
 * Every quote is EIP-712 signed for RfqVenue and fillable until its deadline. Each client (by IP)
 * gets a token bucket of requests and a cap on its live quotes.
 */
import { fromWad, toWad, type RfqQuote } from '@novation/sdk';
import { Maker, type MakerConfig, type QuoteResult, type QuoteSource, type SignedQuote } from './maker';
import { SIDES, type QuoteRefusal, type Side } from './pricing';

export interface RateLimit {
  /** Requests a client may make at once. */
  burst: number;
  /** Requests a client regains per minute. */
  perMinute: number;
}

export const DEFAULT_RATE_LIMIT: RateLimit = { burst: 10, perMinute: 30 };

export interface RfqHandlerConfig {
  /** A Maker (or any QuoteSource), or the config to build one. */
  maker: QuoteSource | MakerConfig;
  /** Where the handler is mounted, e.g. "/api/rfq". Requests outside it get 404. */
  basePath?: string;
  /** Access-Control-Allow-Origin to send (e.g. "*"); no CORS headers when omitted. */
  cors?: string;
  /** Per-client token bucket (default 10 at once, 30 a minute); false turns it off. */
  rateLimit?: RateLimit | false;
  /**
   * Who is asking, for the rate limit and the live-quote cap. Default: `x-real-ip`, else the
   * first `x-forwarded-for` entry, else "anonymous". The node:http server sets `x-real-ip` from
   * the socket; Vercel sets it at its edge. Behind another proxy, pass your own.
   */
  clientId?: (req: Request) => string;
  /** Called once per request, for logging. Carries internal detail the client never sees. */
  onEvent?: (e: RfqEvent) => void;
}

export interface RfqEvent {
  method: string;
  path: string;
  status: number;
  ms: number;
  client: string;
  quotes?: { side: Side; hash: `0x${string}`; price: string; qty: string; deadline: string; firm: boolean }[];
  refusals?: { side: Side; code: string; detail?: string }[];
  error?: string;
}

/** A signed quote as JSON: integers as decimal strings, plus floats for display. */
export interface QuoteJson {
  side: Side;
  /** Firm (POST) or indicative (GET, shorter-lived). Both are signed and fillable until expiresAt. */
  firm: boolean;
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
export const MAX_BODY_BYTES = 4096;
const MAX_TRACKED_CLIENTS = 10_000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

function isSource(m: QuoteSource | MakerConfig): m is QuoteSource {
  return typeof (m as QuoteSource).quoteSides === 'function';
}

/** The default client id: the platform's real IP header, else the first forwarded hop. */
export function defaultClientId(req: Request): string {
  const real = req.headers.get('x-real-ip')?.trim();
  if (real) return real;
  const fwd = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return fwd || 'anonymous';
}

/** Token buckets keyed by client, bounded in size. */
export class TokenBuckets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private readonly limit: RateLimit,
    private readonly now: () => number = Date.now,
  ) {
    if (!(limit.burst >= 1) || !(limit.perMinute > 0)) throw new RangeError('rate limit: burst must be at least 1 and perMinute positive');
  }

  /** Takes one token; returns 0 when allowed, else the seconds until the next token. */
  take(client: string): number {
    const t = this.now();
    let b = this.buckets.get(client);
    if (b) {
      b.tokens = Math.min(this.limit.burst, b.tokens + ((t - b.at) / 60_000) * this.limit.perMinute);
      b.at = t;
      this.buckets.delete(client); // re-insert: the map's order is least recently used first
    } else {
      if (this.buckets.size >= MAX_TRACKED_CLIENTS) this.buckets.delete(this.buckets.keys().next().value as string);
      b = { tokens: this.limit.burst, at: t };
    }
    this.buckets.set(client, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil(((1 - b.tokens) * 60) / this.limit.perMinute));
  }
}

/** Builds the relay handler. See the module comment for the routes. */
export function createRfqHandler(config: RfqHandlerConfig): (req: Request) => Promise<Response> {
  const maker: QuoteSource = isSource(config.maker) ? config.maker : new Maker(config.maker);
  const base = (config.basePath ?? '').replace(/\/+$/, '');
  const buckets = config.rateLimit === false ? undefined : new TokenBuckets(config.rateLimit ?? DEFAULT_RATE_LIMIT);
  const clientOf = config.clientId ?? defaultClientId;
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
    const client = clientOf(req);
    const event: RfqEvent = { method: req.method, path, status: 0, ms: 0, client };
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

      if (buckets) {
        const wait = buckets.take(client);
        if (wait > 0) throw new HttpError(429, 'RateLimited', 'Too many requests; slow down.', { 'retry-after': String(wait) });
      }

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
        const results = await maker.quoteSides(seriesId, sides, qty, { client, firm: false });
        const { chainId, venue } = await chainInfo();
        const quotes = results.filter(isOk).map((r) => toJson(r.quote, chainId, venue));
        const refusals = results.filter((r) => !r.ok).map((r) => ({ side: r.side, ...(r as { refusal: QuoteRefusal }).refusal }));
        record(event, quotes, refusals);
        const status = quotes.length > 0 ? 200 : statusFor(refusals);
        return done(json(status, { series: seriesId, quotes, refusals: refusals.map(publicRefusal) }, retryAfter(status)));
      }

      if (path === '/quote-request') {
        allow(req, ['POST']);
        const body = await readBody(req);
        const seriesId = parseSeries(body.series ?? body.seriesId);
        const side = parseSide(body.side);
        if (body.qty === undefined || body.qty === null || body.qty === '') throw new HttpError(400, 'BadRequest', 'qty is required.');
        const qty = parseQty(body.qty);
        const r = await maker.quote({ seriesId, side, qty }, { client, firm: true });
        const { chainId, venue } = await chainInfo();
        if (!r.ok) {
          record(event, [], [{ side, ...r.refusal }]);
          const status = statusFor([r.refusal]);
          return done(json(status, { error: { code: r.refusal.code, message: r.refusal.message } }, retryAfter(status)));
        }
        const out = toJson(r.quote, chainId, venue);
        record(event, [out], []);
        return done(json(200, out));
      }

      throw new HttpError(404, 'NotFound', `No route ${path}.`);
    } catch (e) {
      if (e instanceof HttpError) {
        event.error = e.code;
        return done(json(e.status, { error: { code: e.code, message: e.message } }, e.headers));
      }
      event.error = e instanceof Error ? e.message.split('\n')[0] : String(e);
      return done(json(500, { error: { code: 'Internal', message: 'The maker could not handle the request.' } }));
    }
  };
}

/** 503 when the maker is busy, 429 when the client hit its cap, else 422. */
function statusFor(refusals: { code: string }[]): number {
  if (refusals.length > 0 && refusals.every((r) => r.code === 'Busy' || r.code === 'Unavailable')) return 503;
  if (refusals.length > 0 && refusals.every((r) => r.code === 'ClientLimit')) return 429;
  return 422;
}

const retryAfter = (status: number) => (status === 503 || status === 429 ? { 'retry-after': '5' } : undefined);

const publicRefusal = (r: { side: Side; code: string; message: string }) => ({ side: r.side, code: r.code, message: r.message });

function allow(req: Request, methods: string[]) {
  if (!methods.includes(req.method)) throw new HttpError(405, 'MethodNotAllowed', `Allowed: ${methods.join(', ')}`, { allow: methods.join(', ') });
}

/** The body as a JSON object, read with a byte limit: never more than MAX_BODY_BYTES buffered. */
async function readBody(req: Request): Promise<Record<string, unknown>> {
  const tooLarge = () => new HttpError(413, 'BadRequest', `The body is larger than ${MAX_BODY_BYTES} bytes.`);
  const declared = Number(req.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw tooLarge();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  try {
    const v = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
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

function record(e: RfqEvent, quotes: QuoteJson[], refusals: { side: Side; code: string; detail?: string }[]) {
  e.quotes = quotes.map((q) => ({ side: q.side, hash: q.hash, price: q.quote.price, qty: q.quote.maxQty, deadline: q.quote.deadline, firm: q.firm }));
  e.refusals = refusals.map((r) => ({ side: r.side, code: r.code, ...(r.detail ? { detail: r.detail } : {}) }));
}

export function toJson(s: SignedQuote, chainId: number, venue: `0x${string}`): QuoteJson {
  const q = s.quote;
  return {
    side: s.side,
    firm: s.firm,
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
