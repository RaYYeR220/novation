/**
 * The tool handlers. Each takes the session and the parsed arguments and returns a JSON-safe
 * object; server.ts registers them with their schemas. Amounts go out as decimal numbers (USDG,
 * contracts, USD per token), never as raw integers.
 */
import {
  bsQuote,
  clearinghouseAbi,
  decodeRefusal,
  decodeRevertData,
  expiriesOf,
  explainTx,
  getAccountState,
  getAgentPolicy,
  getGlobals,
  getMarket,
  getMarkets,
  getMarkVol,
  getOpenInterest,
  getOpeningPaused,
  getPositionsRaw,
  getQuoteRemaining,
  getScenarioGrid,
  getSeries,
  getSession,
  getSpot,
  getUnderlyingParams,
  getUnderlyingTokens,
  getVault,
  getMarginAfter,
  listSeries,
  marketDataHubAbi,
  optionVaultAbi,
  quoteTuple,
  RefusalError,
  rfqVenueAbi,
  shockRange,
  simulateRfqFill,
  simulateVaultBuy,
  simulateVaultSellBack,
  takerCashDelta,
  tradeFee,
  WAD,
  type AccountState,
  type AgentPolicy,
  type Refusal,
  type RfqQuote,
  type SeriesInfo,
  getVolCurrent,
  simulateCatchUpVol,
  getVolState,
  MAX_VOL_SYNC_STEPS,
} from '@novation/sdk';
import {
  decodeEventLog,
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  isAddress,
  isHex,
  multicall3Abi,
  type Abi,
  type Address,
  type Hash,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import {
  isoTime,
  num,
  refusalLine,
  refusalView,
  scenarioOf,
  seriesLabel,
  seriesView,
  symbolFor,
  amountOf,
  qtyOf,
  ToolInputError,
  type RefusalView,
} from './format';
import { verifiedAgentOf, type Session } from './session';

type Num = number | string;
const abs = (x: bigint) => (x < 0n ? -x : x);

// ---------------------------------------------------------------- shared lookups

function accountOf(s: Session, given?: Num): bigint {
  if (given !== undefined) {
    const t = String(given).trim();
    if (!/^\d+$/.test(t)) throw new ToolInputError(`account must be a subaccount id, got "${given}"`);
    return BigInt(t);
  }
  if (s.accountId === undefined) throw new ToolInputError('pass an account id: the server runs without a default account');
  return s.accountId;
}

function agentOf(s: Session) {
  if (!s.agent) throw new ToolInputError('read-only mode: start the server with NOVATION_AGENT_KEY to trade');
  const v = verifiedAgentOf(s);
  if (!v) throw new Error('the agent key has not passed verifyAgent: no trading before the on-chain policy check');
  return { ...s.agent, address: v.agent, accountId: v.accountId };
}

async function now(s: Session): Promise<number> {
  return Number((await s.n.client.getBlock()).timestamp);
}

async function seriesOf(s: Session, id: number): Promise<SeriesInfo> {
  if (!Number.isInteger(id) || id <= 0) throw new ToolInputError(`series_id must be a positive integer, got ${id}`);
  const hit = s.seriesCache.get(id);
  if (hit) return hit;
  let x: SeriesInfo;
  try {
    x = await getSeries(s.n.ctx, id);
  } catch {
    throw new ToolInputError(`no series ${id}: list them with get_chain`);
  }
  if (/^0x0{40}$/i.test(x.underlying)) throw new ToolInputError(`no series ${id}: list them with get_chain`);
  s.seriesCache.set(id, x);
  return x;
}

async function underlyingOf(s: Session, given: string): Promise<Address> {
  const tokens = await getUnderlyingTokens(s.n.ctx);
  const g = given.trim();
  if (isAddress(g)) {
    const t = tokens.find((x) => x.toLowerCase() === g.toLowerCase());
    if (t) return t;
  } else {
    const t = tokens.find((x) => symbolFor(s.n.deployment, x).toLowerCase() === g.toLowerCase());
    if (t) return t;
  }
  throw new ToolInputError(`unknown underlying "${given}"; known: ${tokens.map((t) => symbolFor(s.n.deployment, t)).join(', ')}`);
}

/** The deployment's vault that sells this series' option type on its underlying, if any. */
function vaultFor(s: Session, series: SeriesInfo): { address: Address; type: 'coveredCall' | 'putWrite' } | undefined {
  const sym = symbolFor(s.n.deployment, series.underlying);
  const want = series.isCall ? 'coveredCall' : 'putWrite';
  return s.n.deployment.vaults.find((v) => v.underlying === sym && v.type === want);
}

function vaultsList(s: Session): string {
  return s.n.deployment.vaults.map((v) => `${v.underlying} ${v.type === 'coveredCall' ? 'calls' : 'puts'}`).join(', ');
}

function explorerTx(s: Session, hash: Hash): string | undefined {
  const base = s.chain.blockExplorers?.default.url;
  return base ? `${base.replace(/\/$/, '')}/tx/${hash}` : undefined;
}

function stateView(st: AccountState) {
  return {
    cash: num(st.cash),
    equity: num(st.equity),
    initialMargin: num(st.im),
    maintenanceMargin: num(st.mm),
    healthy: st.healthy,
    liquidatable: st.liquidatable,
  };
}

// ---------------------------------------------------------------- vault quotes

type QuoteReq = { seriesId: number; qty: bigint; takerBuys: boolean };
type QuoteRes = { premium: bigint } | { refusal: Refusal };

/**
 * Vault quotes. The vault only quotes while its mark vol is at the feed's latest round; buy and
 * sellBack fold pending rounds in themselves (syncVol is permissionless). When the plain view
 * refuses with VaultNotLive and the chain has Multicall3, the quotes are re-read in one eth_call
 * after syncVol, which is exactly the state the trade will price in.
 */
async function vaultQuotes(s: Session, vault: Address, token: Address, reqs: QuoteReq[]): Promise<{ results: QuoteRes[]; volSynced: boolean }> {
  if (reqs.length === 0) return { results: [], volSynced: false };
  const direct = await Promise.all(
    reqs.map(async (r): Promise<QuoteRes> => {
      try {
        return { premium: await s.n.vault.getVaultQuote(vault, r.seriesId, r.qty, r.takerBuys) };
      } catch (e) {
        const refusal = decodeRefusal(e);
        if (refusal) return { refusal };
        throw e;
      }
    }),
  );
  const mc = s.chain.contracts?.multicall3?.address;
  const stale = direct.some((d) => 'refusal' in d && (d.refusal.code === 'VaultNotLive' || d.refusal.code === 'VolNotCurrent'));
  if (!stale || !mc) return { results: direct, volSynced: false };

  const calls = [
    { target: s.n.deployment.hub, allowFailure: true, callData: encodeFunctionData({ abi: marketDataHubAbi, functionName: 'syncVol', args: [token] }) },
    ...reqs.map((r) => ({
      target: vault,
      allowFailure: true,
      callData: encodeFunctionData({ abi: optionVaultAbi, functionName: 'quote', args: [r.seriesId, r.qty, r.takerBuys] }),
    })),
  ];
  const { data } = await s.n.client.call({ to: mc, data: encodeFunctionData({ abi: multicall3Abi, functionName: 'aggregate3', args: [calls] }), batch: false });
  if (!data) return { results: direct, volSynced: false };
  const out = decodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', data });
  const results = out.slice(1).map((r): QuoteRes => {
    if (r.success) return { premium: decodeFunctionResult({ abi: optionVaultAbi, functionName: 'quote', data: r.returnData }) };
    const refusal = decodeRevertData(r.returnData) ?? { code: 'Reverted', message: 'The quote reverted.', selector: '0x', args: {}, numbers: {} };
    return { refusal };
  });
  return { results, volSynced: true };
}

const VOL_NOTE = "The vault's mark vol was behind the feed: quoted after folding the pending rounds in, as the trade itself will.";

// ---------------------------------------------------------------- list_underlyings

export async function listUnderlyings(s: Session) {
  const [markets, paused, t] = await Promise.all([getMarkets(s.n.ctx), getOpeningPaused(s.n.ctx), now(s)]);
  let mask: bigint | undefined;
  if (s.agent && s.accountId !== undefined) mask = (await getAgentPolicy(s.n.ctx, s.accountId, s.agent.account.address)).allowedMask;
  const line = markets
    .map((m) => `${m.symbol} ${m.spot === null ? 'no price' : num(m.spot, 2)} ${m.session}${m.haltReason ? ` (${m.haltReason})` : ''}`)
    .join(', ');
  return {
    summary: `${markets.length} underlyings${paused ? ', opening paused' : ''}: ${line}`,
    chainId: s.chain.id,
    time: isoTime(t),
    openingPaused: paused,
    underlyings: markets.map((m) => ({
      symbol: m.symbol,
      token: m.token,
      index: m.index,
      spot: m.spot === null ? null : num(m.spot, 4),
      session: m.session,
      tradeable: m.ok && m.params.enabled && !paused,
      ...(m.haltReason ? { haltReason: m.haltReason } : {}),
      markVol: num(m.markVol, 4),
      feedUpdatedAt: isoTime(m.feed.updatedAt),
      feedAgeSeconds: t - m.feed.updatedAt,
      ...(mask !== undefined ? { agentAllowed: ((mask >> BigInt(m.index)) & 1n) === 1n } : {}),
    })),
    note: 'Sessions: REGULAR, EXTENDED, WEEKEND, HOLIDAY widen margin shocks progressively; HALTED blocks opening trades (stale feed, paused token, corporate action).',
  };
}

// ---------------------------------------------------------------- get_chain

export async function getChain(s: Session, a: { underlying: string; expiry?: Num; type?: 'call' | 'put' | 'both'; qty?: Num }) {
  const token = await underlyingOf(s, a.underlying);
  const qty = qtyOf(a.qty ?? 1, 'qty');
  const t = await now(s);
  const all = await listSeries(s.n.ctx, { underlying: token, liveAt: t, cache: s.seriesCache });
  const expiries = expiriesOf(all);
  if (expiries.length === 0) {
    const sym = symbolFor(s.n.deployment, token);
    return { summary: `${sym}: no live series`, underlying: sym, expiries: [], series: [], note: 'No live series: the keeper lists the next weekly expiries.' };
  }
  let expiry = expiries[0] as number;
  if (a.expiry !== undefined) {
    const e = String(a.expiry).trim();
    const hit = /^\d+$/.test(e) ? expiries.find((x) => x === Number(e)) : expiries.find((x) => isoTime(x).startsWith(e));
    if (hit === undefined) throw new ToolInputError(`no live expiry ${e}; live expiries: ${expiries.map(isoTime).join(', ')}`);
    expiry = hit;
  }
  const kind = a.type ?? 'both';
  const rows = all
    .filter((x) => x.expiry === expiry && (kind === 'both' || x.isCall === (kind === 'call')))
    .sort((x, y) => Number(x.isCall) - Number(y.isCall) || Number(x.strike - y.strike));

  const [market, globals] = await Promise.all([getMarket(s.n.ctx, token, { now: t }), getGlobals(s.n.ctx)]);
  const spot = market.spot;
  const tau = BigInt(expiry - t);
  const [greeks, ois] = await Promise.all([
    Promise.all(
      rows.map((r) =>
        spot === null
          ? Promise.resolve(null)
          : bsQuote(s.n.ctx, { spot, strike: r.strike, tau, vol: market.markVol, rate: globals.rate, isCall: r.isCall }).catch(() => null),
      ),
    ),
    Promise.all(rows.map((r) => getOpenInterest(s.n.ctx, r.id))),
  ]);

  // the vault's own filters, as buy applies them: option type, tenor, distance from spot, delta band
  const vaults = new Map<string, { state: Awaited<ReturnType<typeof getVault>>; shorts: Map<number, bigint> }>();
  for (const r of rows) {
    const v = vaultFor(s, r);
    if (v && !vaults.has(v.address)) {
      const state = await getVault(s.n.ctx, v.address);
      const shorts = new Map((await getPositionsRaw(s.n.ctx, state.vaultId)).filter((p) => p.qty < 0n).map((p) => [p.seriesId, -p.qty] as const));
      vaults.set(v.address, { state, shorts });
    }
  }
  const offers = rows.map((r, i) => {
    const v = vaultFor(s, r);
    if (!v) return { vault: null, offered: false, why: 'no vault sells this type on this underlying' };
    const { state: vs, shorts } = vaults.get(v.address)!;
    const c = vs.config;
    let why: string | undefined;
    if (spot === null) why = 'no live price';
    else if (r.expiry > t + c.maxTenorDays * 86400) why = 'tenor beyond the vault maximum';
    else if (r.isCall ? r.strike < (spot * (WAD + c.minOtm)) / WAD : r.strike > (spot * (WAD - c.minOtm)) / WAD) why = 'not far enough out of the money';
    else {
      const d = greeks[i] ? abs(greeks[i]!.delta) : undefined;
      if (d === undefined) why = 'delta unavailable';
      else if (d < c.minDelta || d > c.maxDelta) why = `delta outside the vault's offer band ${num(c.minDelta, 2)}-${num(c.maxDelta, 2)}`;
    }
    return { vault: v.address, offered: why === undefined, why, short: shorts.get(r.id) ?? 0n };
  });

  // asks for offered series, bids where the vault is short enough to buy back
  const perVault = new Map<Address, { idx: number; req: QuoteReq }[]>();
  offers.forEach((o, i) => {
    if (!o.vault) return;
    const list = perVault.get(o.vault) ?? [];
    const r = rows[i] as SeriesInfo;
    if (o.offered) list.push({ idx: i, req: { seriesId: r.id, qty, takerBuys: true } });
    if ((o.short ?? 0n) >= qty) list.push({ idx: i, req: { seriesId: r.id, qty, takerBuys: false } });
    perVault.set(o.vault, list);
  });
  const asks = new Map<number, QuoteRes>();
  const bids = new Map<number, QuoteRes>();
  let synced = false;
  for (const [vault, list] of perVault) {
    const { results, volSynced } = await vaultQuotes(s, vault, token, list.map((x) => x.req));
    synced ||= volSynced;
    list.forEach((x, k) => (x.req.takerBuys ? asks : bids).set(x.idx, results[k] as QuoteRes));
  }
  const price = (q: QuoteRes | undefined) => (q && 'premium' in q ? num(q.premium) : null);
  const priceErr = (q: QuoteRes | undefined) => (q && 'refusal' in q ? String(q.refusal.code) : undefined);
  const withAsk = rows.filter((_, i) => price(asks.get(i)) !== null).length;

  return {
    summary: `${symbolFor(s.n.deployment, token)} ${isoTime(expiry).slice(0, 10)}: ${rows.length} series, ${withAsk} with a vault ask for ${num(qty)}; spot ${spot === null ? 'none' : num(spot, 2)}, ${market.session}`,
    underlying: symbolFor(s.n.deployment, token),
    spot: spot === null ? null : num(spot, 4),
    session: market.session,
    ...(market.haltReason ? { haltReason: market.haltReason } : {}),
    markVol: num(market.markVol, 4),
    expiries: expiries.map(isoTime),
    expiry: isoTime(expiry),
    qty: num(qty),
    series: rows.map((r, i) => {
      const o = offers[i]!;
      const g = greeks[i];
      const askErr = priceErr(asks.get(i));
      return {
        ...seriesView(s.n.deployment, r),
        moneyness: spot === null ? null : Math.round((Number((r.strike * 10_000n) / spot) / 10_000 - 1) * 1e4) / 1e4,
        markPrice: g ? num(g.price, 4) : null,
        delta: g ? num(g.delta, 4) : null,
        openInterest: num(ois[i] as bigint),
        vault: o.vault,
        vaultAsk: price(asks.get(i)),
        vaultBid: price(bids.get(i)),
        ...(o.vault && !o.offered ? { notOffered: o.why } : {}),
        ...(askErr ? { askRefused: askErr } : {}),
      };
    }),
    notes: [
      `vaultAsk and vaultBid are total USDG for qty ${num(qty)} contract(s), fee excluded. The vault buys back only series it is short.`,
      `Vaults on this deployment sell: ${vaultsList(s)}. Anything else trades through RFQ maker quotes (fill_rfq).`,
      ...(synced ? [VOL_NOTE] : []),
    ],
  };
}

// ---------------------------------------------------------------- quote

export async function quote(s: Session, a: { series_id: number; qty?: Num; side?: 'buy' | 'sell' }) {
  const series = await seriesOf(s, a.series_id);
  const qty = qtyOf(a.qty ?? 1, 'qty');
  const side = a.side ?? 'buy';
  const v = vaultFor(s, series);
  if (!v) throw new ToolInputError(`no vault trades ${seriesLabel(s.n.deployment, series)}; vaults sell ${vaultsList(s)}. Use fill_rfq with a maker quote.`);
  const [{ results, volSynced }, spot, globals] = await Promise.all([
    vaultQuotes(s, v.address, series.underlying, [{ seriesId: series.id, qty, takerBuys: side === 'buy' }]),
    getSpot(s.n.ctx, series.underlying),
    getGlobals(s.n.ctx),
  ]);
  const r = results[0] as QuoteRes;
  const base = { ...seriesView(s.n.deployment, series), side, qty: num(qty), vault: v.address, spot: num(spot.price, 4), session: spot.session };
  if ('refusal' in r) {
    const refusal = refusalView(r.refusal);
    return { ...base, quotable: false, refusal, summary: `NO QUOTE: ${refusalLine(refusal)}` };
  }
  const fee = tradeFee(globals, qty, spot.price, r.premium);
  const total = side === 'buy' ? r.premium + fee : r.premium - fee;
  return {
    ...base,
    quotable: true,
    premium: num(r.premium),
    pricePerContract: num((r.premium * WAD) / qty),
    fee: num(fee),
    [side === 'buy' ? 'totalCost' : 'netProceeds']: num(total),
    ...(volSynced ? { note: VOL_NOTE } : {}),
    summary: `${side === 'buy' ? 'ASK' : 'BID'} ${num(r.premium)} USDG for ${num(qty)} ${seriesLabel(s.n.deployment, series)} (fee ${num(fee)} USDG)`,
  };
}

// ---------------------------------------------------------------- what_if_margin

/**
 * The account before and after a hypothetical trade, from Clearinghouse.marginAfter (the same
 * margin procedure the trade runs), and the agent rules TradeLogic applies to it, in their order.
 */
export async function whatIfMargin(s: Session, a: { series_id: number; qty: Num; premium?: Num; account?: Num }) {
  const id = accountOf(s, a.account);
  const series = await seriesOf(s, a.series_id);
  const qty = qtyOf(a.qty, 'qty (positive buys, negative sells)', true);
  const [spot, globals, before, raw] = await Promise.all([
    getSpot(s.n.ctx, series.underlying),
    getGlobals(s.n.ctx),
    getAccountState(s.n.ctx, id),
    getPositionsRaw(s.n.ctx, id),
  ]);
  const label = seriesLabel(s.n.deployment, series);
  let premium: bigint;
  let premiumSource: string;
  let volNote: string | undefined;
  if (a.premium !== undefined) {
    premium = amountOf(a.premium, 'premium');
    premiumSource = 'given';
  } else {
    const v = vaultFor(s, series);
    if (!v) throw new ToolInputError(`no vault quotes ${label}: pass the premium (total USDG) you expect to pay or receive`);
    const { results, volSynced } = await vaultQuotes(s, v.address, series.underlying, [{ seriesId: series.id, qty: abs(qty), takerBuys: qty > 0n }]);
    const r = results[0] as QuoteRes;
    if ('refusal' in r) {
      const refusal = refusalView(r.refusal);
      return { account: id.toString(), ...seriesView(s.n.deployment, series), qty: num(qty), refusal, summary: `NO VAULT QUOTE: ${refusalLine(refusal)}. Pass a premium to price the margin anyway.` };
    }
    premium = r.premium;
    premiumSource = qty > 0n ? 'vault ask' : 'vault bid';
    if (volSynced) volNote = VOL_NOTE;
  }
  const fee = tradeFee(globals, abs(qty), spot.price, premium);
  const cashDelta = takerCashDelta(qty, premium, fee);
  let after: AccountState;
  try {
    after = await getMarginAfter(s.n.ctx, id, series.id, qty, cashDelta);
  } catch (e) {
    const r = decodeRefusal(e);
    if (!r) throw e;
    const refusal = refusalView(r);
    return { account: id.toString(), ...seriesView(s.n.deployment, series), qty: num(qty), premium: num(premium), fee: num(fee), refusal, summary: `WOULD BE REFUSED: ${refusalLine(refusal)}` };
  }

  const oldQty = raw.find((p) => p.seriesId === series.id)?.qty ?? 0n;
  const newQty = oldQty + qty;
  const opening = newQty !== 0n && (abs(newQty) > abs(oldQty) || oldQty > 0n !== newQty > 0n);
  const marginOk = after.equity >= after.im || (!opening && after.im <= before.im && after.equity + fee >= before.equity);
  const checks: { rule: string; ok: boolean; refusal: string; detail: string }[] = [
    {
      rule: 'margin',
      ok: marginOk,
      refusal: 'InsufficientMargin',
      detail: `equity ${num(after.equity)} vs initial margin ${num(after.im)} USDG after the trade${opening ? '' : ' (a pure reduction may stay below)'}`,
    },
  ];

  let agent: Record<string, unknown> | undefined;
  const who = s.agent && s.accountId === id ? s.agent.account.address : undefined;
  if (who) {
    const [p, t, tokens] = await Promise.all([getAgentPolicy(s.n.ctx, id, who), now(s), getUnderlyingTokens(s.n.ctx)]);
    const idx = tokens.findIndex((x) => x.toLowerCase() === series.underlying.toLowerCase());
    const valueGivenUp = before.equity - (after.equity + fee);
    const budgetOk = !(after.im > p.maxWorstLoss && (opening || after.im > before.im));
    checks.unshift(
      { rule: 'policy live', ok: p.expiresAt > t, refusal: 'NotAuthorized', detail: `expires ${p.expiresAt ? isoTime(p.expiresAt) : 'never granted'}` },
      { rule: 'underlying allowed', ok: idx >= 0 && ((p.allowedMask >> BigInt(idx)) & 1n) === 1n, refusal: 'AgentUnderlyingNotAllowed', detail: symbolFor(s.n.deployment, series.underlying) },
    );
    checks.push(
      {
        rule: 'risk budget',
        ok: budgetOk,
        refusal: 'AgentRiskBudgetExceeded',
        detail: `worst-case loss (initial margin) after ${num(after.im)} vs budget ${num(p.maxWorstLoss)} USDG${opening ? '' : '; a trade that does not raise it always passes'}`,
      },
      { rule: 'premium cap', ok: premium <= p.maxPremiumPerTrade, refusal: 'AgentPremiumExceeded', detail: `premium ${num(premium)} vs cap ${num(p.maxPremiumPerTrade)} USDG` },
      {
        rule: 'value drain',
        ok: valueGivenUp <= p.maxPremiumPerTrade,
        refusal: 'AgentValueDrainExceeded',
        detail: `equity given up against the mark ${num(valueGivenUp)} vs cap ${num(p.maxPremiumPerTrade)} USDG`,
      },
    );
    agent = {
      agent: who,
      budget: num(p.maxWorstLoss),
      usedBefore: num(before.im),
      usedAfter: num(after.im),
      headroomAfter: num(p.maxWorstLoss - after.im),
      premiumCap: num(p.maxPremiumPerTrade),
    };
  }
  const failed = checks.find((c) => !c.ok);
  return {
    account: id.toString(),
    ...seriesView(s.n.deployment, series),
    qty: num(qty),
    opening,
    premium: num(premium),
    premiumSource,
    fee: num(fee),
    cashChange: num(cashDelta),
    before: stateView(before),
    after: stateView(after),
    initialMarginChange: num(after.im - before.im),
    ...(agent ? { agentBudget: agent } : {}),
    checks,
    predictedRefusal: failed ? failed.refusal : null,
    ...(volNote ? { note: volNote } : {}),
    summary: failed
      ? `WOULD BE REFUSED (${failed.refusal}): ${failed.detail}`
      : `PASSES: initial margin ${num(before.im)} -> ${num(after.im)} USDG${agent ? `, budget ${agent.budget} USDG` : ''}`,
  };
}

// ---------------------------------------------------------------- portfolio

export async function portfolio(s: Session, a: { account?: Num }) {
  const id = accountOf(s, a.account);
  const [snap, grid, tokens] = await Promise.all([
    s.n.clearinghouse.getAccount(id, s.seriesCache),
    getScenarioGrid(s.n.ctx, id),
    s.n.clearinghouse.getUnderlyingsOf(id),
  ]);
  if (/^0x0{40}$/i.test(snap.owner)) throw new ToolInputError(`subaccount ${id} does not exist`);
  const ranges = await Promise.all(
    tokens.map(async (t) => {
      const [p, vol, sess] = await Promise.all([getUnderlyingParams(s.n.ctx, t), getMarkVol(s.n.ctx, t), getSession(s.n.ctx, t)]);
      return { underlying: symbolFor(s.n.deployment, t), session: sess, markVol: num(vol, 4), shockRange: num(shockRange(p, vol, sess), 4) };
    }),
  );
  let worst = 0;
  grid.forEach((c, i) => {
    if (c < (grid[worst] as bigint)) worst = i;
  });
  const w = scenarioOf(worst);
  const st = snap.state;
  return {
    account: id.toString(),
    owner: snap.owner,
    ...stateView(st),
    markToMarket: num(st.mtm),
    claimable: num(snap.claimableTotal),
    deficit: num(st.deficit),
    positions: snap.positions.map((p) => ({ ...seriesView(s.n.deployment, p), qty: num(p.qty), side: p.qty > 0n ? 'long' : 'short' })),
    collateral: snap.collateral.map((c) => ({ token: symbolFor(s.n.deployment, c.token), amount: num(c.amount) })),
    scenarioGrid: {
      worst: {
        index: worst,
        pnl: num(grid[worst] ?? 0n),
        priceMoveOfShockRange: w.priceMoveOfRange,
        vol: w.vol,
        priceMove: ranges.map((r) => ({ underlying: r.underlying, move: Math.round(w.priceMoveOfRange * r.shockRange * 1e4) / 1e4 })),
      },
      shockRanges: ranges,
      layout: 'rows: vol down, base vol, vol up; columns: price move -1 to +1 of the shock range in sixths',
      rows: [0, 1, 2].map((v) => grid.slice(v * 13, v * 13 + 13).map((c) => num(c, 2))),
    },
    summary: `account ${id}: equity ${num(st.equity)} USDG, initial margin ${num(st.im)} USDG, ${snap.positions.length} position(s); worst scenario ${num(grid[worst] ?? 0n)} USDG`,
  };
}

// ---------------------------------------------------------------- risk_budget

async function budgetOf(s: Session, id: bigint, agent: Address) {
  const [p, st, t, tokens] = await Promise.all([getAgentPolicy(s.n.ctx, id, agent), getAccountState(s.n.ctx, id), now(s), getUnderlyingTokens(s.n.ctx)]);
  return { p, st, t, tokens };
}

function policyView(s: Session, p: AgentPolicy, t: number, tokens: Address[]) {
  return {
    live: p.expiresAt > t,
    expiresAt: p.expiresAt ? isoTime(p.expiresAt) : null,
    secondsLeft: Math.max(0, p.expiresAt - t),
    budget: num(p.maxWorstLoss),
    premiumCap: num(p.maxPremiumPerTrade),
    valueDrainCap: num(p.maxPremiumPerTrade),
    allowedUnderlyings: tokens.filter((_, i) => ((p.allowedMask >> BigInt(i)) & 1n) === 1n).map((x) => symbolFor(s.n.deployment, x)),
  };
}

export async function riskBudget(s: Session, a: { account?: Num; agent?: string }) {
  const id = accountOf(s, a.account);
  let agent: Address;
  if (a.agent !== undefined) {
    if (!isAddress(a.agent)) throw new ToolInputError(`agent must be an address, got "${a.agent}"`);
    agent = getAddress(a.agent);
  } else if (s.agent) agent = s.agent.account.address;
  else throw new ToolInputError('read-only mode: pass the agent address');
  const { p, st, t, tokens } = await budgetOf(s, id, agent);
  const policy = policyView(s, p, t, tokens);
  const headroom = p.maxWorstLoss - st.im;
  return {
    account: id.toString(),
    agent,
    policy,
    used: num(st.im),
    headroom: num(headroom),
    utilization: p.maxWorstLoss === 0n ? null : Math.round((Number((st.im * 10_000n) / p.maxWorstLoss) / 10_000) * 1e4) / 1e4,
    equity: num(st.equity),
    cash: num(st.cash),
    rules: [
      "budget caps the account's worst-case loss (its initial margin) after any trade the agent opens; a trade that does not raise it always passes, so the agent can always cut risk",
      'premiumCap caps the premium of one trade',
      'valueDrainCap caps the equity one trade may give up against the kernel mark (the fee aside)',
      'the agent cannot withdraw, deposit stock collateral, grant or revoke agents',
    ],
    summary: policy.live
      ? `budget ${policy.budget} USDG, used ${num(st.im)}, headroom ${num(headroom)} USDG; premium cap ${policy.premiumCap} USDG; ${policy.allowedUnderlyings.join(', ') || 'no underlyings'} allowed until ${policy.expiresAt}`
      : `no live policy for ${agent} on account ${id}`,
  };
}

// ---------------------------------------------------------------- trading

interface Ticket {
  action: string;
  venue: 'vault' | 'rfq';
  series: SeriesInfo;
  qty: bigint;
  limit: Record<string, number>;
  simulate: () => Promise<{ request: unknown; result: bigint }>;
  call: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] };
  /** What was done before the trade (a vol catch-up), for the result. */
  note?: string;
}

