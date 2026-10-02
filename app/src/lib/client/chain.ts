import {
  WAD,
  RefusalError,
  bsQuote,
  createNovation,
  createNovationClient,
  decodeRefusal,
  erc20Abi,
  expiriesOf,
  explainTx,
  fromUnits,
  fromWad,
  getAccount,
  getAccountSettlements,
  getAccountState,
  getAgentEvents,
  getAgentPolicy,
  getAuctionEvents,
  getBlockTimes,
  getCashIndex,
  getClaimable,
  getClaims,
  getDeficit,
  getEvents,
  getExpirySettlements,
  getGlobals,
  getInsurance,
  getInsuranceEvents,
  getLiquidation,
  getDeficitSale,
  getLossesSocialized,
  getMarginAfter,
  getMarkets,
  getOpenInterest,
  getOpeningPaused,
  getOwnerOf,
  getPool,
  getPositionsRaw,
  getCash,
  convertToAssets,
  refusalMessage,
  getCollateral,
  getSettlementPrice,
  getSubaccountsOf,
  getTrades,
  getUnderlyingsOf,
  getVaultActivity,
  getVaultHolding,
  getVaultQuotesSynced,
  getVaults,
  listSeries,
  mulWad,
  nextWeeklyExpiry,
  previewWithdraw,
  proofRefusals,
  robinhoodChainTestnet,
  scenarioGridFor,
  simulateApprove,
  simulateCreateSubaccount,
  simulateDeposit,
  simulateGrantAgent,
  simulateMint,
  simulateRequestRedeem,
  simulateRevokeAgent,
  simulateRfqFill,
  verifyQuote,
  getRfqDomain,
  isAuthorized,
  quoteHash,
  rfqPremium,
  simulateVaultBuy,
  simulateVaultDeposit,
  simulateVaultSellBack,
  simulateVaultWithdraw,
  simulateWithdraw,
  symbolOf,
  takerCashDelta,
  toUnits,
  toWad,
  tokenOf,
  tradeFee,
  withGasHeadroom,
  type AccountState as ChainState,
  type AgentPolicy,
  type GlobalParams,
  type HaltReason as ChainHaltReason,
  type MarketStatus,
  type Novation,
  type NovationContext,
  type Refusal as ChainRefusal,
  type SeriesInfo,
  type VaultState,
  type RfqQuote,
} from '@novation/sdk';
import { formatUnits, zeroAddress, type Address, type Hash, type Hex, type PublicClient, type WalletClient } from 'viem';
import { sessionEventCache } from './event-cache';
import gasJson from '../../fixtures/gas.json';
import type {
  AccountExpiry,
  AccountState,
  AgentGrant,
  Auction,
  ExpiryLeg,
  ExpiryPool,
  FeedRefusal,
  FeedStatus,
  GasRow,
  InsuranceFund,
  NewGrant,
  NovationClient,
  OpenInterestRow,
  ProtocolStats,
  Quote,
  Refusal,
  ScenarioGrid,
  Series,
  Session,
  SettlementPrice,
  Underlying,
  Vault,
  VaultDetail,
  VaultHolding,
  WalletHoldings,
  WhatIfOptions,
} from './types';

/** The chain live mode reads: Robinhood Chain testnet, where the contracts are deployed. */
export const LIVE_CHAIN = robinhoodChainTestnet;
export const LIVE_RPC = process.env.NEXT_PUBLIC_RH_TESTNET_RPC || robinhoodChainTestnet.rpcUrls.default.http[0];
/** The RFQ maker relay (the mm-bot handler): GET {url}/quotes?series=&side=&qty= returns signed quotes. */
export const RFQ_URL = process.env.NEXT_PUBLIC_RFQ_URL || '/api/rfq';

/**
 * How far an RFQ price may sit on the adverse side of the kernel mark before the app refuses to sign
 * it: max(band x mark, RFQ_MIN_OFF_MARK) per contract, where band = max(NEXT_PUBLIC_RFQ_BAND (default
 * 0.2), 2 x the vault spread). The venue has no max-premium of its own, so this is the only guard.
 */
export const RFQ_BAND = rfqBand(process.env.NEXT_PUBLIC_RFQ_BAND);

/** NEXT_PUBLIC_RFQ_BAND as a fraction in (0, 1]: a mistyped `20` means 100%, not 2000%; anything else 0.2. */
export function rfqBand(raw: string | undefined): number {
  const b = Number(raw);
  return Number.isFinite(b) && b > 0 ? Math.min(b, 1) : 0.2;
}
const RFQ_MIN_OFF_MARK = 5n * 10n ** 16n; // 0.05 USDG per contract
/** A quote must outlive the click by this much, and expire within RFQ_MAX_LIFETIME. */
const RFQ_MIN_LIFETIME = 15;
const RFQ_MAX_LIFETIME = 600;
/** Relay silences and refusals are retried after this long. */
const RFQ_RETRY_MS = 8_000;

/** A maker's signed quote, as the relay sent it: only the signed fields count, never its extra numbers. */
type RelayQuote = { quote: RfqQuote; signature: Hex };
type RelayAnswer = { ok: RelayQuote } | { refusal: Refusal } | undefined;
/** A quote the ticket showed, by its digest: the only quotes fillRfq will sign. */
type ShownQuote = RelayQuote & { size: bigint; seriesId: number; side: 'buy' | 'sell'; key: string };

/** One side of the relay's JSON answer back into the RfqVenue.Quote struct, or undefined if malformed. */
function parseRelayQuote(x: unknown): RelayQuote | undefined {
  try {
    const { quote: q, signature } = x as {
      quote: { signer: string; makerId: string; seriesId: number | string; makerSells: boolean; maxQty: string; price: string; deadline: string; nonce: string };
      signature: string;
    };
    return {
      quote: {
        signer: q.signer as Address,
        makerId: BigInt(q.makerId),
        seriesId: Number(q.seriesId),
        makerSells: q.makerSells === true,
        maxQty: BigInt(q.maxQty),
        price: BigInt(q.price),
        deadline: BigInt(q.deadline),
        nonce: BigInt(q.nonce),
      },
      signature: signature as Hex,
    };
  } catch {
    return undefined;
  }
}

type ChainSeries = Series & { bid: number; ask: number; delta: number; iv: number; mark?: number };
type AccountData = Awaited<ReturnType<NovationClient['account']>>;

const HALT_TEXT: Record<ChainHaltReason, string> = {
  answer: 'Halted: the feed has no usable answer.',
  stale: 'Halted: the last print is older than this session allows.',
  paused: 'Halted: the token is paused.',
  oraclePaused: "Halted: the token's oraclePaused flag is set.",
  implausible: 'Halted: the feed prints outside its plausibility band.',
  multiplier: 'Halted: a multiplier change takes effect within the halt window.',
  sequencer: 'Halted: the sequencer uptime feed is down or in its grace period.',
};

const DAY = 86400;
const abs = (x: bigint) => (x < 0n ? -x : x);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function toState(s: ChainState): AccountState {
  return {
    cash: fromWad(s.cash),
    mtm: fromWad(s.mtm),
    settledValue: fromWad(s.settledValue),
    deficit: fromWad(s.deficit),
    equity: fromWad(s.equity),
    im: fromWad(s.im),
    mm: fromWad(s.mm),
    worstScenario: s.worstScenario,
    healthy: s.healthy,
    liquidatable: s.liquidatable,
  };
}

/** Payoff of one contract at `price` (WAD). */
function payoff(s: Pick<SeriesInfo, 'isCall' | 'strike'>, price: bigint): bigint {
  const v = s.isCall ? price - s.strike : s.strike - price;
  return v > 0n ? v : 0n;
}

/** An SDK refusal turned into the numbers the refusal cards read. */
function appRefusal(
  r: ChainRefusal,
  c: { premium?: bigint; fee?: bigint; before?: ChainState; policy?: AgentPolicy; sell?: boolean } = {},
): Refusal {
  const numbers: Record<string, number> = { ...r.numbers };
  if (r.code === 'AgentRiskBudgetExceeded' && c.before) numbers.used = fromWad(c.before.im);
  if (r.code === 'AgentPremiumExceeded') {
    if (c.premium !== undefined) numbers.premium = fromWad(c.premium);
    if (c.policy) numbers.cap = fromWad(c.policy.maxPremiumPerTrade);
  }
  if (r.code === 'InsufficientCash' && r.numbers.cash !== undefined && r.numbers.wad !== undefined) {
    // cash after: what was there less what the debit asked for
    const cash = r.numbers.cash - r.numbers.wad;
    if (c.sell) {
      // a sale is credited the premium first, then debited the fee (TradeLogic step 6)
      return { code: r.code, message: r.message, numbers: { cash, premium: c.premium !== undefined ? fromWad(c.premium) : 0, fee: r.numbers.wad, sell: 1 } };
    }
    const premium = c.premium !== undefined ? fromWad(c.premium) : r.numbers.wad;
    const fee = c.fee !== undefined ? fromWad(c.fee) : 0;
    return { code: r.code, message: r.message, numbers: { cash, premium, fee } };
  }
  return { code: r.code, message: r.message, numbers };
}

