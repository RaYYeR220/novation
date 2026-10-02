import { beforeAll, describe, expect, it } from 'vitest';
import { maxUint256, type Address } from 'viem';
import {
  clearinghouseAbi,
  explainTx,
  expiriesOf,
  fromWad,
  getAccountState,
  getAgentEvents,
  getGlobals,
  getMarkets,
  getPositions,
  getQuoteFilled,
  getQuoteFills,
  getQuoteHashOnChain,
  getRfqDomain,
  getScenarioGrid,
  getSubaccountsCreated,
  getTrades,
  getUnderlyingParams,
  getVaultHolding,
  getVaultQuote,
  getVaultQuotesSynced,
  decodeRefusal,
  simulatePushRound,
  getVaults,
  getInsurance,
  listSeries,
  optionVaultAbi,
  quoteHash,
  randomNonce,
  RefusalError,
  scenarioGridFor,
  signQuote,
  simulateApprove,
  simulateCreateSubaccount,
  simulateDeposit,
  simulateGrantAgent,
  simulateMint,
  simulateRequestRedeem,
  simulateRfqFill,
  simulateVaultBuy,
  simulateVaultDeposit,
  simulateVaultWithdraw,
  simulateWithdraw,
  verifyQuote,
  whatIfTrade,
  getSpot,
  WAD,
  type RfqQuote,
  type SeriesInfo,
} from '../../src/index';
import { local, send, type Local } from './helpers';

const l = local();
const d = describe.skipIf(!l);

async function refusal(p: Promise<unknown>): Promise<RefusalError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RefusalError) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