export interface TradeResult {
  /**
   * filled: sent and mined. refused: the chain refused it (in simulation, or mined as a revert).
   * out_of_gas: mined but ran out of gas, which is not a policy refusal. no_quote: the vault
   * won't quote it and no explicit limit was given, so nothing was sent.
   */
  status: 'filled' | 'refused' | 'out_of_gas' | 'no_quote';
  sent: boolean;
  summary: string;
  [k: string]: unknown;
}

/** Gas headroom on agent sends: margin-check gas moves with the block timestamp. */
export const GAS_HEADROOM_PCT = 125n;
/** A revert that used this share of its gas limit or more ran out of gas (try/catch frames can leave 1/64 per level unspent). */
const OOG_SHARE_PCT = 95n;

function tradedOf(s: Session, receipt: TransactionReceipt) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== s.n.deployment.clearinghouse.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: clearinghouseAbi, data: log.data, topics: log.topics });
      if (ev.eventName === 'Traded') return ev.args as { qty: bigint; premium: bigint; fee: bigint };
    } catch {
      /* another event */
    }
  }
  return undefined;
}

/** send_even_if_refused, honoured only when the operator enabled it. */
function forceOf(s: Session, requested: boolean | undefined): boolean {
  if (!requested) return false;
  if (!s.allowForcedSend) throw new ToolInputError('send_even_if_refused is disabled on this server: the operator enables it with NOVATION_ALLOW_FORCED_SEND=1');
  return true;
}