/** The refusal behind an error thrown by a write, or undefined. */
export function refusalOf(e: unknown): Refusal | undefined {
  if (e instanceof RefusalError) return appRefusal(e.refusal);
  const r = decodeRefusal(e);
  return r ? appRefusal(r) : undefined;
}

/**
 * NovationClient on the deployed contracts (RH Chain testnet), through @novation/sdk. Every figure
 * is read from the chain: kernel marks, margin and scenario grids come from the risk kernel itself,
 * the what-if from Clearinghouse.marginAfter and a simulation of the exact transaction. History the
 * chain doesn't keep (NAV series, halt episodes) comes back empty, never invented.
 */
export class ChainClient implements NovationClient {
  readonly n: Novation;
  readonly ctx: NovationContext;
  readonly chainId = LIVE_CHAIN.id;
  private signerWallet: WalletClient | undefined;
  private readonly seriesCache = new Map<number, SeriesInfo>();
  private readonly memos = new Map<string, { at: number; p: Promise<unknown> }>();
  private readonly rfqCache = new Map<string, { until: number; p: Promise<RelayAnswer> }>();
  private readonly shown = new Map<Hex, ShownQuote>();

  constructor(opts: { rpcUrl?: string; client?: PublicClient } = {}) {
    const client = opts.client ?? createNovationClient({ chain: LIVE_CHAIN, rpcUrl: opts.rpcUrl ?? LIVE_RPC });
    // scanned event ranges survive reloads in this tab, so a page fetches only new blocks
    this.n = createNovation({ client, chainId: LIVE_CHAIN.id, eventCache: sessionEventCache(`novation:logs:${LIVE_CHAIN.id}`) });
    this.ctx = this.n.ctx;
  }

  /** The connected wallet that signs this client's writes (wagmi's wallet client), or none. */
  setWallet(w: WalletClient | undefined) {
    this.signerWallet = w;
  }

  get walletAddress(): Address | undefined {
    return this.signerWallet?.account?.address;
  }

  // ---------------------------------------------------------------- shared reads

  private memo<T>(key: string, ttlMs: number, f: () => Promise<T>): Promise<T> {
    const hit = this.memos.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.p as Promise<T>;
    const p = f();
    this.memos.set(key, { at: Date.now(), p });
    p.catch(() => this.memos.delete(key));
    return p;
  }

  /** Forget cached reads: after a transaction, everything may have moved. */
  invalidate() {
    this.memos.clear();
  }

  private now(): Promise<number> {
    return this.memo('now', 3_000, async () => Number((await this.ctx.client.getBlock()).timestamp));
  }

  private globals(): Promise<GlobalParams> {
    return this.memo('globals', 300_000, () => getGlobals(this.ctx));
  }

  private markets(): Promise<MarketStatus[]> {
    return this.memo('markets', 10_000, async () => getMarkets(this.ctx, { now: await this.now() }));
  }

  private async market(tokenOrSymbol: string): Promise<MarketStatus> {
    const ms = await this.markets();
    const t = tokenOrSymbol.toLowerCase();
    const m = ms.find((x) => x.symbol.toLowerCase() === t || x.token.toLowerCase() === t);
    if (!m) throw new Error(`unknown underlying ${tokenOrSymbol}`);
    return m;
  }

  private allSeries(): Promise<SeriesInfo[]> {
    return this.memo('series', 30_000, () => listSeries(this.ctx, { cache: this.seriesCache }));
  }

  private async seriesInfo(id: number): Promise<SeriesInfo> {
    const s = this.seriesCache.get(id) ?? (await this.allSeries()).find((x) => x.id === id);
    if (!s) throw new Error(`unknown series ${id}`);
    return s;
  }

  /**
   * Vault states. `live` is the vault's isLive() once the feed's pending rounds are folded into the
   * mark vol, which every vault operation does first: a vault a poke behind still takes deposits.
   */
  private vaultStates(): Promise<VaultState[]> {
    return this.memo('vaults', 10_000, async () => {
      const vs = await getVaults(this.ctx);
      return Promise.all(
        vs.map(async (v) => (v.live ? v : { ...v, live: (await getVaultQuotesSynced(this.ctx, v.address, [], WAD).catch(() => ({ live: false }))).live })),
      );
    });
  }

  private trades() {
    return this.memo('trades', 15_000, () => getTrades(this.ctx));
  }

