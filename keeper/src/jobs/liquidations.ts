import {
  auctionHouseAbi,
  fromWad,
  getCash,
  getClaimable,
  getClaimExpiries,
  getLiquidationState,
  getPool,
  getUnderlyingParams,
  getUnderlyingsOf,
  getVolCurrent,
  getVolState,
  MAX_VOL_SYNC_STEPS,
  simulateClaim,
  simulateEndDeficitSale,
  simulateEndLiquidation,
  simulateSyncAndRebaseVol,
  simulateSyncVol,
  simulateVaultRoll,
  getCollateral,
  getDeficit,
  getDeficitSale,
  getGlobals,
  getLiquidation,
  getSocializedDebt,
  getSpot,
  getSubaccountsOf,
  RefusalError,
  simulateBidLiquidation,
  simulateStartLiquidation,
  symbolOf,
  WAD,
} from '@novation/sdk';
import { phaseOf } from '../hint';
import { chainNow, execute, feedReader, why, type Keeper } from '../keeper';
import type { Address } from 'viem';
import { depositUsdg } from '../setup';
import { repayIfCovered } from './deficit';

const JOB = 'liquidation';

/** Claim expiries a liquidation bid may move: each side holds at most this many (Types.sol). */
export const MAX_CLAIM_EXPIRIES = 16;
/** Feed rounds a liquidation folds into each underlying's vol itself; a longer backlog needs a syncVol first. */
export const LIQUIDATION_VOL_ROUNDS = 8n;

/**
 * Which of an account's claim expiries to claim before a bid (the ready ones: claim is
 * permissionless and empties them), how many are left, and whether that is still more than a bid
 * may move (the bid would revert TooManyClaimExpiries).
 */
export function claimPlan(expiries: readonly number[], ready: (expiry: number) => boolean, cap = MAX_CLAIM_EXPIRIES): { claim: number[]; left: number; over: boolean } {
  const claim = expiries.filter(ready);
  const left = expiries.length - claim.length;
  return { claim, left, over: left > cap };
}

/**
 * Claims the account's ready claims (its pool has no unsettled short and nothing pending), a
 * vault's through its roll, so its claim expiries shrink before a bid moves them. True when the
 * account then fits the cap; when blocked claims alone keep it over, the bid would revert and is
 * skipped.
 */
async function trimClaims(k: Keeper, id: bigint): Promise<boolean> {
  const expiries = await getClaimExpiries(k.ctx, id);
  if (expiries.length <= MAX_CLAIM_EXPIRIES) return true;
  const ready = new Set<number>();
  for (const e of expiries) {
    const pool = await getPool(k.ctx, e);
    if (pool.unsettledShortQty === 0n && pool.pending === 0n && (await getClaimable(k.ctx, id, e)) > 0n) ready.add(e);
  }
  const plan = claimPlan(expiries, (e) => ready.has(e));
  const vault = k.state.vaultIds.get(id);
  for (const e of plan.claim) {
    if (vault) await execute(k, JOB, `roll vault ${id} ${e} (claim)`, () => simulateVaultRoll(k.ctx, k.account, vault, [e]), { id, expiry: e });
    else await execute(k, JOB, `claim ${id} ${e}`, () => simulateClaim(k.ctx, k.account, id, e), { id, expiry: e, reason: 'trim claim expiries before a bid' });
  }
  const left = (await getClaimExpiries(k.ctx, id)).length;
  if (left > MAX_CLAIM_EXPIRIES) {
    k.log('info', JOB, 'skip', { id, label: 'bidLiquidation', reason: `claims on ${left} expiries, more than a bid may move (${MAX_CLAIM_EXPIRIES}), and the rest are not ready` });
    return false;
  }
  return true;
}

/**
 * Brings the vol of `only` (else of every underlying of the account) within LIQUIDATION_VOL_ROUNDS
 * of its feed, so a start or a bid doesn't revert VolNotCurrent: syncVol for a longer backlog,
 * syncAndRebaseVol after an aggregator migration, up to MAX_VOL_SYNC_STEPS steps each. Not
 * rate-limited; only ever called on a VolNotCurrent refusal (simulateCaughtUp).
 */