/**
 * Simulate, then send with the estimate plus 25%. A refusal in the simulation comes back as a
 * structured Refusal and nothing is signed, unless `force`: then the same call is sent with a
 * fixed gas limit (no estimate, which would fail) so the revert is mined, and the mined revert is
 * decoded by replay. A mined revert that burned its gas limit without revert data is reported as
 * out of gas, never as a refusal.
 */
async function execute(s: Session, t: Ticket, force: boolean): Promise<TradeResult> {
  const ag = agentOf(s);
  const label = seriesLabel(s.n.deployment, t.series);
  const base = { action: t.action, venue: t.venue, account: ag.accountId.toString(), agent: ag.address, ...seriesView(s.n.deployment, t.series), qty: num(t.qty), ...t.limit };

  // signed locally with the agent key (a raw transaction), never eth_sendTransaction on the node
  const sendWith = async (gas: bigint) => {
    const hash = await ag.wallet.writeContract({
      address: t.call.address,
      abi: t.call.abi,
      functionName: t.call.functionName,
      args: t.call.args,
      gas,
      account: ag.account,
      chain: s.chain,
    } as Parameters<typeof ag.wallet.writeContract>[0]);
    const receipt = await s.n.client.waitForTransactionReceipt({ hash });
    return {
      hash,
      receipt,
      gasLimit: gas,
      tx: { txHash: hash, explorerUrl: explorerTx(s, hash), block: Number(receipt.blockNumber), gasUsed: Number(receipt.gasUsed), gasLimit: Number(gas) },
    };
  };
  type Sent = Awaited<ReturnType<typeof sendWith>>;

  const filled = async (r: Sent, note?: string): Promise<TradeResult> => {
    const traded = tradedOf(s, r.receipt);
    const { p, st, t: ts, tokens } = await budgetOf(s, ag.accountId, ag.address);
    const premium = traded?.premium;
    const fee = traded?.fee;
    return {
      status: 'filled',
      sent: true,
      ...base,
      ...r.tx,
      ...(premium !== undefined ? { premium: num(premium), fee: num(fee ?? 0n) } : {}),
      accountAfter: stateView(st),
      budget: { budget: num(p.maxWorstLoss), used: num(st.im), headroom: num(p.maxWorstLoss - st.im), live: policyView(s, p, ts, tokens).live },
      ...(note ? { note } : {}),
      summary: `FILLED: ${t.action} ${num(t.qty)} ${label}${premium !== undefined ? ` for ${num(premium)} USDG (fee ${num(fee ?? 0n)})` : ''}; initial margin ${num(st.im)} of budget ${num(p.maxWorstLoss)} USDG; tx ${r.hash}`,
    };
  };

  const reverted = async (r: Sent): Promise<TradeResult> => {
    // checked first: an inner call that runs out of gas inside a try/catch can surface as some
    // unrelated custom error, which must not read as a policy refusal
    if (r.receipt.gasUsed * 100n >= r.gasLimit * OOG_SHARE_PCT) {
      return {
        status: 'out_of_gas',
        sent: true,
        ...base,
        ...r.tx,
        refusal: null,
        summary: `OUT OF GAS: the transaction used ${r.receipt.gasUsed} of its ${r.gasLimit} gas limit and reverted. No rule refused it; retry the trade: ${r.hash}`,
      };
    }
    const why = await explainTx(s.n.ctx, r.hash).catch(() => undefined);
    if (why) {
      const refusal = refusalView(why.refusal);
      return {
        status: 'refused',
        sent: true,
        ...base,
        ...r.tx,
        refusal,
        summary: `REFUSED ON-CHAIN: ${refusalLine(refusal)}. The transaction was mined and reverted: ${r.hash}`,
      };
    }
    return {
      status: 'refused',
      sent: true,
      ...base,
      ...r.tx,
      refusal: null,
      summary: `REVERTED: the transaction was mined and reverted, and its revert data could not be recovered (explain_refusal may say more later): ${r.hash}`,
    };
  };

  return s.lock(async () => {
    let caughtUp: string | undefined;
    try {
      try {
        await t.simulate();
      } catch (e) {
        // a vol further behind its feed than the trade's own sync folds: catch it up
        // (permissionless, signed by the agent key), then simulate again, once
        if (!(e instanceof RefusalError) || e.refusal.code !== 'VolNotCurrent' || force) throw e;
        const token = (e.refusal.args.underlying as Address | undefined) ?? t.series.underlying;
        caughtUp = await catchUpVol(s, token);
        await t.simulate();
      }
    } catch (e) {
      if (!(e instanceof RefusalError)) throw e;
      const refusal = refusalView(e.refusal);
      if (!force) {
        return {
          status: 'refused',
          sent: false,
          ...base,
          refusal,
          summary: `REFUSED (not sent): ${refusalLine(refusal)}. The simulation of this exact transaction reverted, so nothing was signed or sent.`,
        };
      }
      const r = await sendWith(s.refusalGas);
      if (r.receipt.status === 'success') return filled(r, `The simulation refused (${refusal.code}) but the state moved before inclusion and the trade went through.`);
      return reverted(r);
    }
    const estimate = await s.n.client.estimateContractGas({
      address: t.call.address,
      abi: t.call.abi,
      functionName: t.call.functionName,
      args: t.call.args,
      account: ag.account,
    } as Parameters<typeof s.n.client.estimateContractGas>[0]);
    const r = await sendWith((estimate * GAS_HEADROOM_PCT) / 100n);
    const note = [t.note, caughtUp].filter(Boolean).join(' ') || undefined;
    return r.receipt.status === 'success' ? filled(r, note) : reverted(r);
  });
}

