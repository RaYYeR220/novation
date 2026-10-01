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
import { execute, why, type Keeper } from '../keeper';
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
 * Liquidation scan: every account below maintenance margin with a live book gets its Dutch
 * auction started (startLiquidation is permissionless; the auction house refuses it outside a
 * REGULAR or EXTENDED session). Then, from the keeper's own funded subaccount, a bid on each running
 * auction as soon as it starts, so at the start discount: maxFractionPerBid of the book (all of it
 * once equity is dust), halved while the bid would leave the bidder below initial margin. Deficit
 * sales started by settlement get bids for the defaulter's stock collateral, sized to what the
 * deficit still needs; a sliver below dustSweep that the discount ramp leaves is paid in and applied
 * with repayDeficit, so the account isn't left blocked by dust.
 */
export async function liquidations(k: Keeper): Promise<void> {
  const { ctx } = k;
  const g = await getGlobals(ctx);
  let bidder = await bidderOf(k);

  for (const id of k.state.accounts) {
    const [st, ps] = await Promise.all([getAccountState(ctx, id), getPositionStatus(ctx, id)]);
    if (!st.liquidatable || ps.live === 0n || ps.awaiting !== 0n) continue;
    const base = { id, equity: fromWad(st.equity), mm: fromWad(st.mm), im: fromWad(st.im) };
    let lq = await getLiquidation(ctx, id);
    if (!lq.active) {
      const rec = await execute(k, JOB, `startLiquidation ${id}`, () => simulateStartLiquidation(ctx, k.account, id), base);
      if (rec?.status !== 'success') continue;
      lq = await getLiquidation(ctx, id);
    }
    if (!bidder) {
      k.log('info', JOB, 'skip', { ...base, reason: 'no funded keeper subaccount to bid from' });
      continue;
    }
    if (bidder.id === id) continue;
    let fraction = st.equity <= g.dustEquity ? WAD : g.maxFractionPerBid;
    const maxPay = min(k.opts.bidBudget, bidder.cash);
    for (let attempt = 0; attempt < 4; attempt++) {
      let sim: Awaited<ReturnType<typeof simulateBidLiquidation>>;
      try {
        sim = await simulateBidLiquidation(ctx, k.account, id, fraction, bidder.id, maxPay);
      } catch (e) {
        const code = e instanceof RefusalError ? e.refusal.code : undefined;
        if ((code === 'BidderUnhealthy' || code === 'PayAboveMax') && attempt < 3) {
          fraction /= 2n;
          continue;
        }
        k.log('info', JOB, 'skip', { ...base, label: `bidLiquidation ${id}`, fraction: fromWad(fraction), reason: why(e) });
        break;
      }
      await execute(k, JOB, `bidLiquidation ${id}`, async () => sim, {
        ...base,
        bidderId: bidder.id,
        fraction: fromWad(fraction),
        discount: fromWad(lq.discount),
        paid: fromWad(sim.result),
      });
      break;
    }
    bidder = await bidderOf(k);
  }

  for (const key of [...k.state.deficitSales]) {
    const [idS, eS] = key.split(':');
    const id = BigInt(idS!);
    const expiry = Number(eS);
    let need = await stillOwed(k, id, expiry);
    const sale = await getDeficitSale(ctx, id, expiry);
    if (!sale.active || need === 0n) {
      if (need === 0n) k.state.deficitSales.delete(key);
      continue;
    }
    // bid for the collateral until the deficit is covered: the discount ramps by the second, so a
    // bid sized at one block's price can land a block later at a lower one and leave a sliver
    for (let pass = 0; pass < 3 && need > k.opts.dustSweep; pass++) {
      if (!bidder) {
        k.log('info', JOB, 'skip', { id, expiry, reason: 'no funded keeper subaccount to bid from' });
        break;
      }
      const before = need;
      for (const c of await getCollateral(ctx, id)) {
        if (need <= k.opts.dustSweep || !bidder) break;
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
        const budget = min(k.opts.bidBudget, bidder.cash);
        // the auction house accepts up to divWadUp(owed - cash, price)
        const tokenWad = min(c.amount, min((need * WAD + price - 1n) / price, (budget * WAD) / price));
        if (tokenWad === 0n) continue;
        const bidderId = bidder.id;
        const rec = await execute(
          k,
          JOB,
          `bidDeficit ${id} ${expiry} ${sym}`,
          () =>
            k.client.simulateContract({
              address: ctx.deployment.auctionHouse,
              abi: auctionHouseAbi,
              functionName: 'bidDeficit',
              args: [id, BigInt(expiry), c.token, tokenWad, bidderId, budget],
              account: k.account,
            }),
          { id, expiry, token: sym, tokenWad: fromWad(tokenWad), discount: fromWad(discount), bidderId, need: fromWad(need) },
        );
        if (rec?.status === 'success') {
          need = await stillOwed(k, id, expiry);
          bidder = await bidderOf(k);
        }
      }
      if (need >= before) break;
    }
    // what the ramp left is dust: pay it in and apply it (deposit and repayDeficit are open to anyone)
    if (need > 0n && need <= k.opts.dustSweep) {
      const dep = await depositUsdg(k, JOB, id, need);
      if (dep?.status === 'success') {
        const rec = await execute(k, JOB, `repayDeficit ${id}`, () => simulateRepayDeficit(ctx, k.account, id), { id, expiry, dust: fromWad(need) });
        if (rec?.status === 'success' && (await stillOwed(k, id, expiry)) === 0n) k.state.deficitSales.delete(key);
      }
    }
  }
}

/** What `id` still owes on `expiry` (its pool and fund parts plus residual socialized debt), net of its cash. */
async function stillOwed(k: Keeper, id: bigint, expiry: number): Promise<bigint> {
  const [d, social, cash] = await Promise.all([getDeficit(k.ctx, id, expiry), getSocializedDebt(k.ctx, id), getCash(k.ctx, id)]);
  const owed = d.bridged + d.pending + social;
  return owed > cash ? owed - cash : 0n;
}