  private decimals(token: Address): Promise<number> {
    return this.memo(`dec:${token}`, 3_600_000, async () =>
      Number(await this.ctx.client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' })),
    );
  }

  private sym(token: Address): string {
    return symbolOf(this.ctx.deployment, token) ?? short(token);
  }

  /** The live vault of the series' kind (covered call for calls, put write for puts) on its underlying. */
  private async vaultFor(s: Pick<SeriesInfo, 'underlying' | 'isCall'>): Promise<VaultState | undefined> {
    const vs = await this.vaultStates();
    return vs.find((v) => v.live && v.underlying.toLowerCase() === s.underlying.toLowerCase() && (v.kind === 'coveredCall') === s.isCall);
  }

  /** The vault's own sale rules (OptionVaultBase.buy): type, moneyness, tenor and the delta band. */
  private sells(v: VaultState, s: SeriesInfo, spot: bigint, delta: bigint, now: number): boolean {
    const c = v.config;
    if (s.expiry > now + c.maxTenorDays * DAY) return false;
    if (v.kind === 'coveredCall' ? s.strike < mulWad(spot, WAD + c.minOtm) : s.strike > mulWad(spot, WAD - c.minOtm)) return false;
    const a = abs(delta);
    return a >= c.minDelta && a <= c.maxDelta;
  }

  private async mark(s: SeriesInfo, m: MarketStatus, now: number, g: GlobalParams): Promise<{ price: bigint; delta: bigint } | undefined> {
    const spot = m.spot ?? m.feedPrice;
    if (spot === null) return undefined;
    if (s.expiry <= now) {
      const st = await getSettlementPrice(this.ctx, s.underlying, s.expiry);
      return { price: payoff(s, st.settled ? st.price : spot), delta: 0n };
    }
    const q = await bsQuote(this.ctx, { spot, strike: s.strike, tau: BigInt(s.expiry - now), vol: m.markVol, rate: g.rate, isCall: s.isCall });
    return { price: q.price, delta: q.delta };
  }

  // ---------------------------------------------------------------- NovationClient

  asOf(): Promise<number> {
    return this.now();
  }

  async underlyings(): Promise<Underlying[]> {
    const ms = await this.markets();
    return ms.map((m) => ({
      address: m.token,
      symbol: m.symbol,
      name: m.name,
      spot: m.spot !== null ? fromWad(m.spot) : m.feedPrice !== null ? fromWad(m.feedPrice) : Number.NaN,
      session: m.session,
      markVol: fromWad(m.markVol),
      uiMultiplier: fromWad(m.uiMultiplier),
      halted: m.session === 'HALTED',
      ...(m.haltReason ? { haltReason: HALT_TEXT[m.haltReason] } : {}),
    }));
  }

  async chain(underlying: string, expiry?: number) {
    const [m, all, now, g] = await Promise.all([this.market(underlying), this.allSeries(), this.now(), this.globals()]);
    const live = all.filter((s) => s.underlying.toLowerCase() === m.token.toLowerCase() && s.expiry > now);
    const expiries = expiriesOf(live);
    const pick = expiry === undefined ? live : live.filter((s) => s.expiry === expiry);
    const spot = m.spot ?? m.feedPrice;
    // one lens call per vault: quotes as the vault's next operation would price them
    const lens = async (isCall: boolean) => {
      const v = await this.vaultFor({ underlying: m.token, isCall });
      const ids = pick.filter((s) => s.isCall === isCall).map((s) => s.id);
      if (!v || ids.length === 0) return undefined;
      const r = await getVaultQuotesSynced(this.ctx, v.address, ids, WAD).catch(() => undefined);
      return r && { v, q: new Map(r.quotes.map((x) => [x.seriesId, x])) };
    };
    const [calls, puts] = await Promise.all([lens(true), lens(false)]);
    const series: ChainSeries[] = await Promise.all(
      pick.map(async (s) => {
        const mk = await this.mark(s, m, now, g);
        const l = s.isCall ? calls : puts;
        const q = l?.q.get(s.id);
        const ask = l && q?.ask !== undefined && spot !== null && mk && this.sells(l.v, s, spot, mk.delta, now) ? fromWad(q.ask) : Number.NaN;
        const bid = q?.bid !== undefined ? fromWad(q.bid) : Number.NaN;
        return {
          id: s.id,
          underlying: m.symbol,
          expiry: s.expiry,
          strike: fromWad(s.strike),
          isCall: s.isCall,
          bid,
          ask,
          delta: mk ? fromWad(mk.delta) : Number.NaN,
          iv: fromWad(m.markVol),
          ...(mk ? { mark: fromWad(mk.price) } : {}),
        };
      }),
    );
    return { expiries, series: series.sort((a, b) => a.expiry - b.expiry || a.strike - b.strike || Number(b.isCall) - Number(a.isCall)) };
  }

  async account(id: number): Promise<AccountData> {
    const [snap, now, g] = await Promise.all([getAccount(this.ctx, id, this.seriesCache), this.now(), this.globals()]);
    if (snap.owner === zeroAddress) throw new Error(`Account ${id} does not exist on RH Chain testnet.`);
    const positions = await Promise.all(
      snap.positions.map(async (p) => {
        const m = await this.market(p.underlying);
        const mk = await this.mark(p, m, now, g);
        return {
          seriesId: p.seriesId,
          qty: fromWad(p.qty),
          mark: mk ? fromWad(mk.price) : Number.NaN,
          id: p.seriesId,
          underlying: m.symbol,
          expiry: p.expiry,
          strike: fromWad(p.strike),
          isCall: p.isCall,
        };
      }),
    );
    const collateral: Record<string, number> = {};
    for (const c of snap.collateral) collateral[this.sym(c.token)] = fromWad(c.amount);
    return { id, owner: snap.owner, state: toState(snap.state), positions, collateral };
  }

  async scenarioGrid(id: number, session?: Session): Promise<ScenarioGrid> {
    const [now, g] = await Promise.all([this.now(), this.globals()]);
    const r = await scenarioGridFor(this.ctx, id, { session, now, globals: g, seriesCache: this.seriesCache });
    const shock: Record<string, number> = {};
    for (const x of r.shockRange) shock[this.sym(x.token)] = fromWad(x.range);
    let label: Session = session ?? 'REGULAR';
    if (!session && r.input.tokens[0]) label = (await this.market(r.input.tokens[0])).session;
    return { session: label, cells: r.cells.map(fromWad), shockRange: shock, im: fromWad(r.out.lossIM) };
  }

  /**
   * The ticket before signing, from the chain. Margin after the trade is Clearinghouse.marginAfter
   * (with TradeLogic's fee at today's spot); the after-trade grid is the kernel's. A vault ticket
   * takes the vault's own premium for that size and simulates the exact buy or sellBack from the
   * signer (the owner, or the agent), so any refusal is the one the chain would give. An RFQ ticket
   * has no maker quote to simulate here; it runs TradeLogic's taker-side checks on the same numbers.
   */
  async whatIf(id: number, seriesId: number, qtyDelta: number, premium: number, opts: WhatIfOptions = {}): Promise<Quote> {
    if (!Number.isFinite(qtyDelta) || qtyDelta === 0) throw new RangeError('qtyDelta must be a non-zero number');
    const [s, g, now, owner, before, raw] = await Promise.all([
      this.seriesInfo(seriesId),
      this.globals(),
      this.now(),
      getOwnerOf(this.ctx, id),
      getAccountState(this.ctx, id),
      getPositionsRaw(this.ctx, id),
    ]);
    if (owner === zeroAddress) throw new Error(`Account ${id} does not exist on RH Chain testnet.`);
    const m = await this.market(s.underlying);
    const spot = m.spot ?? m.feedPrice ?? 0n;
    const qty = toWad(Number(qtyDelta.toFixed(6)));
    const size = abs(qty);
    // who would sign: the agent picked on the ticket, else the connected wallet, else (just
    // looking) the owner. Anyone but the owner needs a live grant, which the checks below read.
    const actor = (opts.agent as Address | undefined) ?? this.walletAddress ?? owner;
    const agent = actor.toLowerCase() === owner.toLowerCase() ? undefined : actor;
    const policy = agent ? await getAgentPolicy(this.ctx, id, agent) : undefined;

    let premiumW = toWad(Math.max(0, Number(premium.toFixed(6))));
    let refusal: Refusal | undefined;
    const vault = opts.venue === 'vault' ? await this.vaultFor(s) : undefined;
    if (vault) {
      // the vault's own premium for this size, after the vol sync its buy or sellBack runs first
      const q = (await getVaultQuotesSynced(this.ctx, vault.address, [s.id], size)).quotes[0];
      const p = qty > 0n ? q?.ask : q?.bid;
      const why = qty > 0n ? q?.askRefusal : q?.bidRefusal;
      if (p !== undefined) premiumW = p;
      else refusal = why ? appRefusal(why, { before }) : { code: 'VaultNotLive', message: refusalMessage('VaultNotLive') };
    }
    // an RFQ ticket takes the relay's signed quote for this size, when a relay answers; the
    // premium is what the venue will charge for the signed price, never the relay's own figure
    let signed: (RelayQuote & { hash: Hex }) | undefined;
    if (opts.venue === 'rfq') {
      const side = qty > 0n ? 'buy' : 'sell';
      const relay = await this.rfqQuote(s.id, side, size, now);
      if (relay && 'refusal' in relay) refusal = relay.refusal;
      else if (relay) {
        const off = await this.offMarket(s, m, relay.ok.quote, side, now, g);
        if (off) refusal = off;
        else {
          premiumW = rfqPremium(relay.ok.quote, size);
          const hash = quoteHash(this.ctx, relay.ok.quote);
          signed = { ...relay.ok, hash };
          this.shown.set(hash, { ...relay.ok, size, seriesId: s.id, side, key: this.rfqKey(s.id, side, size) });
        }
      }
    }
    const fee = tradeFee(g, size, spot, premiumW);
    const cashDelta = takerCashDelta(qty, premiumW, fee);

    // margin after, the after-trade grid and (for a vault) the exact transaction, all at once
    const marginAfter = async (): Promise<{ after: ChainState; cashShort?: Refusal }> => {
      try {
        return { after: await getMarginAfter(this.ctx, id, s.id, qty, cashDelta) };
      } catch (e) {
        const r = decodeRefusal(e);
        if (r?.code !== 'InsufficientCash') throw e;
        const pos = await getMarginAfter(this.ctx, id, s.id, qty, 0n);
        const equity = pos.equity + cashDelta;
        return {
          after: { ...pos, cash: pos.cash + cashDelta, equity, healthy: equity >= pos.im, liquidatable: equity < pos.mm },
          cashShort: {
            code: 'InsufficientCash',
            message: r.message,
            numbers: { cash: fromWad(before.cash + cashDelta), premium: fromWad(premiumW), fee: fromWad(fee), ...(qty < 0n ? { sell: 1 } : {}) },
          },
        };
      }
    };
    const simulate = async (): Promise<Refusal | undefined> => {
      if (refusal || (!vault && !signed)) return undefined;
      const signer = actor;
      try {
        if (signed) await simulateRfqFill(this.ctx, signer, signed.quote, signed.signature, id, size);
        else if (qty > 0n) await simulateVaultBuy(this.ctx, signer, vault!.address, s.id, size, premiumW, id);
        else await simulateVaultSellBack(this.ctx, signer, vault!.address, s.id, size, premiumW, id);
        return undefined;
      } catch (e) {
        if (!(e instanceof RefusalError)) throw e;
        return appRefusal(e.refusal, { premium: premiumW, fee, before, policy, sell: qty < 0n });
      }
    };
    const [{ after, cashShort }, grid, simulated] = await Promise.all([
      marginAfter(),
      scenarioGridFor(this.ctx, id, { whatIf: { seriesId: s.id, qtyDelta: qty }, now, globals: g, seriesCache: this.seriesCache }),
      simulate(),
    ]);

    if (vault || signed) {
      refusal = refusal ?? simulated;
    } else if (!refusal) {
      refusal = await this.takerChecks({ id, s, m, qty, size, premiumW, fee, before, after, raw, g, now, policy, agent, cashShort });
    }

    return {
      premium: fromWad(premiumW),
      fee: fromWad(fee),
      after: toState(after),
      ...(refusal ? { refusal } : {}),
      afterGrid: grid.cells.map(fromWad),
      approx: false,
      ...(signed
        ? { rfq: { maker: signed.quote.signer, makerId: Number(signed.quote.makerId), expiresAt: Number(signed.quote.deadline), hash: signed.hash, price: fromWad(signed.quote.price) } }
        : {}),
    };
  }

  private rfqKey(seriesId: number, side: 'buy' | 'sell', size: bigint) {
    return `${seriesId}:${side}:${size}`;
  }

  /**
   * A signed maker quote for `size` (WAD) contracts from the RFQ relay, kept only if it is for this
   * series and side, covers the size, lives between RFQ_MIN_LIFETIME and RFQ_MAX_LIFETIME seconds
   * and verifies against this deployment's venue; the relay's refusal; or undefined when no relay
   * answers. A quote is reused until shortly before its deadline, anything else for RFQ_RETRY_MS.
   */
  async rfqQuote(seriesId: number, side: 'buy' | 'sell', size: bigint, now: number): Promise<RelayAnswer> {
    const key = this.rfqKey(seriesId, side, size);
    const hit = this.rfqCache.get(key);
    if (hit && Date.now() < hit.until) return hit.p;
    const refuse = (code: string, message: string): RelayAnswer => ({ refusal: { code, message } });
    const p = (async (): Promise<RelayAnswer> => {
      try {
        const base = RFQ_URL.replace(/[/]$/, '');
        const qty = formatUnits(size, 18);
        const r = await fetch(`${base}/quotes?series=${seriesId}&side=${side}&qty=${qty}`, { headers: { accept: 'application/json' } });
        if (r.status !== 200 && r.status !== 422) return undefined;
        const j = (await r.json()) as { quotes?: unknown[]; refusals?: { side: string; code: string; message: string }[] };
        const raw = j.quotes?.find((x) => (x as { side?: string }).side === side);
        if (!raw) {
          const no = j.refusals?.find((x) => x.side === side);
          return no ? refuse(no.code, `The maker relay quotes no ${side === 'buy' ? 'ask' : 'bid'}: ${no.message}`) : undefined;
        }
        const q = parseRelayQuote(raw);
        if (!q || q.quote.seriesId !== seriesId || q.quote.makerSells !== (side === 'buy')) return refuse('QuoteMismatch', 'The relay sent a quote for another series or side.');
        if (q.quote.maxQty < size) return refuse('QuoteTooSmall', `The maker quotes at most ${fromWad(q.quote.maxQty)} contracts.`);
        const life = Number(q.quote.deadline) - now;
        if (life < RFQ_MIN_LIFETIME) return refuse('QuoteExpired', 'The quote expires before it could be signed.');
        if (life > RFQ_MAX_LIFETIME) return refuse('QuoteTooLong', `The quote stays open ${life} s; this app signs only quotes that expire within ${RFQ_MAX_LIFETIME} s.`);
        if (!(await verifyQuote(q.quote, q.signature, getRfqDomain(this.ctx)))) return refuse('BadSignature', "The quote's signature does not verify against the RFQ venue.");
        return { ok: q };
      } catch {
        return undefined;
      }
    })();
    this.rfqCache.set(key, { until: Date.now() + RFQ_RETRY_MS, p });
    p.then((v) => {
      if (v && 'ok' in v) this.rfqCache.set(key, { until: Date.now() + (Number(v.ok.quote.deadline) - now - RFQ_MIN_LIFETIME) * 1000, p });
    });
    return p;
  }

  /** A refusal when the quote's price sits beyond the band on the adverse side of the kernel mark. */
  private async offMarket(s: SeriesInfo, m: MarketStatus, q: RfqQuote, side: 'buy' | 'sell', now: number, g: GlobalParams): Promise<Refusal | undefined> {
    const mk = await this.mark(s, m, now, g);
    if (!mk) return { code: 'NoMark', message: 'The kernel cannot mark this series right now, so an RFQ price cannot be checked.' };
    const spread = (await this.vaultStates()).find((v) => v.underlying.toLowerCase() === s.underlying.toLowerCase())?.config.spread ?? 0n;
    const bandWad = toWad(RFQ_BAND) > 2n * spread ? toWad(RFQ_BAND) : 2n * spread;
    const byBand = mulWad(mk.price, bandWad);
    const limit = byBand > RFQ_MIN_OFF_MARK ? byBand : RFQ_MIN_OFF_MARK;
    const bad = side === 'buy' ? q.price > mk.price + limit : q.price + limit < mk.price;
    if (!bad) return undefined;
    const price = fromWad(q.price);
    const mark = fromWad(mk.price);
    const bound = side === 'buy' ? mark + fromWad(limit) : Math.max(0, mark - fromWad(limit));
    return {
      code: 'QuoteOffMarket',
      message: `The maker ${side === 'buy' ? 'asks' : 'bids'} ${price.toFixed(2)} per contract against a kernel mark of ${mark.toFixed(2)}. This app signs RFQ prices at most ${(fromWad(bandWad) * 100).toFixed(0)}% (or 0.05) ${side === 'buy' ? 'above' : 'below'} the mark, so up to ${bound.toFixed(2)}.`,
      numbers: { price, mark, limit: bound },
    };
  }

  /** TradeLogic's checks on the taker side, in its order, on chain figures. */
  private async takerChecks(a: {
    id: number;
    s: SeriesInfo;
    m: MarketStatus;
    qty: bigint;
    size: bigint;
    premiumW: bigint;
    fee: bigint;
    before: ChainState;
    after: ChainState;
    raw: { seriesId: number; qty: bigint }[];
    g: GlobalParams;
    now: number;
    policy?: AgentPolicy;
    agent?: Address;
    cashShort?: Refusal;
  }): Promise<Refusal | undefined> {
    const { s, m, qty, size, premiumW, fee, before, after, g, policy } = a;
    const msg = refusalMessage;
    // 1. series and size
    if (s.expiry <= a.now) return { code: 'SeriesExpired', message: msg('SeriesExpired') };
    if (size < g.minTradeQty) return { code: 'QtyTooSmall', message: msg('QtyTooSmall') };
    // 2. who acts, and the position left
    if (a.agent) {
      if (!policy || policy.expiresAt <= a.now) return { code: 'NotAuthorized', message: msg('NotAuthorized'), numbers: { id: a.id } };
      if (((policy.allowedMask >> BigInt(m.index)) & 1n) === 0n) return { code: 'AgentUnderlyingNotAllowed', message: msg('AgentUnderlyingNotAllowed') };
    }
    const held = a.raw.find((p) => p.seriesId === s.id)?.qty ?? 0n;
    const next = held + qty;
    if (next !== 0n && abs(next) < g.minTradeQty) return { code: 'DustPosition', message: msg('DustPosition'), numbers: { id: a.id, qty: fromWad(next) } };
    const opening = next !== 0n && (abs(next) > abs(held) || held > 0n !== next > 0n);
    // 3. opening gates
    const paused = await getOpeningPaused(this.ctx);
    const blocked = !m.params.enabled || paused || m.session === 'HALTED' || before.deficit > 0n;
    if (opening && !m.params.enabled) return { code: 'UnderlyingDisabled', message: msg('UnderlyingDisabled') };
    if (opening && blocked) return { code: 'OpeningNotAllowed', message: msg('OpeningNotAllowed'), numbers: { id: a.id } };
    // 5. long open interest (the taker's side of it; the maker's position isn't known here)
    const longUp = (next > 0n ? next : 0n) - (held > 0n ? held : 0n);
    if (longUp > 0n) {
      const oi = await getOpenInterest(this.ctx, s.id);
      if (oi + longUp > m.params.maxOpenInterest) return { code: 'OpenInterestCap', message: msg('OpenInterestCap') };
    }
    // 6. premium and fee
    if (a.cashShort) return a.cashShort;
    if (!opening && blocked && after.im > before.im)
      return { code: 'RiskIncreaseNotAllowed', message: msg('RiskIncreaseNotAllowed'), numbers: { id: a.id, im: fromWad(after.im), preIm: fromWad(before.im) } };
    if (after.equity < after.im && !(!opening && after.im <= before.im && after.equity + fee >= before.equity))
      return { code: 'InsufficientMargin', message: msg('InsufficientMargin'), numbers: { id: a.id, im: fromWad(after.im), equity: fromWad(after.equity) } };
    if (policy && a.agent) {
      if (after.im > policy.maxWorstLoss && (opening || after.im > before.im))
        return {
          code: 'AgentRiskBudgetExceeded',
          message: msg('AgentRiskBudgetExceeded'),
          numbers: { id: a.id, worstLoss: fromWad(after.im), budget: fromWad(policy.maxWorstLoss), used: fromWad(before.im) },
        };
      if (premiumW > policy.maxPremiumPerTrade)
        return { code: 'AgentPremiumExceeded', message: msg('AgentPremiumExceeded'), numbers: { premium: fromWad(premiumW), cap: fromWad(policy.maxPremiumPerTrade) } };
      const loss = before.equity - (after.equity + fee);
      if (loss > policy.maxPremiumPerTrade)
        return { code: 'AgentValueDrainExceeded', message: msg('AgentValueDrainExceeded'), numbers: { id: a.id, loss: fromWad(loss), cap: fromWad(policy.maxPremiumPerTrade) } };
    }
    return undefined;
  }

  async vaults(): Promise<Vault[]> {
    const [vs, ms] = await Promise.all([this.vaultStates(), this.markets()]);
    return vs.map((v) => this.vaultRow(v, ms));
  }

  private vaultRow(v: VaultState, ms: MarketStatus[]): Vault {
    const m = ms.find((x) => x.token.toLowerCase() === v.underlying.toLowerCase());
    const spot = m?.spot ?? m?.feedPrice ?? 0n;
    const assets = fromUnits(v.totalAssets, v.assetDecimals);
    const locked = fromUnits(v.lockedAssets, v.assetDecimals);
    const free = fromUnits(v.freeAssets, v.assetDecimals);
    return {
      address: v.address,
      kind: v.kind,
      underlying: m?.symbol ?? this.sym(v.underlying),
      tvl: v.kind === 'coveredCall' ? assets * fromWad(spot) : assets,
      nav: fromUnits(v.assetsPerShare, v.assetDecimals),
      // a 7-day APY needs the NAV of a week ago; the chain keeps no NAV history
      apy7d: Number.NaN,
      utilization: locked + free > 0 ? locked / (locked + free) : 0,
      epoch: Number(v.epoch),
      live: v.live,
    };
  }

  async agents(id: number): Promise<AgentGrant[]> {
    const [events, tokens, st, now] = await Promise.all([
      getAgentEvents(this.ctx, BigInt(id)),
      this.markets(),
      getAccountState(this.ctx, id),
      this.now(),
    ]);
    const current = new Map<string, Address>();
    for (const e of events) {
      const agent = e.args.agent as Address;
      if (e.eventName === 'AgentGranted') current.set(agent.toLowerCase(), agent);
      else current.delete(agent.toLowerCase());
    }
    const grants = await Promise.all(
      [...current.values()].map(async (agent) => {
        const p = await getAgentPolicy(this.ctx, id, agent);
        return {
          agent,
          label: `Agent ${agent.slice(2, 6)}`,
          maxWorstLoss: fromWad(p.maxWorstLoss),
          maxPremiumPerTrade: fromWad(p.maxPremiumPerTrade),
          allowed: tokens.filter((t) => ((p.allowedMask >> BigInt(t.index)) & 1n) === 1n).map((t) => t.symbol),
          expiresAt: p.expiresAt,
          used: fromWad(st.im),
        } satisfies AgentGrant;
      }),
    );
    return grants.filter((g) => g.expiresAt > 0).sort((a, b) => Number(b.expiresAt > now) - Number(a.expiresAt > now) || a.agent.localeCompare(b.agent));
  }

  async protocol(): Promise<ProtocolStats> {
    const [oi, vaults, ins, trades, now, auctions, social] = await Promise.all([
      this.openInterest(),
      this.vaults(),
      getInsurance(this.ctx),
      this.trades(),
      this.now(),
      getAuctionEvents(this.ctx),
      getLossesSocialized(this.ctx),
    ]);
    const times = await getBlockTimes(this.ctx, [...trades, ...auctions.started].map((t) => t.blockNumber));
    const weekAgo = now - 7 * DAY;
    const recent = (b: bigint) => (times.get(b) ?? 0) >= weekAgo;
    return {
      openInterestUsd: oi.reduce((a, r) => a + r.notionalUsd, 0),
      vaultTvlUsd: vaults.reduce((a, v) => a + v.tvl, 0),
      insuranceFundUsd: fromWad(ins.balance),
      premium7dUsd: trades.filter((t) => recent(t.blockNumber)).reduce((a, t) => a + fromWad(t.args.premium as bigint), 0),
      liquidations7d: auctions.started.filter((e) => recent(e.blockNumber)).length,
      socializedUsd: social.reduce((a, e) => a + fromWad(e.args.amount as bigint), 0),
    };
  }

  /** Measured benchmarks (docs/gas.md), the same table in both modes: they are not chain state. */
  async gasTable(): Promise<GasRow[]> {
    return structuredClone(gasJson.rows);
  }

  /**
   * The refused transactions the end-to-end proof sent to this deployment, decoded from the chain
   * (replayed, or read from the explorer's record once the node has pruned that state). Reverted
   * transactions emit no events, so other refusals need an indexer.
   */
  async refusalsFeed(): Promise<FeedRefusal[]> {
    const proofs = proofRefusals(this.chainId);
    const out = await Promise.all(
      proofs.map(async (p) => {
        const why = await explainTx(this.ctx, p.tx).catch(() => undefined);
        if (!why) return undefined;
        const block = await this.ctx.client.getBlock({ blockNumber: why.block });
        const r = appRefusal(why.refusal);
        const account = why.refusal.numbers.id;
        return {
          ...r,
          at: Number(block.timestamp),
          txHash: p.tx,
          ...(account !== undefined ? { account } : {}),
          ...(r.code.startsWith('Agent') ? { agent: why.from } : {}),
          detail: p.label.replace(/^\d+\s+/, ''),
        } satisfies FeedRefusal;
      }),
    );
    return out.filter((x): x is NonNullable<typeof x> => x !== undefined).sort((a, b) => b.at - a.at);
  }

  async vault(address: string): Promise<VaultDetail> {
    const [vs, ms, now] = await Promise.all([this.vaultStates(), this.markets(), this.now()]);
    const v = vs.find((x) => x.address.toLowerCase() === address.toLowerCase());
    if (!v) throw new Error(`unknown vault ${address}`);
    const m = ms.find((x) => x.token.toLowerCase() === v.underlying.toLowerCase());
    if (!m) throw new Error(`no market for ${v.underlying}`);
    const g = await this.globals();
    const [cash, collateral, positions, activity, launch] = await Promise.all([
      getCash(this.ctx, v.vaultId),
      getCollateral(this.ctx, v.vaultId),
      getPositionsRaw(this.ctx, v.vaultId),
      getVaultActivity(this.ctx, v.address),
      this.memo('launch', 3_600_000, () => this.ctx.client.getBlock({ blockNumber: this.ctx.deployment.block })),
    ]);
    const times = await getBlockTimes(this.ctx, activity.bought.map((e) => e.blockNumber));
    const dec = v.assetDecimals;
    const tokens = fromWad(collateral.find((c) => c.token.toLowerCase() === v.underlying.toLowerCase())?.amount ?? 0n);
    const openSeries = await Promise.all(
      positions
        .filter((p) => p.qty < 0n)
        .map(async (p) => {
          const s = await this.seriesInfo(p.seriesId);
          const sales = activity.bought.filter((e) => Number(e.args.seriesId) === p.seriesId);
          const back = activity.soldBack.filter((e) => Number(e.args.seriesId) === p.seriesId);
          const premium = sales.reduce((a, e) => a + fromWad(e.args.premium as bigint), 0) - back.reduce((a, e) => a + fromWad(e.args.premium as bigint), 0);
          const mk = await this.mark(s, m, now, g);
          return {
            id: s.id,
            seriesId: s.id,
            underlying: m.symbol,
            expiry: s.expiry,
            strike: fromWad(s.strike),
            isCall: s.isCall,
            qty: fromWad(p.qty),
            premium,
            soldAt: sales[0] ? (times.get(sales[0].blockNumber) ?? 0) : 0,
            mark: mk ? fromWad(mk.price) : Number.NaN,
          };
        }),
    );
    const queued = v.escrowedShares > 0n ? fromUnits(await convertToAssets(this.ctx, v.address, v.escrowedShares), dec) : 0;
    const row = this.vaultRow(v, ms);
    const assetSym = this.sym(v.asset);
    const c = v.config;
    return {
      ...row,
      name: v.name,
      symbol: v.symbol,
      asset: assetSym,
      config: {
        minOtm: fromWad(c.minOtm),
        maxTenorDays: c.maxTenorDays,
        skewSlope: fromWad(c.skewSlope),
        utilSlope: fromWad(c.utilSlope),
        spread: fromWad(c.spread),
        sessionVolAdd: { REGULAR: fromWad(c.sessionVolAdd[0] ?? 0n), EXTENDED: fromWad(c.sessionVolAdd[1] ?? 0n), WEEKEND: fromWad(c.sessionVolAdd[2] ?? 0n), HOLIDAY: fromWad(c.sessionVolAdd[3] ?? 0n) },
        maxTradeQty: fromWad(c.maxTradeQty),
        maxOpenSeries: c.maxOpenSeries,
        minDelta: fromWad(c.minDelta),
        maxDelta: fromWad(c.maxDelta),
        minNewSeriesQty: fromWad(c.minNewSeriesQty),
      },
      launchedAt: Number(launch.timestamp),
      shares: fromUnits(v.totalSupply, v.shareDecimals),
      escrowedShares: fromUnits(v.escrowedShares, v.shareDecimals),
      navPerShare: row.nav,
      navWeekAgo: Number.NaN,
      backing: v.kind === 'coveredCall' ? tokens : fromWad(cash),
      locked: fromUnits(v.lockedAssets, dec),
      queued,
      free: fromUnits(v.freeAssets, dec),
      cash: fromWad(cash),
      tokens,
      openSeries,
      nextRoll: openSeries.length ? Math.min(...openSeries.map((x) => x.expiry)) : nextWeeklyExpiry(now),
      cooldown: v.cooldown,
      navHistory: [],
      epochs: [],
      deficits: [],
      markVol: fromWad(m.markVol),
      fillShare: Number.NaN,
    };
  }

  async wallet(owner: string): Promise<WalletHoldings> {
    const who = owner as Address;
    const tokens: Record<string, number> = {};
    await Promise.all(
      Object.entries(this.ctx.deployment.tokens).map(async ([sym, t]) => {
        const [bal, dec] = await Promise.all([
          this.ctx.client.readContract({ address: t, abi: erc20Abi, functionName: 'balanceOf', args: [who] }),
          this.decimals(t),
        ]);
        tokens[sym] = fromUnits(bal, dec);
      }),
    );
    const vs = await this.vaultStates();
    const holdings = await Promise.all(
      vs.map(async (v): Promise<VaultHolding> => {
        const h = await getVaultHolding(this.ctx, v.address, who);
        return { vault: v.address, shares: fromUnits(h.shares, v.shareDecimals), lastReceive: h.lastReceive, pendingShares: fromUnits(h.pendingShares, v.shareDecimals) };
      }),
    );
    return { owner, tokens, vaults: holdings.filter((h) => h.shares > 0 || h.pendingShares > 0) };
  }

  async expiries(id: number): Promise<AccountExpiry[]> {
    const [acct, now, settlements, claims] = await Promise.all([
      getAccount(this.ctx, id, this.seriesCache),
      this.now(),
      getAccountSettlements(this.ctx, { id: BigInt(id) }),
      getClaims(this.ctx, { id: BigInt(id) }),
    ]);
    const out: AccountExpiry[] = [];
    // open: every expiry the account still holds, valued at today's spot (or its settlement price)
    for (const e of expiriesOf(acct.positions)) {
      const legs: ExpiryLeg[] = [];
      for (const p of acct.positions.filter((x) => x.expiry === e)) {
        const m = await this.market(p.underlying);
        const st = p.expiry <= now ? await getSettlementPrice(this.ctx, p.underlying, p.expiry) : undefined;
        const price = st?.settled ? st.price : (m.spot ?? m.feedPrice ?? 0n);
        legs.push({
          underlying: m.symbol,
          strike: fromWad(p.strike),
          isCall: p.isCall,
          qty: fromWad(p.qty),
          settlePrice: fromWad(price),
          payoff: fromWad(mulWad(payoff(p, price), p.qty)),
        });
      }
      const net = legs.reduce((a, l) => a + l.payoff, 0);
      const cash = fromWad(acct.state.cash);
      out.push({ expiry: e, status: 'open', net, legs, cash, shortfall: net < 0 && -net > cash ? -net - cash : 0 });
    }
    // settled: AccountSettled, then claims and deficits
    const times = await getBlockTimes(this.ctx, [...settlements, ...claims].map((x) => x.blockNumber));
    for (const s of settlements) {
      const expiry = Number(s.args.expiry);
      const net = fromWad(s.args.net as bigint);
      const claim = claims.find((c) => Number(c.args.expiry) === expiry);
      const settledAt = times.get(s.blockNumber);
      const base = { expiry, net, legs: [] as ExpiryLeg[], ...(settledAt !== undefined ? { settledAt } : {}) };
      if (net > 0) {
        const left = fromWad(await getClaimable(this.ctx, id, expiry));
        out.push(
          claim
            ? { ...base, status: 'claimed', claimedAt: times.get(claim.blockNumber), claimable: 0 }
            : { ...base, status: 'claimable', claimable: left },
        );
      } else {
        const bridged = fromWad(s.args.bridged as bigint);
        const unfunded = fromWad(s.args.unfunded as bigint);
        const owed = bridged + unfunded > 0 ? fromWad((await getDeficit(this.ctx, id, expiry)).bridged) : 0;
        const status: AccountExpiry['status'] = bridged + unfunded === 0 ? 'paid' : owed > 0 ? 'deficit' : 'deficit-cleared';
        out.push({ ...base, status, paidCash: fromWad(s.args.paidFromCash as bigint), bridged, shortfall: unfunded });
      }
    }
    return out.sort((a, b) => a.expiry - b.expiry);
  }

  async pools(): Promise<ExpiryPool[]> {
    const [all, now, settlements, claims, settledPrices, trades] = await Promise.all([
      this.allSeries(),
      this.now(),
      getAccountSettlements(this.ctx),
      getClaims(this.ctx),
      getExpirySettlements(this.ctx),
      this.trades(),
    ]);
    const priceTimes = await getBlockTimes(this.ctx, settledPrices.map((e) => e.blockNumber));
    return Promise.all(
      expiriesOf(all).map(async (expiry): Promise<ExpiryPool> => {
        const series = all.filter((s) => s.expiry === expiry);
        const tokens = [...new Set(series.map((s) => s.underlying))];
        const pool = await getPool(this.ctx, expiry);
        const prices: SettlementPrice[] = await Promise.all(
          tokens.map(async (t) => {
            const ev = settledPrices.find((e) => Number(e.args.expiry) === expiry && (e.args.underlying as Address).toLowerCase() === t.toLowerCase());
            if (!ev) return { symbol: this.sym(t), method: 'waiting' as const, round: null, price: null, updatedAt: null };
            return {
              symbol: this.sym(t),
              method: ev.args.fallbackUsed ? ('fallback' as const) : ('last print' as const),
              round: Number(BigInt(ev.args.roundId as bigint) & ((1n << 64n) - 1n)),
              price: fromWad(ev.args.price as bigint),
              updatedAt: null,
              settledAt: priceTimes.get(ev.blockNumber),
            };
          }),
        );
        const mine = settlements.filter((s) => Number(s.args.expiry) === expiry);
        const ids = new Set<bigint>();
        const seriesIds = new Set(series.map((s) => s.id));
        for (const t of trades) {
          if (!seriesIds.has(Number(t.args.seriesId))) continue;
          ids.add(t.args.takerId as bigint);
          ids.add(t.args.makerId as bigint);
        }
        let holders = 0;
        await Promise.all(
          [...ids].map(async (aid) => {
            const ps = await getPositionsRaw(this.ctx, aid);
            if (ps.some((p) => seriesIds.has(p.seriesId))) holders++;
          }),
        );
        const allPriced = prices.every((p) => p.price !== null);
        const status: ExpiryPool['status'] = expiry > now ? 'open' : !allPriced || pool.pending > 0n || pool.unsettledShortQty > 0n ? 'waiting' : 'ready';
        return {
          expiry,
          status,
          prices,
          paidIn: mine.reduce((a, s) => a + fromWad((s.args.paidFromCash as bigint) + (s.args.bridged as bigint)), 0),
          bridged: mine.reduce((a, s) => a + fromWad(s.args.bridged as bigint), 0),
          pending: fromWad(pool.pending),
          claims: mine.reduce((a, s) => a + Math.max(0, fromWad(s.args.net as bigint)), 0),
          claimed: claims.filter((c) => Number(c.args.expiry) === expiry).reduce((a, c) => a + fromWad(c.args.amount as bigint), 0),
          unsettledShortQty: fromWad(pool.unsettledShortQty),
          readyAt: null,
          settledAt: null,
          accounts: holders,
        };
      }),
    );
  }

  async feeds(): Promise<FeedStatus[]> {
    const [ms, g, now, launch] = await Promise.all([
      this.markets(),
      this.globals(),
      this.now(),
      this.memo('launch', 3_600_000, () => this.ctx.client.getBlock({ blockNumber: this.ctx.deployment.block })),
    ]);
    return ms.map((m) => ({
      symbol: m.symbol,
      proxy: m.feed.address,
      description: m.feed.description,
      session: m.session,
      spot: m.spot !== null ? fromWad(m.spot) : m.feedPrice !== null ? fromWad(m.feedPrice) : Number.NaN,
      lastRound: Number(m.feed.roundId & ((1n << 64n) - 1n)),
      band: [fromWad(m.params.minPrice), fromWad(m.params.maxPrice)],
      staleLimits: { REGULAR: m.params.maxStaleRegular, EXTENDED: m.params.maxStaleExtended, CLOSED: m.params.maxStaleClosed },
      haltWindow: g.haltWindow,
      uiMultiplier: fromWad(m.uiMultiplier),
      lastMultiplierChange: null,
      oraclePaused: m.oraclePaused,
      paused: m.paused,
      corporateAction: null,
      // the hub keeps no log of halts; an episode list needs an indexer
      halts: [],
      historyFrom: Number(launch.timestamp),
      historyTo: now,
      rounds: Number(m.feed.roundId & ((1n << 64n) - 1n)),
    }));
  }

  async auctions(): Promise<Auction[]> {
    const [ev, g, ms] = await Promise.all([getAuctionEvents(this.ctx), this.globals(), this.markets()]);
    const times = await getBlockTimes(this.ctx, [...ev.started, ...ev.saleStarted].map((e) => e.blockNumber));
    const symbols = async (id: bigint) => (await getUnderlyingsOf(this.ctx, id)).map((t) => ms.find((m) => m.token.toLowerCase() === t.toLowerCase())?.symbol ?? this.sym(t));
    const common = {
      startDiscount: fromWad(g.startDiscount),
      maxDiscount: fromWad(g.maxDiscount),
      duration: g.auctionDuration,
      maxFractionPerBid: fromWad(g.maxFractionPerBid),
      penaltyBps: Math.round(fromWad(g.liquidationPenalty) * 1e4),
    };
    const liq = await Promise.all(
      ev.started.map(async (e, i): Promise<Auction> => {
        const id = e.args.id as bigint;
        const [st, d, us, claims] = await Promise.all([getAccountState(this.ctx, id), getLiquidation(this.ctx, id), symbols(id), this.n.clearinghouse.getClaimableTotal(id)]);
        return {
          id: i + 1,
          kind: 'liquidation',
          account: Number(id),
          startedAt: Number(e.args.startedAt ?? times.get(e.blockNumber) ?? 0),
          ...common,
          equity: fromWad(st.equity),
          im: fromWad(st.im),
          mm: fromWad(st.mm),
          transferable: fromWad(st.equity + st.deficit - claims),
          underlyings: us,
          status: d.active ? 'active' : 'ended',
        };
      }),
    );
    const sales = await Promise.all(
      ev.saleStarted.map(async (e, i): Promise<Auction> => {
        const id = e.args.id as bigint;
        const [st, d, us] = await Promise.all([getAccountState(this.ctx, id), getDeficitSale(this.ctx, id, Number(e.args.expiry)), symbols(id)]);
        return {
          id: liq.length + i + 1,
          kind: 'deficit',
          account: Number(id),
          startedAt: Number(e.args.startedAt ?? times.get(e.blockNumber) ?? 0),
          ...common,
          equity: fromWad(st.equity),
          im: fromWad(st.im),
          mm: fromWad(st.mm),
          transferable: fromWad(st.equity + st.deficit),
          underlyings: us,
          status: d.active ? 'active' : 'ended',
        };
      }),
    );
    return [...liq, ...sales].filter((a) => a.status !== 'ended');
  }

  async insurance(): Promise<InsuranceFund> {
    const usdg = tokenOf(this.ctx.deployment, 'USDG');
    const [ins, idx, social, ev, seeds] = await Promise.all([
      getInsurance(this.ctx),
      getCashIndex(this.ctx),
      getLossesSocialized(this.ctx),
      getInsuranceEvents(this.ctx),
      getEvents(this.ctx, { address: usdg, abi: erc20Abi, eventName: 'Transfer', args: { from: zeroAddress, to: this.ctx.deployment.insurance } }),
    ]);
    const scale = 10 ** (await this.decimals(usdg));
    const times = await getBlockTimes(this.ctx, [...seeds, ...ev.covered, ...ev.recovered].map((e) => e.blockNumber));
    const events: InsuranceFund['events'] = [
      ...seeds.map((e) => ({ at: times.get(e.blockNumber) ?? 0, kind: 'seed' as const, amount: Number(e.args.value) / scale, who: 'Seed mint' })),
      ...ev.covered.map((e) => ({ at: times.get(e.blockNumber) ?? 0, kind: 'cover' as const, amount: fromWad(e.args.coveredWad as bigint), who: 'a payer' })),
      ...ev.recovered.map((e) => ({ at: times.get(e.blockNumber) ?? 0, kind: 'recover' as const, amount: fromWad(e.args.amountWad as bigint), who: 'a deficit sale' })),
    ].sort((a, b) => a.at - b.at);
    return {
      balance: fromWad(ins.balance),
      outstanding: fromWad(ins.outstanding),
      socialized: social.reduce((a, e) => a + fromWad(e.args.amount as bigint), 0),
      cashIndex: fromWad(idx),
      events,
    };
  }

  async openInterest(): Promise<OpenInterestRow[]> {
    const [all, ms, now] = await Promise.all([this.allSeries(), this.markets(), this.now()]);
    const live = all.filter((s) => s.expiry > now);
    const oi = await Promise.all(live.map((s) => getOpenInterest(this.ctx, s.id)));
    return ms.map((m) => {
      const contracts = live.reduce((a, s, i) => (s.underlying.toLowerCase() === m.token.toLowerCase() ? a + fromWad(oi[i] as bigint) : a), 0);
      const spot = m.spot ?? m.feedPrice;
      return { underlying: m.symbol, shortContracts: contracts, notionalUsd: spot !== null ? contracts * fromWad(spot) : 0 };
    });
  }

  // ---------------------------------------------------------------- writes (the connected wallet signs)

  private signer(): { wallet: WalletClient; account: Address } {
    const wallet = this.signerWallet;
    const account = wallet?.account?.address;
    if (!wallet || !account) throw new Error('Connect a wallet to sign.');
    return { wallet, account };
  }

  /** Sends a simulated request, waits for it and forgets cached reads. */
  private async send(sim: Promise<{ request: unknown }>): Promise<Hash> {
    const { wallet } = this.signer();
    const { request } = await sim;
    // the wallet signs; gas carries the SDK's headroom over the estimate
    // pinned to the live chain and the wallet's account: viem refuses to send if the wallet sits on
    // another network, rather than spending gas at the same addresses somewhere else
    const pinned = { ...(request as object), chain: LIVE_CHAIN, account: wallet.account } as unknown as Parameters<WalletClient['writeContract']>[0];
    const req = await withGasHeadroom(this.ctx.client, pinned);
    const hash = await wallet.writeContract(req);
    const rc = await this.ctx.client.waitForTransactionReceipt({ hash });
    this.invalidate();
    if (rc.status !== 'success') {
      const why = await explainTx(this.ctx, hash).catch(() => undefined);
      if (why) throw new RefusalError(why.refusal);
      throw new Error(`Transaction ${hash} reverted.`);
    }
    return hash;
  }

  private async allow(token: Address, spender: Address, amount: bigint): Promise<void> {
    const { account } = this.signer();
    const cur = await this.ctx.client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [account, spender] });
    if (cur >= amount) return;
    // exactly what this transaction pulls, never an open-ended allowance
    await this.send(simulateApprove(this.ctx, account, token, spender, amount));
  }

  async grantAgent(id: number, grant: NewGrant): Promise<string> {
    const { account } = this.signer();
    await this.mustOwn(id, 'grant agents on it');
    const ms = await this.markets();
    const mask = ms.filter((m) => grant.allowed.includes(m.symbol)).reduce((a, m) => a | (1n << BigInt(m.index)), 0n);
    return this.send(
      simulateGrantAgent(this.ctx, account, id, grant.agent as Address, {
        maxWorstLoss: toWad(grant.maxWorstLoss),
        maxPremiumPerTrade: toWad(grant.maxPremiumPerTrade),
        allowedMask: mask,
        expiresAt: grant.expiresAt,
      }),
    );
  }

  async revokeAgent(id: number, agent: string): Promise<string> {
    const { account } = this.signer();
    await this.mustOwn(id, 'revoke its agents');
    return this.send(simulateRevokeAgent(this.ctx, account, id, agent as Address));
  }

  /** True when the connected wallet owns `id` or holds a live agent grant on it. */
  async canAct(id: number): Promise<boolean> {
    const w = this.walletAddress;
    return Boolean(w && id > 0 && (await isAuthorized(this.ctx, id, w)));
  }

  private async mustAct(id: number): Promise<void> {
    if (!(await this.canAct(id))) throw new Error(`Account ${id} is view only: this wallet neither owns it nor holds a live agent grant on it.`);
  }

  /** True when the connected wallet is the account's owner (an agent grant doesn't count). */
  async owns(id: number): Promise<boolean> {
    const w = this.walletAddress;
    return Boolean(w && id > 0 && (await getOwnerOf(this.ctx, id)).toLowerCase() === w.toLowerCase());
  }

  /**
   * Owner-only actions. An owner can name any address as its agent without that address agreeing,
   * so an agent role must never unlock moving the wallet's own funds into the account.
   */
  private async mustOwn(id: number, what: string): Promise<void> {
    if (await this.owns(id)) return;
    const agent = await this.canAct(id);
    throw new Error(
      agent
        ? `Only the owner of account ${id} can ${what}. This wallet is one of its agents, which lets it trade for the account, never fund it.`
        : `Only the owner of account ${id} can ${what}, and this wallet doesn't own it.`,
    );
  }

  /** The subaccounts a wallet owns, oldest first. */
  async subaccountsOf(owner: string): Promise<number[]> {
    return (await getSubaccountsOf(this.ctx, owner as Address)).map(Number);
  }

  /** The account that traded last on this deployment: what live mode shows before a wallet connects. */
  async featuredAccount(): Promise<number | undefined> {
    const t = (await this.trades()).at(-1);
    return t ? Number(t.args.takerId) : undefined;
  }

  /** Vault subaccounts, so the app can name them. */
  async vaultAccounts(): Promise<Map<number, string>> {
    const vs = await this.vaultStates();
    return new Map(vs.map((v) => [Number(v.vaultId), v.symbol]));
  }

  async createSubaccount(): Promise<{ hash: Hash; id: number }> {
    const { account } = this.signer();
    const sim = await simulateCreateSubaccount(this.ctx, account);
    const hash = await this.send(Promise.resolve(sim));
    return { hash, id: Number(sim.result) };
  }

  /** Testnet only: the mock tokens have a public mint. 10,000 USDG and 10 of each stock token. */
  async mintTestTokens(): Promise<Hash[]> {
    // the mocks' public mint exists only on the testnet deployment
    if (!LIVE_CHAIN.testnet || LIVE_CHAIN.id !== 46630) throw new Error('Test tokens exist only on RH Chain testnet.');
    const { account } = this.signer();
    const out: Hash[] = [];
    for (const [sym, token] of Object.entries(this.ctx.deployment.tokens)) {
      if (sym !== 'USDG' && sym !== 'NVDA' && sym !== 'TSLA') continue;
      const amount = toUnits(sym === 'USDG' ? 10_000 : 10, await this.decimals(token));
      out.push(await this.send(simulateMint(this.ctx, account, token, account, amount)));
    }
    return out;
  }

  /** USDG into cash, or a stock token into collateral. `amount` in token units. */
  async deposit(id: number, symbol: string, amount: number): Promise<Hash> {
    const { account } = this.signer();
    await this.mustOwn(id, 'deposit into it from this app');
    const token = tokenOf(this.ctx.deployment, symbol);
    const raw = toUnits(amount, await this.decimals(token));
    await this.allow(token, this.ctx.deployment.clearinghouse, raw);
    return this.send(simulateDeposit(this.ctx, account, id, token, raw));
  }

  async withdraw(id: number, symbol: string, amount: number): Promise<Hash> {
    const { account } = this.signer();
    await this.mustOwn(id, 'withdraw from it');
    const token = tokenOf(this.ctx.deployment, symbol);
    const raw = toUnits(amount, await this.decimals(token));
    return this.send(simulateWithdraw(this.ctx, account, id, token, raw, account));
  }

  /** Buys from the vault that sells the series, paying at most `maxPremium` USDG. */
  async buyFromVault(id: number, seriesId: number, qty: number, maxPremium: number): Promise<Hash> {
    const { account } = this.signer();
    await this.mustAct(id);
    const s = await this.seriesInfo(seriesId);
    const v = await this.vaultFor(s);
    if (!v) throw new Error('No live vault sells this series.');
    return this.send(simulateVaultBuy(this.ctx, account, v.address, seriesId, toWad(qty), toWad(Number(maxPremium.toFixed(6))), id));
  }

  /** Sells back to the vault at its bid, receiving at least `minPremium` USDG. */
  async sellToVault(id: number, seriesId: number, qty: number, minPremium: number): Promise<Hash> {
    const { account } = this.signer();
    await this.mustAct(id);
    const s = await this.seriesInfo(seriesId);
    const v = await this.vaultFor(s);
    if (!v) throw new Error('No live vault buys this series back.');
    return this.send(simulateVaultSellBack(this.ctx, account, v.address, seriesId, toWad(qty), toWad(Number(minPremium.toFixed(6))), id));
  }

  /**
   * Fills exactly the quote the ticket showed (by its digest), at the size it was shown for. Nothing
   * is fetched here: an expired or unknown quote throws, and the ticket shows a fresh one first.
   */
  async fillRfq(id: number, hash: Hex): Promise<Hash> {
    const { account } = this.signer();
    await this.mustAct(id);
    const shown = this.shown.get(hash);
    if (!shown) throw new Error('This quote is no longer on the ticket. Check the new price and sign again.');
    if (Number(shown.quote.deadline) <= (await this.now()) + 5) {
      this.shown.delete(hash);
      this.rfqCache.delete(shown.key);
      throw new Error('The quote expired. The ticket is asking the relay for a new one: check the price and sign again.');
    }
    const hashOut = await this.send(simulateRfqFill(this.ctx, account, shown.quote, shown.signature, id, shown.size));
    this.shown.delete(hash);
    this.rfqCache.delete(shown.key);
    return hashOut;
  }

  /** Forget a shown quote (the ticket is asking for a new one). */
  dropQuote(hash: Hex) {
    const shown = this.shown.get(hash);
    if (shown) this.rfqCache.delete(shown.key);
    this.shown.delete(hash);
  }

  /** ERC-4626 deposit of `amount` of the vault's asset, to the connected wallet. */
  async vaultDeposit(vault: string, amount: number): Promise<Hash> {
    const { account } = this.signer();
    const v = (await this.vaultStates()).find((x) => x.address.toLowerCase() === vault.toLowerCase());
    if (!v) throw new Error(`unknown vault ${vault}`);
    const raw = toUnits(amount, v.assetDecimals);
    await this.allow(v.asset, v.address, raw);
    return this.send(simulateVaultDeposit(this.ctx, account, v.address, raw, account));
  }

  /** Instant withdrawal of `amount` asset units (up to the free assets). */
  async vaultWithdraw(vault: string, amount: number): Promise<Hash> {
    const { account } = this.signer();
    const v = (await this.vaultStates()).find((x) => x.address.toLowerCase() === vault.toLowerCase());
    if (!v) throw new Error(`unknown vault ${vault}`);
    return this.send(simulateVaultWithdraw(this.ctx, account, v.address, toUnits(amount, v.assetDecimals), account, account));
  }

  /** Queues the shares worth `amount` asset units now for the next roll. */
  async requestRedeem(vault: string, amount: number): Promise<Hash> {
    const { account } = this.signer();
    const v = (await this.vaultStates()).find((x) => x.address.toLowerCase() === vault.toLowerCase());
    if (!v) throw new Error(`unknown vault ${vault}`);
    // previewWithdraw rounds shares up: queuing "all" must not ask for more than the balance
    const [wanted, held] = await Promise.all([
      previewWithdraw(this.ctx, v.address, toUnits(amount, v.assetDecimals)),
      getVaultHolding(this.ctx, v.address, account).then((h) => h.shares),
    ]);
    const shares = wanted > held ? held : wanted;
    return this.send(simulateRequestRedeem(this.ctx, account, v.address, shares, account));
  }
}