/**
 * Brings `token`'s vol up to its feed (syncVol, or syncAndRebaseVol after a feed migration, up to
 * MAX_VOL_SYNC_STEPS steps of 64 rounds), signed by the agent key: what a VolNotCurrent refusal asks
 * for. It stops as soon as a step leaves the stored round where it was, and never sends more than
 * the session's budget of catch-up transactions (NOVATION_MAX_VOL_SYNCS) in all. Returns a note for
 * the trade result.
 */
async function catchUpVol(s: Session, token: Address): Promise<string> {
  const ag = agentOf(s);
  const hashes: string[] = [];
  let stalled = false;
  for (let i = 0; i < MAX_VOL_SYNC_STEPS && s.volSyncsLeft > 0 && !(await getVolCurrent(s.n.ctx, token)); i++) {
    const before = (await getVolState(s.n.ctx, token)).lastRoundId;
    const sim = await simulateCatchUpVol(s.n.ctx, ag.account, token);
    const req = sim.request as Parameters<typeof ag.wallet.writeContract>[0];
    const gas = await s.n.client.estimateContractGas(req as Parameters<typeof s.n.client.estimateContractGas>[0]);
    const hash = await ag.wallet.writeContract({ ...req, account: ag.account, chain: s.chain, gas: (gas * GAS_HEADROOM_PCT) / 100n } as Parameters<typeof ag.wallet.writeContract>[0]);
    s.volSyncsLeft--;
    const rc = await s.n.client.waitForTransactionReceipt({ hash });
    hashes.push(hash);
    if (rc.status !== 'success' || (await getVolState(s.n.ctx, token)).lastRoundId === before) {
      stalled = true;
      break;
    }
  }
  const sym = symbolFor(s.n.deployment, token);
  if (hashes.length === 0) return `The ${sym} vol is behind its feed (VolNotCurrent), and this session's vol sync budget is spent: nothing was synced.`;
  const why = stalled ? ' A sync did not advance the vol, so the catch-up stopped.' : '';
  return `The ${sym} vol was behind its feed (VolNotCurrent): synced it first (${hashes.join(', ')}).${why}`;
}