d('Novation on a local chain (KernelReference kernel, repo deploy scripts)', () => {
  const L = l as Local;
  const [taker, maker, agent] = L?.wallets ?? [];
  let USDG: Address;
  let NVDA: Address;
  let cc: Address;
  let takerId: bigint;
  let callSeries: SeriesInfo;
  let series: SeriesInfo[];

  beforeAll(() => {
    USDG = L.ctx.deployment.tokens.USDG as Address;
    NVDA = L.ctx.deployment.tokens.NVDA as Address;
    cc = L.ctx.deployment.vaults.find((v) => v.type === 'coveredCall' && v.underlying === 'NVDA')!.address;
  });

  it('reads the seeded markets, series, vaults and insurance fund', async () => {
    const markets = await getMarkets(L.ctx);
    expect(markets.map((m) => m.symbol)).toEqual(['NVDA', 'TSLA', 'AAPL', 'SPY']);
    for (const m of markets) {
      expect(m.spot).not.toBeNull();
      expect(m.session).not.toBe('HALTED');
      expect(m.markVol).toBeGreaterThan(0n);
      expect(m.params.minPrice).toBeLessThan(m.spot!);
    }
    series = await listSeries(L.ctx);
    expect(series).toHaveLength(4 * 2 * 16);
    expect(expiriesOf(series)).toHaveLength(2);
    const vaults = await getVaults(L.ctx);
    expect(vaults.map((v) => v.kind)).toEqual(['coveredCall', 'coveredCall', 'putWrite']);
    for (const v of vaults) {
      expect(v.live).toBe(true);
      expect(v.totalAssets).toBeGreaterThan(0n);
      expect(v.shareDecimals).toBe(v.assetDecimals + 6);
    }
    expect((await getInsurance(L.ctx)).balance).toBe(100_000n * WAD);
  });

  it('opens an account, deposits, prices the what-if and buys a call from the vault', async () => {
    const me = taker!.account.address;
    await send(L, taker!.wallet, (await simulateMint(L.ctx, me, USDG, me, 20_000n * 10n ** 6n)).request);
    await send(L, taker!.wallet, (await simulateApprove(L.ctx, me, USDG, L.ctx.deployment.clearinghouse, maxUint256)).request);
    const created = await simulateCreateSubaccount(L.ctx, me);
    takerId = created.result;
    await send(L, taker!.wallet, created.request);
    await send(L, taker!.wallet, (await simulateDeposit(L.ctx, me, takerId, USDG, 5_000n * 10n ** 6n)).request);
    expect((await getAccountState(L.ctx, takerId)).cash).toBe(5_000n * WAD);

    // the first NVDA call the covered-call vault sells
    const spot = (await getSpot(L.ctx, NVDA)).price;
    const calls = series.filter((s) => s.underlying === NVDA && s.isCall && s.strike > spot).sort((a, b) => a.expiry - b.expiry || Number(a.strike - b.strike));
    for (const s of calls) {
      try {
        await simulateVaultBuy(L.ctx, me, cc, s.id, WAD, maxUint256, takerId);
        callSeries = s;
        break;
      } catch (e) {
        if (!(e instanceof RefusalError)) throw e;
      }
    }
    expect(callSeries).toBeDefined();

    const premium = await getVaultQuote(L.ctx, cc, callSeries.id, WAD, true);
    const what = await whatIfTrade(L.ctx, { account: takerId, seriesId: callSeries.id, qty: WAD, premium, spot });
    expect(what.after.healthy).toBe(true);
    expect(what.after.im).toBeGreaterThan(0n);
    expect(what.fee).toBeGreaterThan(0n);

    await send(L, taker!.wallet, (await simulateVaultBuy(L.ctx, me, cc, callSeries.id, WAD, (premium * 102n) / 100n, takerId)).request);
    const st = await getAccountState(L.ctx, takerId);
    // the trade mines a block later than the what-if: marks move by a second of theta, no more
    expect(Math.abs(fromWad(st.im) - fromWad(what.after.im)) / fromWad(what.after.im)).toBeLessThan(1e-3);
    expect(Math.abs(fromWad(st.cash) - fromWad(what.after.cash))).toBeLessThan(0.05);
    const pos = await getPositions(L.ctx, takerId);
    expect(pos).toHaveLength(1);
    expect(pos[0]).toMatchObject({ seriesId: callSeries.id, qty: WAD, isCall: true });
  });

  it("rebuilds the clearinghouse's kernel input exactly: same grid, same initial margin", async () => {
    const [grid, mine, st] = await Promise.all([getScenarioGrid(L.ctx, takerId), scenarioGridFor(L.ctx, takerId), getAccountState(L.ctx, takerId)]);
    expect(mine.cells).toEqual(grid);
    expect(mine.out.lossIM).toBe(st.im);
    expect(mine.out.worstScenario).toBe(st.worstScenario);
    // another session's shocks, priced on any day: the weekend range is the regular one x1.75
    const [regular, weekend] = await Promise.all([
      scenarioGridFor(L.ctx, takerId, { session: 'REGULAR' }),
      scenarioGridFor(L.ctx, takerId, { session: 'WEEKEND' }),
    ]);
    const r = regular.shockRange[0]!.range;
    expect(weekend.shockRange[0]!.range).toBe((r * 175n) / 100n);
    // one long call: its loss is capped at its value, so a wider shock can't lower the margin
    expect(weekend.out.lossIM >= regular.out.lossIM).toBe(true);
  });

  it('signs an EIP-712 quote the RFQ venue accepts, and refuses a tampered one', async () => {
    const mk = maker!.account.address;
    await send(L, maker!.wallet, (await simulateMint(L.ctx, mk, USDG, mk, 5_000n * 10n ** 6n)).request);
    await send(L, maker!.wallet, (await simulateApprove(L.ctx, mk, USDG, L.ctx.deployment.clearinghouse, maxUint256)).request);
    const created = await simulateCreateSubaccount(L.ctx, mk);
    await send(L, maker!.wallet, created.request);
    const makerId = created.result;
    await send(L, maker!.wallet, (await simulateDeposit(L.ctx, mk, makerId, USDG, 5_000n * 10n ** 6n)).request);

    const spot = (await getSpot(L.ctx, NVDA)).price;
    const put = series
      .filter((s) => s.underlying === NVDA && !s.isCall && s.strike < spot)
      .sort((a, b) => Number(b.strike - a.strike))[0]!;
    const now = Number((await L.client.getBlock()).timestamp);
    const q: RfqQuote = {
      signer: mk,
      makerId,
      seriesId: put.id,
      makerSells: false,
      maxQty: 3n * WAD,
      price: 2n * WAD,
      deadline: BigInt(now + 3600),
      nonce: randomNonce(),
    };
    const domain = getRfqDomain(L.ctx);
    const sig = await signQuote(maker!.account, q, domain);
    expect(quoteHash(L.ctx, q)).toBe(await getQuoteHashOnChain(L.ctx, q));
    expect(await verifyQuote(q, sig, domain)).toBe(true);
    expect(await verifyQuote(q, sig, domain, L.client)).toBe(true);

    const fill = await simulateRfqFill(L.ctx, taker!.account.address, q, sig, takerId, 2n * WAD);
    expect(fill.result).toBe(4n * WAD);
    await send(L, taker!.wallet, fill.request);
    expect(await getQuoteFilled(L.ctx, quoteHash(L.ctx, q))).toBe(2n * WAD);
    expect((await getQuoteFills(L.ctx, { takerId })).map((e) => e.args.qty)).toEqual([2n * WAD]);
    const held = (await getPositions(L.ctx, takerId)).find((p) => p.seriesId === put.id);
    expect(held?.qty).toBe(-2n * WAD);
    // now short puts: the weekend gap strictly raises initial margin over regular shocks
    const [reg, wk] = await Promise.all([
      scenarioGridFor(L.ctx, takerId, { session: 'REGULAR' }),
      scenarioGridFor(L.ctx, takerId, { session: 'WEEKEND' }),
    ]);
    expect(wk.out.lossIM).toBeGreaterThan(reg.out.lossIM);

    const tampered = { ...q, price: q.price + 1n };
    expect(await verifyQuote(tampered, sig, domain)).toBe(false);
    const r = await refusal(simulateRfqFill(L.ctx, taker!.account.address, tampered, sig, takerId, WAD));
    expect(r.refusal.code).toBe('BadSignature');
    const over = await refusal(simulateRfqFill(L.ctx, taker!.account.address, q, sig, takerId, 2n * WAD));
    expect(over.refusal.code).toBe('Overfill');
  });

  it('decodes refusals with their numbers, before signing and from a mined revert', async () => {
    const me = taker!.account.address;
    const st = await getAccountState(L.ctx, takerId);
    const w = await refusal(simulateWithdraw(L.ctx, me, takerId, USDG, st.cash / 10n ** 12n, me));
    expect(w.refusal.code).toBe('InsufficientMargin');
    expect(w.refusal.numbers.id).toBe(Number(takerId));
    expect(w.refusal.numbers.im).toBeCloseTo(fromWad(st.im), 2);
    expect(w.refusal.numbers.equity).toBeLessThan(w.refusal.numbers.im!);

    const ag = agent!.account.address;
    const idx = (await getUnderlyingParams(L.ctx, NVDA)).index;
    const now = Number((await L.client.getBlock()).timestamp);
    const budget = st.im + WAD;
    await send(
      L,
      taker!.wallet,
      (await simulateGrantAgent(L.ctx, me, takerId, ag, { maxWorstLoss: budget, maxPremiumPerTrade: 500n * WAD, allowedMask: 1n << BigInt(idx), expiresAt: now + 86400 }))
        .request,
    );
    const q = await getVaultQuote(L.ctx, cc, callSeries.id, 5n * WAD, true);
    const r = await refusal(simulateVaultBuy(L.ctx, ag, cc, callSeries.id, 5n * WAD, q * 2n, takerId));
    expect(r.refusal.code).toBe('AgentRiskBudgetExceeded');
    expect(r.refusal.numbers.budget).toBeCloseTo(fromWad(budget), 6);
    expect(r.refusal.numbers.worstLoss).toBeGreaterThan(r.refusal.numbers.budget!);

    // the same ticket sent anyway (fixed gas, no simulation) reverts on chain; replay explains it
    const hash = await agent!.wallet.writeContract({
      address: cc,
      abi: optionVaultAbi,
      functionName: 'buy',
      args: [callSeries.id, 5n * WAD, q * 2n, takerId],
      gas: 5_000_000n,
      account: agent!.account,
      chain: L.client.chain,
    });
    const rc = await L.client.waitForTransactionReceipt({ hash });
    expect(rc.status).toBe('reverted');
    const why = await explainTx(L.ctx, hash);
    expect(why?.refusal.code).toBe('AgentRiskBudgetExceeded');
    expect((await getAgentEvents(L.ctx, takerId)).map((e) => e.eventName)).toEqual(['AgentGranted']);
  });

  it('deposits into a vault, holds the exit cooldown, then queues and withdraws', async () => {
    const me = taker!.account.address;
    await send(L, taker!.wallet, (await simulateMint(L.ctx, me, NVDA, me, 2n * WAD)).request);
    await send(L, taker!.wallet, (await simulateApprove(L.ctx, me, NVDA, cc, maxUint256)).request);
    await send(L, taker!.wallet, (await simulateVaultDeposit(L.ctx, me, cc, 2n * WAD, me)).request);
    const h = await getVaultHolding(L.ctx, cc, me);
    expect(h.shares).toBeGreaterThan(0n);

    const r = await refusal(simulateRequestRedeem(L.ctx, me, cc, h.shares / 2n, me));
    expect(r.refusal.code).toBe('ExitCooldown');
    expect(r.refusal.numbers.until).toBe(h.lastReceive + 3600);

    await L.rpc('evm_increaseTime', [3601]);
    await L.rpc('evm_mine');
    await send(L, taker!.wallet, (await simulateRequestRedeem(L.ctx, me, cc, h.shares / 2n, me)).request);
    expect((await getVaultHolding(L.ctx, cc, me)).pendingShares).toBe(h.shares / 2n);
    await send(L, taker!.wallet, (await simulateVaultWithdraw(L.ctx, me, cc, WAD / 2n, me, me)).request);
  });

  it('quotes through the lens when a new feed round leaves the stored vol behind', async () => {
    const before = await getVaultQuotesSynced(L.ctx, cc, [callSeries.id], WAD);
    expect(before.live).toBe(true);
    expect(before.quotes[0]!.ask).toBe(await getVaultQuote(L.ctx, cc, callSeries.id, WAD, true));

    const feed = L.ctx.deployment.feeds.NVDA as Address;
    const now = Number((await L.client.getBlock()).timestamp);
    await send(L, maker!.wallet, (await simulatePushRound(L.ctx, maker!.account.address, feed, 191n * 10n ** 8n, BigInt(now))).request);
    const stale = await refusal(
      getVaultQuote(L.ctx, cc, callSeries.id, WAD, true).catch((e) => {
        throw new RefusalError(decodeRefusal(e)!);
      }),
    );
    expect(stale.refusal.code).toBe('VaultNotLive');
    const after = await getVaultQuotesSynced(L.ctx, cc, [callSeries.id], WAD);
    expect(after.live).toBe(true);
    expect(after.quotes[0]!.ask).toBeGreaterThan(0n);
    // the vault is short the one call it sold: it bids for that much, not for five
    expect(after.quotes[0]!.bid).toBeGreaterThan(0n);
    const five = await getVaultQuotesSynced(L.ctx, cc, [callSeries.id], 5n * WAD);
    expect(five.quotes[0]!.bidRefusal?.code).toBe('ExceedsShort');
    expect(five.quotes[0]!.bid).toBeUndefined();
  });

  it('scans events in chunks from the deployment block', async () => {
    const all = await getTrades(L.ctx);
    const chunked = await getTrades(L.ctx, { chunk: 7n });
    expect(chunked.map((e) => e.transactionHash)).toEqual(all.map((e) => e.transactionHash));
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.map((e) => e.args.takerId)).toContain(takerId);
    const created = await getSubaccountsCreated(L.ctx, { owner: taker!.account.address });
    expect(created.map((e) => e.args.id)).toEqual([takerId]);
    const g = await getGlobals(L.ctx);
    expect(g.minTradeQty).toBe(WAD / 100n);
    // the clearinghouse ABI carries the trade log
    expect(clearinghouseAbi.some((x) => x.type === 'event' && x.name === 'Traded')).toBe(true);
  });
});
