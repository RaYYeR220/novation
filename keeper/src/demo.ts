/**
 * A small real book on one expiry, opened from the keeper's own subaccounts, so the expiry's
 * settlement has a payer and a receiver with a non-zero payoff (testnet demonstration):
 *  - the long subaccount buys `qty` of the nearest call the covered-call vault will sell (the
 *    vault writes only at least minOtm out of the money, inside its delta band);
 *  - the short subaccount sells the long one an at-the-money straddle (a call and a put at the
 *    strike nearest spot) through a signed RFQ quote at the kernel's Black-Scholes price. Whatever
 *    the close, one leg ends in the money (unless it lands exactly on the strike), so the short
 *    pays into the pool and the long claims.
 * Subaccounts: #1 is the bidder (liquidation job), #2 the long, #3 the short.
 */
import {
  bsQuote,
  findSeriesId,
  fromWad,
  getGlobals,
  getMarkVol,
  getSpot,
  getUnderlyingParams,
  getVault,
  getRfqDomain,
  randomNonce,
  RefusalError,
  signQuote,
  simulateListSeries,
  simulateRfqFill,
  simulateVaultBuy,
  tokenOf,
  WAD,
  type Address,
  type RfqQuote,
} from '@novation/sdk';
import { gridStrikes, toGrid } from './grid';
import { chainNow, execute, isTestChain, type Keeper, type TxRecord } from './keeper';
import { why } from './log';
import { ensureSubaccounts, fundSubaccount } from './setup';

const JOB = 'demo';

async function ensureSeries(k: Keeper, u: Address, expiry: number, strike: bigint, isCall: boolean): Promise<number> {
  const id = await findSeriesId(k.ctx, u, expiry, strike, isCall);
  if (id !== 0) return id;
  const rec = await execute(k, JOB, `list ${isCall ? 'C' : 'P'}${fromWad(strike)} ${expiry}`, () => simulateListSeries(k.ctx, k.account, u, expiry, strike, isCall), {
    expiry,
    strike: fromWad(strike),
    isCall,
  });
  if (rec?.status !== 'success') throw new Error(`could not list ${isCall ? 'C' : 'P'}${fromWad(strike)}`);
  return findSeriesId(k.ctx, u, expiry, strike, isCall);
}

export interface DemoResult {
  longId: bigint;
  shortId: bigint;
  vaultCall?: { seriesId: number; strike: number; premium: number; tx: TxRecord | null };
  vaultRefusals: { strike: number; reason: string }[];
  straddle: { strike: number; call: number; put: number; txs: (TxRecord | null)[] };
}