const DEFAULT_SLIPPAGE_BPS = 200;

/**
 * The vault's quote for one trade. A vault refuses to quote (VaultNotLive) while its vol is more
 * than one sync behind the feed; with the market open, the agent catches the vol up first
 * (permissionless) and asks again. Over a weekend or a holiday the vault is closed whatever the vol.
 */
async function vaultQuoteCaughtUp(s: Session, vault: Address, series: SeriesInfo, qty: bigint, takerBuys: boolean): Promise<{ r: QuoteRes; note?: string }> {
  const ask = async () => (await vaultQuotes(s, vault, series.underlying, [{ seriesId: series.id, qty, takerBuys }])).results[0] as QuoteRes;
  const r = await ask();
  if (!('refusal' in r) || (r.refusal.code !== 'VaultNotLive' && r.refusal.code !== 'VolNotCurrent')) return { r };
  if (await getVolCurrent(s.n.ctx, series.underlying)) return { r };
  const spot = await getSpot(s.n.ctx, series.underlying).catch(() => null);
  if (!spot?.ok || (spot.session !== 'REGULAR' && spot.session !== 'EXTENDED')) return { r };
  const note = await catchUpVol(s, series.underlying);
  return { r: await ask(), note };
}

/** No readable vault quote and no explicit limit: nothing is sent, and the caller must name its limit. */
function noQuote(s: Session, series: SeriesInfo, qty: bigint, side: 'buy' | 'sell', refusal: Refusal): TradeResult {
  const r = refusalView(refusal);
  const arg = side === 'buy' ? 'max_premium' : 'min_premium';
  return {
    status: 'no_quote',
    sent: false,
    action: side,
    venue: 'vault',
    ...seriesView(s.n.deployment, series),
    qty: num(qty),
    refusal: r,
    summary: `NOT SENT: the vault won't quote this (${refusalLine(r)}), so there is no price to protect the trade. Pass ${arg} (total USDG) to send it with an explicit limit.`,
  };
}

