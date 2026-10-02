/**
 * The maker against a local chain: the SDK's anvil fixture deploys the full stack with the repo's
 * forge scripts and KernelReference as the risk kernel. Skipped when anvil or forge is missing.
 *
 * Every actor is a key derived like the live ones (keccak256(base || label)), none of them an
 * account anvil unlocks: each transaction is signed locally, as it must be on a public RPC.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createWalletClient, http, maxUint256, type Address, type WalletClient } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import {
  bsQuote,
  fromWad,
  getAccountState,
  getMarginAfter,
  getPositionsRaw,
  getQuoteFills,
  getQuoteHashOnChain,
  getRfqDomain,
  getSpot,
  listSeries,
  randomNonce,
  RefusalError,
  rfqPremium,
  sendRequest,
  signQuote,
  simulateApprove,
  simulateCreateSubaccount,
  simulateDeposit,
  simulateMint,
  simulatePushRound,
  simulateRfqFill,
  verifyQuote,
  WAD,
  type RfqQuote,
  type SeriesInfo,
} from '@novation/sdk';
import { local, send, type Local } from '../../../sdk/test/anvil/helpers';
import { ANVIL_DEPLOYER_KEY } from '../../../sdk/test/anvil/setup';
import { bsPrice } from '../../src/bs';
import { createRfqHandler, fromJson, type QuoteJson } from '../../src/handler';
import { deriveKey } from '../../src/keys';
import { Maker } from '../../src/maker';

const l = local();
const d = describe.skipIf(!l);

const usdg = (n: number) => BigInt(n) * 10n ** 6n;

async function refusal(p: Promise<unknown>): Promise<RefusalError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RefusalError) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

d('RFQ maker on a local chain', () => {
  const L = l as Local;
  type Actor = { account: PrivateKeyAccount; wallet: WalletClient };
  const actor = (label: string): Actor => {
    const account = privateKeyToAccount(deriveKey(ANVIL_DEPLOYER_KEY, label));
    const url = (L.client.transport as { url?: string }).url;
    return { account, wallet: createWalletClient({ account, chain: L.client.chain, transport: http(url) }) };
  };
  let takerW: Actor;
  let makerW: Actor;
  let poorW: Actor;
  let USDG: Address;
  let NVDA: Address;
  let TSLA: Address;
  let takerId: bigint;
  let makerId: bigint;
  let poorId: bigint;
  let call: SeriesInfo;
  let maker: Maker;
  let handler: (r: Request) => Promise<Response>;

  async function account(w: Actor, mint: number, deposit: number): Promise<bigint> {
    const me = w.account.address;
    await L.rpc('anvil_setBalance', [me, '0x56bc75e2d63100000']); // 100 ETH for gas
    await send(L, w.wallet, (await simulateMint(L.ctx, w.account, USDG, me, usdg(mint))).request);
    await send(L, w.wallet, (await simulateApprove(L.ctx, w.account, USDG, L.ctx.deployment.clearinghouse, maxUint256)).request);
    const created = await simulateCreateSubaccount(L.ctx, w.account);
    await send(L, w.wallet, created.request);
    await send(L, w.wallet, (await simulateDeposit(L.ctx, w.account, created.result, USDG, usdg(deposit))).request);
    return created.result;
  }

  const get = (h: (r: Request) => Promise<Response>, path: string) => h(new Request(`http://maker.local${path}`));
  const post = (h: (r: Request) => Promise<Response>, body: unknown) =>
    h(new Request('http://maker.local/quote-request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  const chainNow = async () => Number((await L.client.getBlock()).timestamp);

  beforeAll(async () => {
    USDG = L.ctx.deployment.tokens.USDG as Address;
    NVDA = L.ctx.deployment.tokens.NVDA as Address;
    TSLA = L.ctx.deployment.tokens.TSLA as Address;
    takerW = actor('taker');
    makerW = actor('maker');
    poorW = actor('poor maker');
    takerId = await account(takerW, 10_000, 5_000);
    makerId = await account(makerW, 50_000, 25_000);
    poorId = await account(poorW, 50, 50);

    // the NVDA call nearest the money, on the nearest expiry at least a day out
    const now = await chainNow();
    const spot = (await getSpot(L.ctx, NVDA)).price;
    const dist = (s: SeriesInfo) => (s.strike > spot ? s.strike - spot : spot - s.strike);
    const calls = (await listSeries(L.ctx, { underlying: NVDA, liveAt: now + 86400 })).filter((s) => s.isCall);
    const expiry = Math.min(...calls.map((s) => s.expiry));
    call = calls.filter((s) => s.expiry === expiry).sort((a, b) => (dist(a) < dist(b) ? -1 : 1))[0]!;

    maker = new Maker({ ctx: L.ctx, signer: makerW.account, makerId, marketCacheMs: 0 });
    await maker.assertAuthorized();
    handler = createRfqHandler({ maker, rateLimit: false });
  });

  it("prices with the kernel's own Black-Scholes, integer for integer", async () => {
    const vectors = [
      { spot: 190n * WAD, strike: 190n * WAD, tau: 7n * 86400n, vol: 5n * 10n ** 17n, rate: 0n, isCall: true },
      { spot: 190n * WAD, strike: 205n * WAD, tau: 3n * 86400n + 1234n, vol: 15n * 10n ** 17n, rate: 0n, isCall: true },
      { spot: 440n * WAD, strike: 400n * WAD, tau: 9n * 86400n, vol: 9n * 10n ** 17n, rate: 4n * 10n ** 16n, isCall: false },
      { spot: 665n * WAD, strike: 700n * WAD, tau: 3600n, vol: 18n * 10n ** 16n, rate: -(10n ** 16n), isCall: false },
      { spot: 255n * WAD, strike: 100n * WAD, tau: 30n * 86400n, vol: 2n * 10n ** 17n, rate: 0n, isCall: true },
    ];
    for (const v of vectors) {
      const k = await bsQuote(L.ctx, v);
      expect(bsPrice(v.spot, v.strike, v.tau, v.vol, v.rate, v.isCall)).toBe(k.price);
    }
  });

  it('serves a signed two-sided quote: the ask above the bid, both valid for the venue', async () => {
    const r = await get(handler, `/quotes?series=${call.id}&qty=1`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { quotes: QuoteJson[] };
    const [ask, bid] = body.quotes as [QuoteJson, QuoteJson];
    expect(ask.side).toBe('buy');
    expect(bid.side).toBe('sell');
    expect(BigInt(ask.quote.price)).toBeGreaterThan(BigInt(bid.quote.price));
    const domain = getRfqDomain(L.ctx);
    for (const j of [ask, bid]) {
      const { quote, signature } = fromJson(j);
      expect(quote.signer).toBe(makerW.account.address);
      expect(quote.makerId).toBe(makerId);
      // GET quotes are indicative: the short TTL (15 s by default) from when they were made (chain
      // time, or the wall clock when the chain is behind it)
      expect(j.firm).toBe(false);
      const madeBy = Math.max(await chainNow(), Math.floor(Date.now() / 1000));
      expect(Number(quote.deadline) - madeBy).toBeLessThanOrEqual(15);
      expect(Number(quote.deadline) - madeBy).toBeGreaterThan(5);
      expect(await verifyQuote(quote, signature, domain, L.client)).toBe(true);
      expect(await getQuoteHashOnChain(L.ctx, quote)).toBe(j.hash);
    }
  });

  it('fills a quote the bot signed through RfqVenue', async () => {
    const r = await post(handler, { series: call.id, side: 'buy', qty: '2' });
    expect(r.status).toBe(200);
    const j = (await r.json()) as QuoteJson;
    expect(j.firm).toBe(true);
    const { quote, signature } = fromJson(j);
    expect(Number(quote.deadline) - Math.max(await chainNow(), Math.floor(Date.now() / 1000))).toBeGreaterThan(50);
    const makerBefore = await getAccountState(L.ctx, makerId);

    const fill = await simulateRfqFill(L.ctx, takerW.account, quote, signature, takerId, 2n * WAD);
    expect(fill.result).toBe(rfqPremium(quote, 2n * WAD));
    expect(fill.result.toString()).toBe(j.premium);
    // the kernel's maths costs a little more or less gas from one block timestamp to the next: an
    // exact estimate can run a sub-call out of gas, so the fill goes out with headroom
    const gas = await L.client.estimateContractGas(fill.request as Parameters<typeof L.client.estimateContractGas>[0]);
    await sendRequest(takerW.wallet, L.client, L.ctx, { ...fill.request, gas: gas + gas / 4n } as Parameters<typeof sendRequest>[3]);

    const pos = async (id: bigint) => (await getPositionsRaw(L.ctx, id)).find((p) => p.seriesId === call.id)?.qty;
    expect(await pos(takerId)).toBe(2n * WAD);
    expect(await pos(makerId)).toBe(-2n * WAD);
    const makerAfter = await getAccountState(L.ctx, makerId);
    expect(makerAfter.cash - makerBefore.cash).toBe(fill.result);
    expect(makerAfter.equity).toBeGreaterThanOrEqual(BigInt(makerAfter.im));
    const fills = await getQuoteFills(L.ctx, { takerId });
    expect(fills.at(-1)?.args.quoteHash).toBe(j.hash);
  });

  it('counts the filled position and live quotes against the inventory cap', async () => {
    const tight = new Maker({ ctx: L.ctx, signer: makerW.account, makerId, marketCacheMs: 0, pricing: { maxInventoryPerSeries: 4n * WAD } });
    // the maker is short 2: one more contract fits, then a live quote for 1.5 holds the room
    const a = await tight.quote({ seriesId: call.id, side: 'buy', qty: (3n * WAD) / 2n });
    expect(a.ok).toBe(true);
    const b = await tight.quote({ seriesId: call.id, side: 'buy', qty: WAD });
    expect(b.ok ? 'quoted' : b.refusal.code).toBe('InventoryCap');
    // buying back from the maker reduces it: still quoted
    const c = await tight.quote({ seriesId: call.id, side: 'sell', qty: WAD });
    expect(c.ok).toBe(true);
  });

  it('refuses an expired quote on chain', async () => {
    const r = await post(handler, { series: call.id, side: 'buy', qty: '1' });
    expect(r.status).toBe(200);
    const { quote, signature } = fromJson((await r.json()) as QuoteJson);
    // good now
    await simulateRfqFill(L.ctx, takerW.account, quote, signature, takerId, WAD);
    await L.rpc('evm_increaseTime', [61]);
    await L.rpc('evm_mine');
    expect(BigInt(await chainNow())).toBeGreaterThan(quote.deadline);
    const e = await refusal(simulateRfqFill(L.ctx, takerW.account, quote, signature, takerId, WAD));
    expect(e.refusal.code).toBe('QuoteExpired');
  });

  it('never issues a quote that would push the maker below initial margin', async () => {
    const poor = new Maker({ ctx: L.ctx, signer: poorW.account, makerId: poorId, marketCacheMs: 0, pricing: { maxQtyPerQuote: 100n * WAD } });
    const h = createRfqHandler({ maker: poor, rateLimit: false });
    const r = await post(h, { series: call.id, side: 'buy', qty: '20' });
    expect(r.status).toBe(422);
    const text = await r.text();
    expect(JSON.parse(text).error.code).toBe('MakerMargin');
    expect(text).not.toContain('signature');
    expect((await poor.info()).outstanding).toBe(0);

    // the chain agrees: the same quote, signed by hand, is refused at fill for the maker's margin
    const ref = await maker.quote({ seriesId: call.id, side: 'buy', qty: WAD });
    if (!ref.ok) throw new Error(ref.refusal.code);
    const now = await chainNow();
    const q: RfqQuote = { ...ref.quote.quote, signer: poorW.account.address, makerId: poorId, maxQty: 20n * WAD, deadline: BigInt(now + 60), nonce: randomNonce() };
    const after = await getMarginAfter(L.ctx, poorId, call.id, -q.maxQty, rfqPremium(q, q.maxQty));
    expect(after.equity).toBeLessThan(BigInt(after.im));
    const sig = await signQuote(poorW.account, q, getRfqDomain(L.ctx));
    const e = await refusal(simulateRfqFill(L.ctx, takerW.account, q, sig, takerId, q.maxQty));
    expect(e.refusal.code).toBe('InsufficientMargin');
    expect(e.refusal.args.id).toBe(poorId);
  });

  it('will not bid more cash than the maker holds', async () => {
    const poor = new Maker({ ctx: L.ctx, signer: poorW.account, makerId: poorId, marketCacheMs: 0, pricing: { maxQtyPerQuote: 100n * WAD } });
    const r = await poor.quote({ seriesId: call.id, side: 'sell', qty: 50n * WAD });
    expect(r.ok ? 'quoted' : r.refusal.code).toBe('MakerCash');
  });

  it('stops quoting an underlying the hub halts', async () => {
    const tsla = (await listSeries(L.ctx, { underlying: TSLA, liveAt: (await chainNow()) + 86400 }))[0]!;
    expect((await maker.quote({ seriesId: tsla.id, side: 'buy', qty: WAD })).ok).toBe(true);
    // a round older than every staleness limit halts TSLA
    const old = BigInt((await chainNow()) - 400_000);
    const feed = L.ctx.deployment.feeds.TSLA as Address;
    await send(L, takerW.wallet, (await simulatePushRound(L.ctx, takerW.account, feed, 440n * 10n ** 8n, old)).request);
    const r = await maker.quote({ seriesId: tsla.id, side: 'buy', qty: WAD });
    expect(r.ok ? 'quoted' : r.refusal.code).toBe('Halted');
    const g = await get(handler, `/quotes?series=${tsla.id}`);
    expect(g.status).toBe(422);
  });

  it("prices a live quote's margin with the kernel: its standalone IM is what the account would need", async () => {
    const fresh = actor('fresh maker');
    const freshId = await account(fresh, 1_000, 1_000);
    const m = new Maker({ ctx: L.ctx, signer: fresh.account, makerId: freshId, marketCacheMs: 0 });
    const im = await m.standaloneIm(call.id, -WAD);
    const after = await getMarginAfter(L.ctx, freshId, call.id, -WAD, 0n);
    expect(im).toBeGreaterThan(0n);
    expect(Math.abs(fromWad(im) - fromWad(after.im)) / fromWad(after.im)).toBeLessThan(1e-3);
  });

  it('counts live quotes on other series in the margin check', async () => {
    // a second call on the same expiry, further out of the money than the first
    const now = await chainNow();
    const other = (await listSeries(L.ctx, { underlying: NVDA, liveAt: now + 86400 }))
      .filter((s) => s.isCall && s.expiry === call.expiry && s.strike > call.strike)
      .sort((a, b) => (a.strike < b.strike ? -1 : 1))[0]!;
    const probe = new Maker({ ctx: L.ctx, signer: makerW.account, makerId, marketCacheMs: 0 });
    const imX = await probe.standaloneIm(call.id, -WAD);
    const imY = await probe.standaloneIm(other.id, -WAD);
    expect(imY).toBeGreaterThan(0n);
    expect(imX * 2n).toBeGreaterThanOrEqual(imY);

    // enough for either quote on its own (buffer 1.2), not for both together
    const deposit = Math.ceil(fromWad((12n * imX) / 10n + (6n * imY) / 10n));
    const mid = actor('mid maker');
    const midId = await account(mid, deposit, deposit);
    const m = new Maker({ ctx: L.ctx, signer: mid.account, makerId: midId, marketCacheMs: 0 });
    const x = await m.quote({ seriesId: call.id, side: 'buy', qty: WAD }, { firm: true });
    expect(x.ok).toBe(true);
    const y = await m.quote({ seriesId: other.id, side: 'buy', qty: WAD }, { firm: true });
    expect(y.ok ? 'quoted' : y.refusal.code).toBe('MakerMargin');
    // without the live quote on the first series the second one fits
    const alone = new Maker({ ctx: L.ctx, signer: mid.account, makerId: midId, marketCacheMs: 0 });
    const y2 = await alone.quote({ seriesId: other.id, side: 'buy', qty: WAD }, { firm: true });
    expect(y2.ok).toBe(true);
  });

  it('caps the live quotes one client may hold', async () => {
    const m = new Maker({ ctx: L.ctx, signer: makerW.account, makerId, marketCacheMs: 0, maxOutstandingPerClient: 2 });
    const h = createRfqHandler({ maker: m, rateLimit: false });
    const ask = (ip: string) => h(new Request(`http://maker.local/quotes?series=${call.id}&side=buy`, { headers: { 'x-real-ip': ip } }));
    expect((await ask('203.0.113.10')).status).toBe(200);
    expect((await ask('203.0.113.10')).status).toBe(200);
    const third = await ask('203.0.113.10');
    expect(third.status).toBe(429);
    expect(((await third.json()) as { refusals: { code: string }[] }).refusals[0]!.code).toBe('ClientLimit');
    expect((await ask('203.0.113.11')).status).toBe(200);
  });

  it('refuses an unknown series', async () => {
    const r = await get(handler, '/quotes?series=99999&side=buy');
    expect(r.status).toBe(422);
    expect(((await r.json()) as { refusals: { code: string }[] }).refusals[0]!.code).toBe('UnknownSeries');
  });
});
