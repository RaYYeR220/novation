/**
 * Takes one quote from a running relay and fills it on chain through RfqVenue, as a throwaway
 * taker (key keccak256(DEPLOYER_PRIVATE_KEY || "taker"), topped up with a little ETH):
 *
 *   pnpm --filter @novation/mm-bot start            # in one terminal
 *   pnpm --filter @novation/mm-bot fill --qty 1     # in another
 *
 * Options: --url (default http://127.0.0.1:8787), --series <id> (default: the NVDA call nearest
 * the money on the nearest expiry at least a day out), --side buy|sell (default buy), --qty (default 1),
 * --cash (USDG the taker keeps deposited, default 1000).
 */
import { parseArgs } from 'node:util';
import {
  fromWad,
  getPositionsRaw,
  getRfqDomain,
  getSpot,
  listSeries,
  simulateRfqFill,
  toWad,
  verifyQuote,
  type SeriesInfo,
} from '@novation/sdk';
import { fromJson, type QuoteJson } from '../src/handler';
import { chainFromEnv, deployerAnd, fundedAccount, log, sendWithHeadroom, topUpEth } from './lib';

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: { url: { type: 'string', default: 'http://127.0.0.1:8787' }, series: { type: 'string' }, side: { type: 'string', default: 'buy' }, qty: { type: 'string', default: '1' }, cash: { type: 'string', default: '1000' } },
  });
  const n = chainFromEnv();
  const ctx = n.ctx;
  const { deployer, derived: taker } = deployerAnd(n, 'taker');

  // the series
  let seriesId = values.series ? Number(values.series) : 0;
  if (!seriesId) {
    const NVDA = ctx.deployment.tokens.NVDA!;
    const now = Number((await n.client.getBlock()).timestamp);
    const spot = (await getSpot(ctx, NVDA)).price;
    const calls = (await listSeries(ctx, { underlying: NVDA, liveAt: now + 86400 })).filter((s) => s.isCall);
    if (calls.length === 0) throw new Error('no live NVDA calls');
    const expiry = Math.min(...calls.map((s) => s.expiry));
    const dist = (s: SeriesInfo) => (s.strike > spot ? s.strike - spot : spot - s.strike);
    seriesId = calls.filter((s) => s.expiry === expiry).sort((a, b) => (dist(a) < dist(b) ? -1 : 1))[0]!.id;
  }

  // the taker first (a little ETH, cash for the premium or the margin of a sale), so the quote
  // is fresh when it is filled
  await topUpEth(n, deployer, taker.account.address, { min: '0.00005', target: '0.0002', cap: '0.0002' });
  const takerId = await fundedAccount(n, taker, toWad(values.cash!));

  // the quote
  const url = `${values.url!.replace(/\/$/, '')}/quotes?series=${seriesId}&side=${values.side}&qty=${values.qty}`;
  const res = await fetch(url);
  const body = (await res.json()) as { quotes: QuoteJson[]; refusals: { code: string; message: string }[] };
  if (res.status !== 200 || body.quotes.length === 0) throw new Error(`no quote: ${JSON.stringify(body.refusals ?? body)}`);
  const j = body.quotes[0]!;
  const { quote, signature } = fromJson(j);
  if (j.chainId !== ctx.deployment.chainId || j.venue.toLowerCase() !== ctx.deployment.rfq.toLowerCase()) throw new Error('the quote is for another chain or venue');
  if (!(await verifyQuote(quote, signature, getRfqDomain(ctx), n.client))) throw new Error('bad quote signature');
  log({ msg: 'quote', url, side: j.side, series: seriesId, price: j.display.price, qty: j.display.qty, premium: j.display.premium, vol: j.display.vol, mark: j.display.mark, spot: j.display.spot, session: j.display.session, expiresAt: j.expiresAt, hash: j.hash });

  // the fill
  const qty = toWad(values.qty!);
  const sim = await simulateRfqFill(ctx, taker.account, quote, signature, takerId, qty);
  const { hash, receipt } = await sendWithHeadroom(n, taker, sim.request);
  const held = (await getPositionsRaw(ctx, takerId)).find((p) => p.seriesId === seriesId)?.qty ?? 0n;
  const explorer = n.client.chain?.blockExplorers?.default.url;
  log({
    msg: 'filled',
    tx: hash,
    block: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    taker: taker.account.address,
    takerId,
    makerId: quote.makerId,
    series: seriesId,
    premium: fromWad(sim.result),
    takerPosition: fromWad(held),
    ...(explorer ? { link: `${explorer}/tx/${hash}` } : {}),
  });
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