export async function buyFromVault(s: Session, a: { series_id: number; qty: Num; max_premium?: Num; slippage_bps?: number; send_even_if_refused?: boolean }) {
  const ag = agentOf(s);
  const force = forceOf(s, a.send_even_if_refused);
  const series = await seriesOf(s, a.series_id);
  const qty = qtyOf(a.qty, 'qty (contracts to buy)');
  const v = vaultFor(s, series);
  if (!v) throw new ToolInputError(`no vault sells ${seriesLabel(s.n.deployment, series)}; vaults sell ${vaultsList(s)}. Use fill_rfq with a maker quote.`);
  let maxPremium: bigint;
  let note: string | undefined;
  if (a.max_premium !== undefined) maxPremium = amountOf(a.max_premium, 'max_premium');
  else {
    const q = await vaultQuoteCaughtUp(s, v.address, series, qty, true);
    note = q.note;
    if ('refusal' in q.r) return noQuote(s, series, qty, 'buy', q.r.refusal);
    maxPremium = (q.r.premium * (10_000n + BigInt(a.slippage_bps ?? DEFAULT_SLIPPAGE_BPS)) + 9_999n) / 10_000n;
  }
  return execute(
    s,
    {
      action: 'buy',
      venue: 'vault',
      series,
      qty,
      limit: { maxPremium: num(maxPremium) },
      simulate: () => simulateVaultBuy(s.n.ctx, ag.account, v.address, series.id, qty, maxPremium, ag.accountId),
      call: { address: v.address, abi: optionVaultAbi as Abi, functionName: 'buy', args: [series.id, qty, maxPremium, ag.accountId] },
      ...(note ? { note } : {}),
    },
    force,
  );
}

