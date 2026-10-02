import {
  auctionHouseAbi,
  fromWad,
  getAccountState,
  getCash,
  getCollateral,
  getDeficit,
  getDeficitSale,
  getGlobals,
  getLiquidation,
  getPositionStatus,
  getSocializedDebt,
  getSpot,
  getSubaccountsOf,
  RefusalError,
  simulateBidLiquidation,
  simulateRepayDeficit,
  simulateStartLiquidation,
  symbolOf,
  WAD,
} from '@novation/sdk';
import { chainNow, execute, why, type Keeper } from '../keeper';
import { depositUsdg } from '../setup';

const JOB = 'liquidation';

const min = (a: bigint, b: bigint) => (a < b ? a : b);

/** The keeper's bidding subaccount (its first) and its cash, or null when it has none or too little cash. */
export async function bidderOf(k: Keeper): Promise<{ id: bigint; cash: bigint } | null> {
  const [id] = await getSubaccountsOf(k.ctx, k.account.address);
  if (id === undefined) return null;
  const cash = await getCash(k.ctx, id);
  return cash >= k.opts.minBidderCash ? { id, cash } : null;
}

/**
 * What the keeper may still pay into one bid: bidding on, a funded subaccount, and within both the
 * per-bid budget and what is left of the exposure cap. Null (with the reason) when it can't bid.
 */
async function biddable(k: Keeper): Promise<{ id: bigint; budget: bigint } | { reason: string }> {
  if (!k.opts.bid) return { reason: 'bidding is off (--bid to enable)' };
  const left = k.opts.bidExposureCap - k.state.committed;
  if (left <= 0n) return { reason: `exposure cap reached (${fromWad(k.state.committed)} USDG committed)` };
  const b = await bidderOf(k);
  if (!b) return { reason: 'no funded keeper subaccount to bid from' };
  return { id: b.id, budget: min(min(k.opts.bidBudget, b.cash), left) };
}

/** What `id` owes on `expiry`: its pool and fund parts, plus residual socialized debt. */
async function owedOn(k: Keeper, id: bigint, expiry: number): Promise<bigint> {
  const [d, social] = await Promise.all([getDeficit(k.ctx, id, expiry), getSocializedDebt(k.ctx, id)]);
  return d.bridged + d.pending + social;
}

/** owedOn net of the account's cash. */
async function stillOwed(k: Keeper, id: bigint, expiry: number): Promise<bigint> {
  const [owed, cash] = await Promise.all([owedOn(k, id, expiry), getCash(k.ctx, id)]);
  return owed > cash ? owed - cash : 0n;
}

/**
 * Liquidation scan: every account below maintenance margin with a live book gets its Dutch auction
 * started (startLiquidation is permissionless; the auction house refuses it outside a REGULAR or
 * EXTENDED session). An auction the keeper can't bid in is (re)started at most once per
 * restartBackoffSec per account, so an account nobody takes over doesn't cost a start every 30 min.
 *
 * Bidding is opt-in (`bid`) and capped: at most bidBudget per bid and bidExposureCap over the life
 * of the process, from the keeper's own funded subaccount. A bid goes in as soon as the auction
 * starts, so at the start discount: maxFractionPerBid of the book (all of it once equity is dust),
 * halved while the bid would leave the bidder below initial margin. The keeper never unwinds what it
 * takes over. Deficit sales started by settlement get bids for the defaulter's stock collateral,
 * sized to what the deficit still needs; a sliver below dustSweep that the discount ramp leaves is
 * paid in and applied with repayDeficit, so dust doesn't keep the account blocked. Cash that already
 * covers a deficit (a deposit, a claim) is applied with repayDeficit before the sale is dropped.
 */
