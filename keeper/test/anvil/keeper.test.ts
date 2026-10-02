/**
 * The keeper against a local chain: anvil, the Solidity KernelReference as the kernel and the
 * repo's own forge scripts (the SDK's fixture), with the MockAggregators driven by the test.
 * One file, in order: the chain clock only moves forward.
 */
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { maxUint256, parseEther, parseEventLogs, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  auctionHouseAbi,
  bsQuote,
  clearinghouseAbi,
  findSeriesId,
  getAccountState,
  getCash,
  getClaimable,
  getGlobals,
  getMarkVol,
  getPool,
  getPositions,
  getRfqDomain,
  getSettlementPrice,
  getUnderlyingParams,
  getVault,
  getVaultHolding,
  getVolState,
  mockAggregatorAbi,
  nextWeeklyExpiry,
  optionVaultAbi,
  randomNonce,
  signQuote,
  simulateApprove,
  simulateListSeries,
  simulateMint,
  simulateRequestRedeem,
  simulateRfqFill,
  simulateSettleExpiry,
  simulateVaultBuy,
  simulateVaultDeposit,
  simulateWithdraw,
  WAD,
  weeklyExpiries,
  type RfqQuote,
} from '@novation/sdk';
import {
  createKeeper,
  createLogger,
  deriveKeeperKey,
  ensureSubaccounts,
  fundSubaccount,
  gridStrikes,
  hintFor,
  openDemoPosition,
  tick,
  toGrid,
  topUpKeeper,
  type Keeper,
} from '../../src/index';
import { actor, DEPLOYER_KEY, fundedAccount, local, now, nextTradable, pushRound, refreshFeeds, send, spotOf, warpTo, type Actor, type Local } from './helpers';

const l = local();
const d = describe.skipIf(!l);