export async function sellToVault(s: Session, a: { series_id: number; qty: Num; min_premium?: Num; slippage_bps?: number; send_even_if_refused?: boolean }) {
  const ag = agentOf(s);
  const force = forceOf(s, a.send_even_if_refused);
  const series = await seriesOf(s, a.series_id);
  const qty = qtyOf(a.qty, 'qty (contracts to sell back)');
  const v = vaultFor(s, series);
  if (!v) throw new ToolInputError(`no vault buys back ${seriesLabel(s.n.deployment, series)}; use fill_rfq with a maker quote`);
  let minPremium: bigint;
  let note: string | undefined;
  if (a.min_premium !== undefined) minPremium = amountOf(a.min_premium, 'min_premium');
  else {
    const q = await vaultQuoteCaughtUp(s, v.address, series, qty, false);
    note = q.note;
    if ('refusal' in q.r) return noQuote(s, series, qty, 'sell', q.r.refusal);
    minPremium = (q.r.premium * (10_000n - BigInt(a.slippage_bps ?? DEFAULT_SLIPPAGE_BPS))) / 10_000n;
  }
  return execute(
    s,
    {
      action: 'sell',
      venue: 'vault',
      series,
      qty,
      limit: { minPremium: num(minPremium) },
      simulate: () => simulateVaultSellBack(s.n.ctx, ag.account, v.address, series.id, qty, minPremium, ag.accountId),
      call: { address: v.address, abi: optionVaultAbi as Abi, functionName: 'sellBack', args: [series.id, qty, minPremium, ag.accountId] },
      ...(note ? { note } : {}),
    },
    force,
  );
}