export async function openDemoPosition(
  k: Keeper,
  a: { underlying?: string; expiry: number; qty?: bigint; longCash?: bigint; shortCash?: bigint },
): Promise<DemoResult> {
  const { ctx } = k;
  if (!isTestChain(k.chain.id)) throw new Error(`the demo book mints mock USDG and runs on the testnet or a local chain only, not on chain ${k.chain.id}`);
  const qty = a.qty ?? WAD;
  const sym = a.underlying ?? 'NVDA';
  const u = tokenOf(ctx.deployment, sym);
  const [, longId, shortId] = await ensureSubaccounts(k, 3);
  await fundSubaccount(k, longId!, a.longCash ?? 500n * WAD);
  await fundSubaccount(k, shortId!, a.shortCash ?? 3_000n * WAD);

  const [spotR, p, g] = await Promise.all([getSpot(ctx, u), getUnderlyingParams(ctx, u), getGlobals(ctx)]);
  const spot = spotR.price;
  k.log('info', JOB, 'start', { underlying: sym, expiry: a.expiry, spot: fromWad(spot), longId, shortId, qty: fromWad(qty) });

  // 1. the nearest call the covered-call vault sells
  const result: DemoResult = { longId: longId!, shortId: shortId!, vaultRefusals: [], straddle: { strike: 0, call: 0, put: 0, txs: [] } };
  const cc = ctx.deployment.vaults.find((v) => v.type === 'coveredCall' && v.underlying === sym);
  if (cc) {
    const vs = await getVault(ctx, cc.address);
    const floor = (spot * (WAD + vs.config.minOtm)) / WAD;
    const strikes = [...new Set([((floor + p.strikeStep - 1n) / p.strikeStep) * p.strikeStep, ...gridStrikes(spot, p.strikeStep, [5, 10, 15, 20], g.maxStrikeDeviation)])]
      .filter((s) => s >= floor)
      .sort((x, y) => (x < y ? -1 : 1));
    const vol0 = await getMarkVol(ctx, u);
    const now0 = await chainNow(k);
    for (const strike of strikes) {
      let seriesId = await findSeriesId(ctx, u, a.expiry, strike, true);
      if (seriesId === 0) {
        // don't list a strike the vault would refuse anyway: its delta must be inside the offer band
        const d = await bsQuote(ctx, { spot, strike, tau: BigInt(a.expiry - now0), vol: vol0, rate: g.rate, isCall: true });
        const ad = d.delta < 0n ? -d.delta : d.delta;
        if (ad < vs.config.minDelta || ad > vs.config.maxDelta) {
          result.vaultRefusals.push({ strike: fromWad(strike), reason: `delta ${fromWad(ad)} outside the offer band` });
          continue;
        }
        seriesId = await ensureSeries(k, u, a.expiry, strike, true);
      }
      let sim;
      try {
        sim = await simulateVaultBuy(ctx, k.account, cc.address, seriesId, qty, 10n ** 30n, longId!);
      } catch (e) {
        result.vaultRefusals.push({ strike: fromWad(strike), reason: why(e) });
        if (e instanceof RefusalError) continue;
        throw e;
      }
      const maxPremium = (sim.result * 102n) / 100n + 1n;
      const tx = await execute(k, JOB, `vault buy C${fromWad(strike)}`, () => simulateVaultBuy(ctx, k.account, cc.address, seriesId, qty, maxPremium, longId!), {
        vault: cc.address,
        seriesId,
        strike: fromWad(strike),
        expiry: a.expiry,
        premium: fromWad(sim.result),
        takerId: longId,
      });
      result.vaultCall = { seriesId, strike: fromWad(strike), premium: fromWad(sim.result), tx };
      break;
    }
    if (!result.vaultCall) k.log('warn', JOB, 'no vault call', { refusals: result.vaultRefusals });
  }

  // 2. an at-the-money straddle, short -> long, through RFQ
  const atm = toGrid(spot, p.strikeStep);
  const now = await chainNow(k);
  const vol = await getMarkVol(ctx, u);
  const domain = getRfqDomain(ctx);
  result.straddle.strike = fromWad(atm);
  for (const isCall of [true, false]) {
    const seriesId = await ensureSeries(k, u, a.expiry, atm, isCall);
    const q = await bsQuote(ctx, { spot, strike: atm, tau: BigInt(a.expiry - now), vol, rate: g.rate, isCall });
    const price = q.price > 0n ? q.price : WAD / 100n;
    const quote: RfqQuote = {
      signer: k.account.address,
      makerId: shortId!,
      seriesId,
      makerSells: true,
      maxQty: qty,
      price,
      deadline: BigInt(now + 900),
      nonce: randomNonce(),
    };
    const sig = await signQuote(k.account, quote, domain);
    const tx = await execute(k, JOB, `rfq ${isCall ? 'C' : 'P'}${fromWad(atm)} ${shortId}->${longId}`, () => simulateRfqFill(ctx, k.account, quote, sig, longId!, qty), {
      seriesId,
      strike: fromWad(atm),
      isCall,
      expiry: a.expiry,
      price: fromWad(price),
      makerId: shortId,
      takerId: longId,
    });
    result.straddle.txs.push(tx);
    if (isCall) result.straddle.call = fromWad(price);
    else result.straddle.put = fromWad(price);
  }
  return result;
}