export async function liquidations(k: Keeper): Promise<void> {
  const { ctx } = k;
  const g = await getGlobals(ctx);
  const now = await chainNow(k);

  for (const id of k.state.accounts) {
    const [st, ps] = await Promise.all([getAccountState(ctx, id), getPositionStatus(ctx, id)]);
    if (!st.liquidatable || ps.live === 0n || ps.awaiting !== 0n) continue;
    const base = { id, equity: fromWad(st.equity), mm: fromWad(st.mm), im: fromWad(st.im) };
    const can = await biddable(k);
    let lq = await getLiquidation(ctx, id);
    if (!lq.active) {
      const last = k.state.lastStart.get(id);
      if ('reason' in can && last !== undefined && now - last < k.opts.restartBackoffSec) {
        k.log('debug', JOB, 'backoff', { ...base, reason: can.reason, lastStart: last });
        continue;
      }
      const rec = await execute(k, JOB, `startLiquidation ${id}`, () => simulateStartLiquidation(ctx, k.account, id), base);
      if (rec?.status !== 'success') continue;
      k.state.lastStart.set(id, now);
      lq = await getLiquidation(ctx, id);
    }
    if ('reason' in can) {
      k.log('info', JOB, 'skip', { ...base, label: `bidLiquidation ${id}`, reason: can.reason });
      continue;
    }
    if (can.id === id) continue;
    let fraction = st.equity <= g.dustEquity ? WAD : g.maxFractionPerBid;
    for (let attempt = 0; attempt < 4; attempt++) {
      let sim: Awaited<ReturnType<typeof simulateBidLiquidation>>;
      try {
        sim = await simulateBidLiquidation(ctx, k.account, id, fraction, can.id, can.budget);
      } catch (e) {
        const code = e instanceof RefusalError ? e.refusal.code : undefined;
        if ((code === 'BidderUnhealthy' || code === 'PayAboveMax') && attempt < 3) {
          fraction /= 2n;
          continue;
        }
        k.log('info', JOB, 'skip', { ...base, label: `bidLiquidation ${id}`, fraction: fromWad(fraction), reason: why(e) });
        break;
      }
      const rec = await execute(k, JOB, `bidLiquidation ${id}`, async () => sim, {
        ...base,
        bidderId: can.id,
        fraction: fromWad(fraction),
        discount: fromWad(lq.discount),
        paid: fromWad(sim.result),
      });
      if (rec?.status === 'success' && sim.result > 0n) k.state.committed += sim.result;
      break;
    }
  }

  for (const key of [...k.state.deficitSales]) {
    const [idS, eS] = key.split(':');
    const id = BigInt(idS!);
    const expiry = Number(eS);
    const owed = await owedOn(k, id, expiry);
    if (owed === 0n) {
      k.state.deficitSales.delete(key);
      continue;
    }
    // cash that already covers the debt (a deposit, a claim) only counts once it is applied
    if ((await getCash(ctx, id)) >= owed) {
      const rec = await execute(k, JOB, `repayDeficit ${id}`, () => simulateRepayDeficit(ctx, k.account, id), { id, expiry, owed: fromWad(owed) });
      if (rec?.status === 'success' && (await owedOn(k, id, expiry)) === 0n) k.state.deficitSales.delete(key);
      continue;
    }
    const sale = await getDeficitSale(ctx, id, expiry);
    if (!sale.active) continue;
    let need = await stillOwed(k, id, expiry);
    // bid for the collateral until the deficit is covered: the discount ramps by the second, so a
    // bid sized at one block's price can land a block later at a lower one and leave a sliver
    for (let pass = 0; pass < 3 && need > k.opts.dustSweep; pass++) {
      const before = need;
      for (const c of await getCollateral(ctx, id)) {
        if (need <= k.opts.dustSweep) break;
        const can = await biddable(k);
        if ('reason' in can) {
          k.log('info', JOB, 'skip', { id, expiry, reason: can.reason });
          break;
        }
        const sym = symbolOf(ctx.deployment, c.token) ?? c.token;
        let spot: bigint;
        try {
          const s = await getSpot(ctx, c.token);
          if (!s.ok || (s.session !== 'REGULAR' && s.session !== 'EXTENDED')) {
            k.log('info', JOB, 'skip', { id, expiry, token: sym, reason: `market ${s.session}` });
            continue;
          }
          spot = s.price;
        } catch (e) {
          k.log('info', JOB, 'skip', { id, expiry, token: sym, reason: why(e) });
          continue;
        }
        const { discount } = await getDeficitSale(ctx, id, expiry);
        const price = (spot * (WAD - discount)) / WAD;
        // the auction house accepts up to divWadUp(owed - cash, price)
        const tokenWad = min(c.amount, min((need * WAD + price - 1n) / price, (can.budget * WAD) / price));
        if (tokenWad === 0n) continue;
        let paid = 0n;
        const rec = await execute(
          k,
          JOB,
          `bidDeficit ${id} ${expiry} ${sym}`,
          async () => {
            const sim = await k.client.simulateContract({
              address: ctx.deployment.auctionHouse,
              abi: auctionHouseAbi,
              functionName: 'bidDeficit',
              args: [id, BigInt(expiry), c.token, tokenWad, can.id, can.budget],
              account: k.account,
            });
            paid = sim.result;
            return sim;
          },
          { id, expiry, token: sym, tokenWad: fromWad(tokenWad), discount: fromWad(discount), bidderId: can.id, need: fromWad(need) },
        );
        if (rec?.status === 'success') {
          k.state.committed += paid;
          need = await stillOwed(k, id, expiry);
        }
      }
      if (need >= before) break;
    }
    // what the ramp left is dust: pay it in and apply it (deposit and repayDeficit are open to anyone)
    if (need > 0n && need <= k.opts.dustSweep && k.opts.bid) {
      const dep = await depositUsdg(k, JOB, id, need);
      if (dep?.status === 'success') {
        k.state.committed += need;
        const rec = await execute(k, JOB, `repayDeficit ${id}`, () => simulateRepayDeficit(ctx, k.account, id), { id, expiry, dust: fromWad(need) });
        if (rec?.status === 'success' && (await owedOn(k, id, expiry)) === 0n) k.state.deficitSales.delete(key);
      }
    }
  }
}