export interface QuoteJson {
  signer: string;
  makerId: Num;
  seriesId: Num;
  makerSells: boolean;
  maxQty: Num;
  price: Num;
  deadline: Num;
  nonce: Num;
}

const uint = (v: Num, what: string, bits = 256): bigint => {
  const t = String(v).trim();
  if (!/^\d{1,78}$/.test(t)) throw new ToolInputError(`quote.${what} must be a non-negative integer in raw on-chain units, got "${v}"`);
  const x = BigInt(t);
  if (x >= 1n << BigInt(bits)) throw new ToolInputError(`quote.${what} does not fit in uint${bits}`);
  return x;
};

/** A signed quote's JSON (integers as decimal strings, maxQty and price in WAD) into an RfqQuote. */
export function parseQuote(q: QuoteJson): RfqQuote {
  if (!isAddress(q.signer)) throw new ToolInputError(`quote.signer must be an address, got "${q.signer}"`);
  const seriesId = Number(uint(q.seriesId, 'seriesId', 32));
  return {
    signer: getAddress(q.signer),
    makerId: uint(q.makerId, 'makerId'),
    seriesId,
    makerSells: q.makerSells,
    maxQty: uint(q.maxQty, 'maxQty'),
    price: uint(q.price, 'price'),
    deadline: uint(q.deadline, 'deadline', 64),
    nonce: uint(q.nonce, 'nonce'),
  };
}

export async function fillRfq(s: Session, a: { quote: QuoteJson; signature: string; qty?: Num; send_even_if_refused?: boolean }) {
  const ag = agentOf(s);
  const force = forceOf(s, a.send_even_if_refused);
  const q = parseQuote(a.quote);
  if (!isHex(a.signature)) throw new ToolInputError('signature must be 0x-prefixed hex');
  const sig = a.signature as Hex;
  const series = await seriesOf(s, q.seriesId);
  const qty = a.qty !== undefined ? qtyOf(a.qty, 'qty') : await getQuoteRemaining(s.n.ctx, q);
  if (qty <= 0n) throw new ToolInputError('nothing left to fill on this quote (filled, cancelled or expired)');
  return execute(
    s,
    {
      action: q.makerSells ? 'buy' : 'sell',
      venue: 'rfq',
      series,
      qty,
      limit: { quotePrice: num(q.price), quoteDeadline: Number(q.deadline) },
      simulate: () => simulateRfqFill(s.n.ctx, ag.account, q, sig, ag.accountId, qty),
      call: { address: s.n.deployment.rfq, abi: rfqVenueAbi as Abi, functionName: 'fill', args: [quoteTuple(q), sig, ag.accountId, qty] },
    },
    force,
  );
}

// ---------------------------------------------------------------- explain_refusal

const KNOWN_ABIS = [optionVaultAbi, rfqVenueAbi, clearinghouseAbi] as const;

function decodeCall(input: Hex): { function: string; args: Record<string, string> } | undefined {
  for (const abi of KNOWN_ABIS) {
    try {
      const d = decodeFunctionData({ abi: abi as Abi, data: input });
      const item = (abi as Abi).find((x) => x.type === 'function' && x.name === d.functionName) as { inputs?: { name: string }[] } | undefined;
      const args: Record<string, string> = {};
      (d.args ?? []).forEach((v, i) => {
        args[item?.inputs?.[i]?.name || `arg${i}`] = typeof v === 'object' ? JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)) : String(v);
      });
      return { function: d.functionName, args };
    } catch {
      /* not this contract */
    }
  }
  return undefined;
}

export async function explainRefusal(s: Session, a: { tx_hash: string }) {
  if (!isHex(a.tx_hash) || a.tx_hash.length !== 66) throw new ToolInputError('tx_hash must be a 32-byte 0x-prefixed hash');
  const hash = a.tx_hash as Hash;
  let receipt: TransactionReceipt;
  let input: Hex;
  try {
    const [r, tx] = await Promise.all([s.n.client.getTransactionReceipt({ hash }), s.n.client.getTransaction({ hash })]);
    receipt = r;
    input = tx.input;
  } catch {
    throw new ToolInputError(`no mined transaction ${hash} on chain ${s.chain.id}`);
  }
  const base = { txHash: hash, explorerUrl: explorerTx(s, hash), block: Number(receipt.blockNumber), from: receipt.from, to: receipt.to, gasUsed: Number(receipt.gasUsed), call: decodeCall(input) };
  if (receipt.status === 'success') return { ...base, status: 'success', refusal: null, summary: `${hash} succeeded: nothing to explain` };
  const why = await explainTx(s.n.ctx, hash);
  if (!why) return { ...base, status: 'reverted', refusal: null, summary: `${hash} reverted, but its revert data could not be recovered` };
  const refusal = refusalView(why.refusal);
  return {
    ...base,
    status: 'reverted',
    refusal,
    source: why.source.kind === 'replay' ? `eth_call replay at block ${why.source.block}` : `block explorer record ${why.source.url}`,
    summary: `${hash} was refused on-chain: ${refusalLine(refusal)}`,
  };
}