async function catchUpVol(k: Keeper, id: bigint, only?: Address): Promise<void> {
  for (const u of only ? [only] : await getUnderlyingsOf(k.ctx, id)) {
    const sym = symbolOf(k.ctx.deployment, u) ?? u;
    for (let step = 0; step < MAX_VOL_SYNC_STEPS && !(await getVolCurrent(k.ctx, u)); step++) {
      const [vol, p] = await Promise.all([getVolState(k.ctx, u), getUnderlyingParams(k.ctx, u)]);
      const latest = await feedReader(k, p.feed).latest();
      let rec;
      if (phaseOf(latest.id) > phaseOf(vol.lastRoundId)) {
        rec = await execute(k, JOB, `syncAndRebaseVol ${sym}`, () => simulateSyncAndRebaseVol(k.ctx, k.account, u), { id, underlying: sym });
      } else if (latest.id - vol.lastRoundId > LIQUIDATION_VOL_ROUNDS) {
        rec = await execute(k, JOB, `syncVol ${sym}`, () => simulateSyncVol(k.ctx, k.account, u), { id, underlying: sym, behind: latest.id - vol.lastRoundId });
      } else break; // within what the auction house folds itself
      if (rec?.status !== 'success') break;
    }
  }
}

/**
 * Simulates a start or a bid. Only when it is refused VolNotCurrent (an underlying, the account's
 * or the bidder's, is further behind than the auction house folds itself) the keeper catches that
 * vol up and simulates once more: an auction it isn't about to act on costs it no syncs.
 */
async function simulateCaughtUp<T>(k: Keeper, id: bigint, sim: () => Promise<T>): Promise<T> {
  try {
    return await sim();
  } catch (e) {
    if (!(e instanceof RefusalError) || e.refusal.code !== 'VolNotCurrent') throw e;
    await catchUpVol(k, id, e.refusal.args.underlying as Address | undefined);
    return sim();
  }
}


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

/**
 * Whether to (re)start a liquidation now: never started, or the last start is restartBackoffSec
 * old, or a keeper bid went through since it. An account nobody takes over, because the keeper
 * can't bid or its bids keep failing in simulation, costs one start per backoff, not one every
 * auctionDuration.
 */
export function shouldStart(a: { now: number; lastStart?: number; lastBidOk?: number; backoffSec: number }): boolean {
  if (a.lastStart === undefined || a.now - a.lastStart >= a.backoffSec) return true;
  return a.lastBidOk !== undefined && a.lastBidOk >= a.lastStart;
}

/** What `id` owes on `expiry`: its pool and fund parts, plus residual socialized debt. */
async function owedOn(k: Keeper, id: bigint, expiry: number): Promise<bigint> {
  const [d, social] = await Promise.all([getDeficit(k.ctx, id, expiry), getSocializedDebt(k.ctx, id)]);
  return d.bridged + d.pending + social;
}

/**
 * A repaid deficit sale (by a bid, or the account's own cash through repayDeficit) that is still
 * open is ended, so a later deficit on the same expiry starts a fresh ramp instead of reusing the
 * old start at maxDiscount (endDeficitSale is permissionless). True once no sale is open.
 */
async function closeSale(k: Keeper, id: bigint, expiry: number): Promise<boolean> {
  if (!(await getDeficitSale(k.ctx, id, expiry)).active) return true;
  const rec = await execute(k, JOB, `endDeficitSale ${id} ${expiry}`, () => simulateEndDeficitSale(k.ctx, k.account, id, expiry), { id, expiry });
  return rec?.status === 'success';
}

/** owedOn net of the account's cash. */
async function stillOwed(k: Keeper, id: bigint, expiry: number): Promise<bigint> {
  const [owed, cash] = await Promise.all([owedOn(k, id, expiry), getCash(k.ctx, id)]);
  return owed > cash ? owed - cash : 0n;
}

/**
 * Liquidation scan: every account below maintenance margin with a live book gets its Dutch auction
 * started (startLiquidation is permissionless; the auction house refuses it outside a REGULAR or
 * EXTENDED session). A restart without a successful keeper bid since the last start waits
 * restartBackoffSec per account (shouldStart), so an account nobody takes over doesn't cost a start
 * every 30 min. A start or bid reverts VolNotCurrent when an underlying's vol is more than 8 feed
 * rounds behind; on that refusal, and only then, the keeper syncs the vol and simulates once more.
 * An auction left running on an account that recovered is ended (endLiquidation), whoever started
 * it: running auctions are tracked from LiquidationStarted / LiquidationEnded, scanned from the
 * deployment block at startup.
 *
 * Bidding is opt-in (`bid`) and capped: at most bidBudget per bid and bidExposureCap over the life
 * of the process, from the keeper's own funded subaccount. A bid goes in as soon as the auction
 * starts, so at the start discount: maxFractionPerBid of the book (all of it once equity is dust),
 * halved while the bid would leave the bidder below initial margin. The keeper never unwinds what it
 * takes over. Deficit sales started by settlement get bids for the defaulter's stock collateral,
 * sized to what the deficit still needs; a sliver below dustSweep that the discount ramp leaves is
 * paid in and applied with repayDeficit, so dust doesn't keep the account blocked. Cash that already
 * covers a deficit (a deposit, a claim) is applied with repayDeficit before the sale is dropped;
 * repays are gated by shouldRepay (backoff after one that changed nothing, reserve on repeats). A
 * repaid sale that is still open is ended (endDeficitSale). Before a bid, the ready claims of the
 * account and of the bidder are claimed, since a bid can't leave either holding claims on more
 * than MAX_CLAIM_EXPIRIES expiries (it reverts TooManyClaimExpiries); still over with blocked
 * claims only, the bid is skipped.
 */