d('keeper on a local chain', () => {
  const L = l as Local;
  let k: Keeper;
  let admin: Actor;
  const logs: Record<string, unknown>[] = [];
  const lines = (job: string, msg?: string) => logs.filter((x) => x.job === job && (msg === undefined || x.msg === msg));
  const labels = (txs: { label: string }[]) => txs.map((t) => t.label);
  const tok = (s: string) => L.deployment.tokens[s] as Address;
  const answerOf = (wad: bigint) => wad / 10n ** 10n;

  beforeAll(async () => {
    admin = await actor(L);
    k = createKeeper({
      chain: L.chain,
      deployment: L.deployment,
      key: deriveKeeperKey(DEPLOYER_KEY),
      rpcUrl: L.rpcUrl,
      client: L.client,
      pollingInterval: 50,
      log: createLogger({ sink: (s) => logs.push(JSON.parse(s)) }),
      // anvil mines a block per transaction and the test drives the clock: no confirmation lag or
      // settle delay; bidding on, and no listing cap unless a test sets one
      opts: { settleDelaySec: 0, confirmations: 0, bid: true, listPerTick: 1000 },
    });
    // keep the coming expiry far enough away for the trading part of the scenario
    const t = await now(L);
    const e1 = nextWeeklyExpiry(t);
    if (e1 - t < 8 * 3600) {
      await warpTo(L, e1 + 3600);
      await refreshFeeds(L, admin, e1 + 3600);
    }
  });

  // KEEPER_LOG_FILE=path keeps the keeper's JSON lines for a look after the run
  afterAll(() => {
    if (process.env.KEEPER_LOG_FILE) writeFileSync(process.env.KEEPER_LOG_FILE, logs.map((x) => `${JSON.stringify(x)}\n`).join(''));
  });

  it('funds the key it derives from the deployer key, once', async () => {
    expect(k.account.address).toBe(privateKeyToAccount(deriveKeeperKey(DEPLOYER_KEY)).address);
    const target = parseEther('0.0005');
    const rec = await topUpKeeper({ client: L.client, chain: L.chain, rpcUrl: L.rpcUrl, deployerKey: DEPLOYER_KEY, keeper: k.account.address, target, log: k.log });
    expect(rec?.status).toBe('success');
    expect(await L.client.getBalance({ address: k.account.address })).toBe(target);
    expect(await topUpKeeper({ client: L.client, chain: L.chain, rpcUrl: L.rpcUrl, deployerKey: DEPLOYER_KEY, keeper: k.account.address, target, log: k.log })).toBeNull();
    // anvil's base fee is far above a real L2's: give the keeper room for the scenario
    await L.rpc('anvil_setBalance', [k.account.address, `0x${parseEther('10').toString(16)}`]);
  });

  it('syncs vol when a feed has a new round, and only then', async () => {
    await tick(k, ['syncVol']); // whatever the setup left behind
    const t = await now(L);
    await pushRound(L, admin, 'NVDA', answerOf(await spotOf(L, 'NVDA')) * 106n / 100n, t);
    const sent = await tick(k, ['syncVol']);
    expect(labels(sent)).toEqual(['syncVol NVDA']);
    // signed locally by the derived key (not an anvil account), gas estimate padded 25%
    const tx = await L.client.getTransaction({ hash: sent[0]!.hash });
    expect(tx.from.toLowerCase()).toBe(k.account.address.toLowerCase());
    expect(tx.gas * 100n).toBeGreaterThanOrEqual(sent[0]!.gasUsed * 120n);
    const vol = await getVolState(L.ctx, tok('NVDA'));
    const feed = await L.client.readContract({ address: L.deployment.feeds.NVDA as Address, abi: mockAggregatorAbi, functionName: 'latestRoundData' });
    expect(vol.lastRoundId).toBe(feed[0]);
    expect(await tick(k, ['syncVol'])).toEqual([]);
  });

  it('keeps the weekly grid listed for the next two expiries, sending only what is missing', async () => {
    const sent = await tick(k, ['listSeries']);
    expect(sent.length).toBeGreaterThan(0); // NVDA moved 6%: its grid shifted
    expect(sent.every((t) => t.status === 'success')).toBe(true);
    const t = await now(L);
    const g = await getGlobals(L.ctx);
    for (const sym of ['NVDA', 'TSLA', 'AAPL', 'SPY']) {
      const p = await getUnderlyingParams(L.ctx, tok(sym));
      const strikes = gridStrikes(await spotOf(L, sym), p.strikeStep, [5, 10, 15, 20], g.maxStrikeDeviation);
      expect(strikes).toHaveLength(8);
      for (const e of weeklyExpiries(t, 2)) for (const s of strikes) for (const c of [true, false]) expect(await findSeriesId(L.ctx, tok(sym), e, s, c)).toBeGreaterThan(0);
    }
    expect(await tick(k, ['listSeries'])).toEqual([]);
  });

  it('runs the weekly cycle: trade, expiry, settle the expiry, settle accounts payers first, claim, roll', async () => {
    let t = await now(L);
    let E = nextWeeklyExpiry(t);
    if (E - t < 3 * 3600) E = nextWeeklyExpiry(E);
    await refreshFeeds(L, admin, t);
    await tick(k, ['syncVol', 'listSeries']);
    const NVDA = tok('NVDA');
    const cc = L.deployment.vaults.find((v) => v.type === 'coveredCall' && v.underlying === 'NVDA')!.address;
    const [bidder] = await ensureSubaccounts(k, 1);
    await fundSubaccount(k, bidder!, 20_000n * WAD);

    // a depositor in the NVDA covered-call vault, who queues half its shares for the roll
    const dep = await actor(L);
    await send(L, dep, simulateMint(L.ctx, dep.account.address, NVDA, dep.account.address, 20n * WAD));
    await send(L, dep, simulateApprove(L.ctx, dep.account.address, NVDA, cc, maxUint256));
    await send(L, dep, simulateVaultDeposit(L.ctx, dep.account.address, cc, 20n * WAD, dep.account.address));

    // the keeper's own book: a vault call and an at-the-money straddle between its subaccounts
    const demo = await openDemoPosition(k, { expiry: E });
    expect(demo.vaultCall?.tx?.status).toBe('success');
    expect(demo.straddle.txs.map((x) => x?.status)).toEqual(['success', 'success']);
    const vaultSeries = demo.vaultCall!.seriesId;

    // an outside taker buys two of the same vault call
    const t1 = await actor(L);
    const t1Id = await fundedAccount(L, t1, 1_000n);
    await send(L, t1, simulateVaultBuy(L.ctx, t1.account.address, cc, vaultSeries, 2n * WAD, 10n ** 30n, t1Id));

    await warpTo(L, (await now(L)) + 3700);
    await refreshFeeds(L, admin, await now(L));
    const shares = (await getVaultHolding(L.ctx, cc, dep.account.address)).shares;
    await send(L, dep, simulateRequestRedeem(L.ctx, dep.account.address, cc, shares / 2n, dep.account.address));

    // last prints before the close: NVDA $10 above the vault call's strike
    const settle = BigInt(demo.vaultCall!.strike) * WAD + 10n * WAD;
    await warpTo(L, E - 600);
    await refreshFeeds(L, admin, E - 600, { NVDA: answerOf(settle) });
    await warpTo(L, E + 60);
    t = await now(L);

    // the hint the keeper finds is what settleExpiry accepts, under each proof
    let h = await hintFor(k, NVDA, E, t);
    expect(h).toMatchObject({ kind: 'ready', proof: 'latestRound' });
    expect((await simulateSettleExpiry(L.ctx, k.account, NVDA, E, (h as { hint: bigint }).hint)).result).toBe(settle);
    await pushRound(L, admin, 'NVDA', answerOf(settle) + 12345n, E + 30); // a post-close print
    h = await hintFor(k, NVDA, E, t);
    expect(h).toMatchObject({ kind: 'ready', proof: 'nextRound' });
    expect((await simulateSettleExpiry(L.ctx, k.account, NVDA, E, (h as { hint: bigint }).hint)).result).toBe(settle);
    const tslaFeed = L.deployment.feeds.TSLA as Address;
    const tslaPre = (await L.client.readContract({ address: tslaFeed, abi: mockAggregatorAbi, functionName: 'latestRoundData' }))[1];
    await send(L, admin, L.client.simulateContract({ address: tslaFeed, abi: mockAggregatorAbi, functionName: 'setPhase', args: [2], account: admin.account }));
    await pushRound(L, admin, 'TSLA', tslaPre + 777n, E + 40);
    h = await hintFor(k, tok('TSLA'), E, t);
    expect(h).toMatchObject({ kind: 'ready', proof: 'phaseChange' });
    expect((await simulateSettleExpiry(L.ctx, k.account, tok('TSLA'), E, (h as { hint: bigint }).hint)).result).toBe(tslaPre * 10n ** 10n);

    const before = { long: await getCash(L.ctx, demo.longId), t1: await getCash(L.ctx, t1Id) };
    const first = logs.length;
    const sent = await tick(k);
    const fresh = logs.slice(first);
    expect(sent.every((x) => x.status === 'success')).toBe(true);

    // 1. every underlying settled, NVDA at the last pre-close print
    for (const sym of ['NVDA', 'TSLA', 'AAPL', 'SPY']) expect((await getSettlementPrice(L.ctx, tok(sym), E)).settled).toBe(true);
    expect((await getSettlementPrice(L.ctx, NVDA, E)).price).toBe(settle);
    const proofs = fresh.filter((x) => x.job === 'settleExpiry' && x.msg === 'tx').map((x) => [x.underlying, x.proof]);
    expect(proofs).toEqual(expect.arrayContaining([['NVDA', 'nextRound'], ['TSLA', 'phaseChange'], ['AAPL', 'latestRound'], ['SPY', 'latestRound']]));
    // the TSLA vol was re-anchored on the new phase
    expect(labels(sent)).toContain('rebaseVol TSLA');

    // 2. accounts: payers (the keeper's short, the vault through its roll) before receivers
    const settled = fresh.filter((x) => x.job === 'settleAccount' && x.msg === 'tx');
    const roles = settled.map((x) => x.role);
    expect(roles.filter((r) => r === 'payer').length).toBe(2);
    expect(roles.lastIndexOf('payer')).toBeLessThan(roles.indexOf('receiver'));
    expect(settled.map((x) => String(x.id))).toEqual(expect.arrayContaining([String(demo.shortId), String(demo.longId), String(t1Id)]));
    expect((await getPool(L.ctx, E)).unsettledShortQty).toBe(0n);

    // 3. receivers claimed into cash
    expect(await getClaimable(L.ctx, demo.longId, E)).toBe(0n);
    expect(await getClaimable(L.ctx, t1Id, E)).toBe(0n);
    expect((await getCash(L.ctx, t1Id)) - before.t1).toBe(20n * WAD);
    expect(await getCash(L.ctx, demo.longId)).toBeGreaterThan(before.long);
    expect(fresh.filter((x) => x.job === 'claim' && x.msg === 'tx').length).toBe(2);

    // 4. the vault's calls finished in the money: its cash fell short, the fund bridged it and a
    // deficit sale of its NVDA started; the keeper bought what the deficit needed
    const vaultId = (await getVault(L.ctx, cc)).vaultId;
    const bids = sent.filter((x) => x.label.startsWith(`bidDeficit ${vaultId}`));
    expect(bids).toHaveLength(1);
    expect((await L.client.readContract({ address: L.deployment.clearinghouse, abi: clearinghouseAbi, functionName: 'deficitOf', args: [vaultId, BigInt(E)] }))[0]).toBe(0n);

    // 5. next tick: the vault owes nothing any more and its roll pays the queue
    const second = await tick(k);
    expect(labels(second)).toEqual([`roll vault ${vaultId}`]);
    const rc = await L.client.getTransactionReceipt({ hash: second[0]!.hash });
    expect(parseEventLogs({ abi: optionVaultAbi, eventName: 'Rolled', logs: rc.logs })).toHaveLength(1);
    expect((await getVaultHolding(L.ctx, cc, dep.account.address)).redeemable).toBeGreaterThan(0n);

    // 6. and then there is nothing left to do
    expect(await tick(k)).toEqual([]);
    expect((await getVolState(L.ctx, tok('TSLA'))).lastRoundId >> 64n).toBe(2n);
  });
  it('starts a liquidation below maintenance and bids at the start discount from its own subaccount', async () => {
    const t0 = await now(L);
    const t = nextTradable(t0);
    if (t > t0) await warpTo(L, t);
    await refreshFeeds(L, admin, await now(L));
    const [bidder] = await ensureSubaccounts(k, 1);
    await fundSubaccount(k, bidder!, 20_000n * WAD);

    // a maker sells 10 at-the-money NVDA calls on the later expiry, then takes its cash down to
    // just above initial margin
    const maker = await actor(L);
    const taker = await actor(L);
    const makerId = await fundedAccount(L, maker, 5_000n);
    const takerId = await fundedAccount(L, taker, 50_000n);
    const NVDA = tok('NVDA');
    const [, e2] = weeklyExpiries(await now(L), 2);
    const spot = await spotOf(L, 'NVDA');
    const strike = toGrid(spot, 5n * WAD);
    if ((await findSeriesId(L.ctx, NVDA, e2!, strike, true)) === 0) await send(L, admin, simulateListSeries(L.ctx, admin.account, NVDA, e2!, strike, true));
    const sid = await findSeriesId(L.ctx, NVDA, e2!, strike, true);
    const g = await getGlobals(L.ctx);
    const px = await bsQuote(L.ctx, { spot, strike, tau: BigInt(e2! - (await now(L))), vol: await getMarkVol(L.ctx, NVDA), rate: g.rate, isCall: true });
    const q: RfqQuote = {
      signer: maker.account.address,
      makerId,
      seriesId: sid,
      makerSells: true,
      maxQty: 10n * WAD,
      price: px.price,
      deadline: BigInt((await now(L)) + 3600),
      nonce: randomNonce(),
    };
    const sig = await signQuote(maker.account, q, getRfqDomain(L.ctx));
    await send(L, taker, simulateRfqFill(L.ctx, taker.account.address, q, sig, takerId, 10n * WAD));
    const st = await getAccountState(L.ctx, makerId);
    const excess = st.equity - (st.im * 102n) / 100n;
    const out = (excess < BigInt(st.cash) ? excess : st.cash) / 10n ** 12n;
    await send(L, maker, simulateWithdraw(L.ctx, maker.account.address, makerId, tok('USDG'), out, maker.account.address));
    expect((await getAccountState(L.ctx, makerId)).liquidatable).toBe(false);

    // NVDA jumps 20%
    await pushRound(L, admin, 'NVDA', answerOf(spot) * 120n / 100n, await now(L));
    expect((await getAccountState(L.ctx, makerId)).liquidatable).toBe(true);

    const sent = await tick(k, ['liquidations']);
    expect(labels(sent)).toEqual([`startLiquidation ${makerId}`, `bidLiquidation ${makerId}`]);
    expect(sent.every((x) => x.status === 'success')).toBe(true);
    const rc = await L.client.getTransactionReceipt({ hash: sent[1]!.hash });
    const [bid] = parseEventLogs({ abi: auctionHouseAbi, eventName: 'LiquidationBid', logs: rc.logs });
    expect(bid!.args.bidderId).toBe(bidder);
    expect(bid!.args.fractionWad).toBe(g.maxFractionPerBid);
    // bid in the block after the start: the discount has barely left startDiscount
    expect(bid!.args.discountWad - g.startDiscount).toBeLessThan(g.startDiscount / 100n);
    const mine = await getPositions(L.ctx, bidder!);
    expect(mine.find((p) => p.seriesId === sid)?.qty).toBe(-5n * WAD);
    expect((await getAccountState(L.ctx, bidder!)).healthy).toBe(true);
  });

});