export async function liquidations(k: Keeper): Promise<void> {
  const { ctx } = k;
  const g = await getGlobals(ctx);
  const now = await chainNow(k);

  for (const id of k.state.accounts) {
    const { state: st, live, awaiting } = await getLiquidationState(ctx, id);
    if (!st.liquidatable) {
      // an auction left running on an account that recovered: end it, so a later fall starts a
      // fresh ramp (endLiquidation is permissionless and needs no open market)
      if (k.state.liquidating.has(id)) {
        const startedAt = await k.client.readContract({ address: ctx.deployment.auctionHouse, abi: auctionHouseAbi, functionName: 'liquidationStartedAt', args: [id] });
        if (startedAt === 0n) k.state.liquidating.delete(id);
        else {
          const rec = await execute(k, JOB, `endLiquidation ${id}`, () => simulateEndLiquidation(ctx, k.account, id), { id, equity: fromWad(st.equity), mm: fromWad(st.mm) });
          if (rec?.status === 'success') k.state.liquidating.delete(id);
        }
      }
      continue;
    }
    if (live === 0n || awaiting !== 0n) continue;
    const base = { id, equity: fromWad(st.equity), mm: fromWad(st.mm), im: fromWad(st.im) };
    const can = await biddable(k);
    let lq = await getLiquidation(ctx, id);
    if (!lq.active) {
      const last = k.state.lastStart.get(id);
      if (!shouldStart({ now, lastStart: last, lastBidOk: k.state.lastBidOk.get(id), backoffSec: k.opts.restartBackoffSec })) {
        k.log('debug', JOB, 'backoff', { ...base, reason: 'no keeper bid went through since the last start', lastStart: last });
        continue;
      }
      let start: Awaited<ReturnType<typeof simulateStartLiquidation>>;
      try {
        start = await simulateCaughtUp(k, id, () => simulateStartLiquidation(ctx, k.account, id));
      } catch (e) {
        k.log(e instanceof RefusalError ? 'info' : 'warn', JOB, 'skip', { ...base, label: `startLiquidation ${id}`, reason: why(e) });
        continue;
      }
      const rec = await execute(k, JOB, `startLiquidation ${id}`, async () => start, base);
      if (rec?.status !== 'success') continue;
      k.state.lastStart.set(id, now);
      k.state.liquidating.add(id);
      lq = await getLiquidation(ctx, id);
    }
    if ('reason' in can) {
      k.log('info', JOB, 'skip', { ...base, label: `bidLiquidation ${id}`, reason: can.reason });
      continue;
    }
    if (can.id === id) continue;
    // a bid moves the account's unpaid claims to the bidder: neither may end up holding claims on
    // more than MAX_CLAIM_EXPIRIES expiries, so the ready ones are claimed first
    if (!(await trimClaims(k, id)) || !(await trimClaims(k, can.id))) continue;
    let fraction = st.equity <= g.dustEquity ? WAD : g.maxFractionPerBid;
    for (let attempt = 0; attempt < 4; attempt++) {
      let sim: Awaited<ReturnType<typeof simulateBidLiquidation>>;
      try {
        // a bid needs the account's and the bidder's own underlyings current (it folds up to 8 rounds each)
        sim = await simulateCaughtUp(k, id, () => simulateBidLiquidation(ctx, k.account, id, fraction, can.id, can.budget));
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
      if (rec?.status === 'success') {
        k.state.lastBidOk.set(id, now);
        if (sim.result > 0n) k.state.committed += sim.result;
      }
      break;
    }
  }

  for (const key of [...k.state.deficitSales]) {
    const [idS, eS] = key.split(':');
    const id = BigInt(idS!);
    const expiry = Number(eS);
    const owed = await owedOn(k, id, expiry);
    if (owed === 0n) {
      if (await closeSale(k, id, expiry)) k.state.deficitSales.delete(key);
      continue;
    }
    // cash that already covers the debt (a deposit, a claim) only counts once it is applied
    if ((await getCash(ctx, id)) >= owed) {
      await repayIfCovered(k, JOB, id);
      if ((await owedOn(k, id, expiry)) === 0n && (await closeSale(k, id, expiry))) k.state.deficitSales.delete(key);
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
        await repayIfCovered(k, JOB, id);
        if ((await owedOn(k, id, expiry)) === 0n && (await closeSale(k, id, expiry))) k.state.deficitSales.delete(key);
      }
    }
  }
}
