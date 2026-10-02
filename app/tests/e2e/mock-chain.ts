/**
 * A stand-in for the Robinhood Chain testnet RPC, so live-mode tests never touch the network. It
 * answers the JSON-RPC calls the chain client makes (batched, through Multicall3, and the deployless
 * vault-quote lens) from a small fixed world: four underlyings (AAPL halted by a multiplier window),
 * four NVDA series, three vaults and account 4 holding one call. Calls are decoded and answered with
 * the SDK's own ABIs, so a change in the contracts' interface breaks these tests.
 */
import type { Page, Route } from '@playwright/test';
import {
  decodeAbiParameters,
  decodeFunctionData,
  deploylessCallViaBytecodeBytecode,
  encodeErrorResult,
  encodeFunctionResult,
  multicall3Abi,
  numberToHex,
  zeroAddress,
  type Abi,
  type AbiParameter,
  type Address,
  type Hex,
  keccak256,
  toHex,
} from 'viem';
import {
  aggregatorAbi,
  auctionHouseAbi,
  clearinghouseAbi,
  getDeployment,
  insuranceFundAbi,
  marketDataHubAbi,
  mockStockTokenAbi,
  novationErrorsAbi,
  optionVaultAbi,
  rfqVenueAbi,
  riskKernelAbi,
  riskParamsAbi,
  seriesRegistryAbi,
  vaultQuoteLensAbi,
  rfqDomain,
  signQuote,
  toWad,
} from '@novation/sdk';
import { privateKeyToAccount } from 'viem/accounts';

const W = 10n ** 18n;
const d = getDeployment(46630);
const RPC_HOST = 'rpc.testnet.chain.robinhood.com';
const EXPLORER_HOST = 'explorer.testnet.chain.robinhood.com';
const MULTICALL = '0xca11bde05977b3631167028862be2a173976ca11';

/** Thu Oct 1 2026, 12:26 ET: a regular session. */
export const MOCK_NOW = 1790872000;
const BLOCK = d.block + 70_000n;
const E1 = 1790971200; // Fri Oct 2, 16:00 ET
export const MOCK_OWNER = '0x4108064852c95135844be338fc8bcbdf91c41acf' as Address;
export const MOCK_ACCOUNT = 4;
/** Holds a live agent grant on MOCK_ACCOUNT (granted without asking it, as any owner can). */
export const MOCK_AGENT = '0x00000000000000000000000000000000000a9e47' as Address;

const SYMS = ['NVDA', 'TSLA', 'AAPL', 'SPY'] as const;
type Sym = (typeof SYMS)[number];
const SPOT: Record<Sym, bigint> = { NVDA: 230n * W, TSLA: 356n * W, AAPL: 327n * W, SPY: 762n * W };
const HALTED: Sym = 'AAPL';
const tok = (s: Sym) => d.tokens[s]!.toLowerCase();
const symOf = (a: string): Sym | undefined => SYMS.find((s) => tok(s) === a.toLowerCase());
const feedSym = (a: string): Sym | undefined => SYMS.find((s) => d.feeds[s]!.toLowerCase() === a.toLowerCase());

const SERIES = [
  { id: 1, sym: 'NVDA' as Sym, strike: 245n * W, isCall: true },
  { id: 2, sym: 'NVDA' as Sym, strike: 245n * W, isCall: false },
  { id: 3, sym: 'NVDA' as Sym, strike: 220n * W, isCall: true },
  { id: 4, sym: 'NVDA' as Sym, strike: 220n * W, isCall: false },
];

const STATE = {
  cash: 2000n * W,
  mtm: 3n * W / 2n,
  settledValue: 0n,
  deficit: 0n,
  equity: 2001n * W + W / 2n,
  im: 3n * W / 2n,
  mm: 1125n * W / 1000n,
  worstScenario: 0n,
  healthy: true,
  liquidatable: false,
};

const VAULT_CFG = {
  minOtm: W / 20n,
  maxTenorDays: 35,
  skewSlope: W / 2n,
  utilSlope: (3n * W) / 10n,
  spread: W / 50n,
  sessionVolAdd: [0n, W / 20n, (15n * W) / 100n, (15n * W) / 100n, 0n],
  maxTradeQty: 1000n * W,
  maxOpenSeries: 24,
  minDelta: W / 20n,
  maxDelta: W / 2n,
  minNewSeriesQty: W,
};

function vaultIndex(a: string): number {
  return d.vaults.findIndex((v) => v.address.toLowerCase() === a.toLowerCase());
}

type Handler = (args: readonly unknown[]) => unknown;
const revert = (name: string, args: unknown[] = []) => {
  throw Object.assign(new Error(name), { revertData: encodeErrorResult({ abi: novationErrorsAbi as Abi, errorName: name, args }) });
};

const underlyingParams = (s: Sym) => ({
  enabled: true,
  index: SYMS.indexOf(s),
  feed: d.feeds[s]!,
  strikeStep: 5n * W,
  volFloor: (35n * W) / 100n,
  volCap: (3n * W) / 2n,
  lambda: (97n * W) / 100n,
  shockK: 3n * W,
  minShock: W / 10n,
  horizonDays: 2n,
  volUp: (4n * W) / 10n,
  volDown: (3n * W) / 10n,
  multExtended: (12n * W) / 10n,
  multWeekend: (175n * W) / 100n,
  multHoliday: (175n * W) / 100n,
  multHalted: (25n * W) / 10n,
  maxOpenInterest: 1_000_000n * W,
  maxStaleRegular: 93600,
  maxStaleExtended: 93600,
  maxStaleClosed: 345600,
  volStaleness: 172800,
  minPrice: 20n * W,
  maxPrice: 6000n * W,
});

const HANDLERS: Record<string, Handler> = {
  // RiskParams
  'riskParams.underlyingCount': () => 4n,
  'riskParams.underlyingAt': ([i]) => d.tokens[SYMS[Number(i)]!]!,
  'riskParams.underlying': ([t]) => underlyingParams(symOf(t as string) ?? 'NVDA'),
  'riskParams.globals': () => ({
    mmRatio: (3n * W) / 4n,
    diversificationCredit: (3n * W) / 10n,
    shortOptionMinPct: W / 100n,
    feeRate: (3n * W) / 10000n,
    feeCapOfPremium: W / 8n,
    insuranceShare: W / 2n,
    startDiscount: W / 50n,
    maxDiscount: (12n * W) / 100n,
    maxFractionPerBid: W / 2n,
    liquidationPenalty: W / 100n,
    auctionDuration: 1800,
    maxSettlementLag: 87300,
    haltWindow: 86400,
    maxWeeksOut: 6,
    maxStrikeDeviation: W / 2n,
    rate: 0n,
    minTradeQty: W / 100n,
    dustEquity: 5n * W,
  }),
  'riskParams.openingPaused': () => false,
  // MarketDataHub
  'hub.session': ([t]) => (symOf(t as string) === HALTED ? 4 : 0),
  'hub.spot': ([t]) => {
    const s = symOf(t as string) ?? 'NVDA';
    return [SPOT[s], s === HALTED ? 4 : 0, s !== HALTED];
  },
  'hub.markVol': () => W / 2n,
  'hub.volState': () => [0n, 0n, (1n << 64n) | 10n, 0n, BigInt(MOCK_NOW - 60), BigInt(MOCK_NOW - 30)],
  // stock tokens and USDG
  'token.name': () => 'Mock token',
  'token.symbol': () => 'MOCK',
  'token.decimals': () => 18,
  'token.balanceOf': () => 0n,
  'token.allowance': () => 0n,
  'token.uiMultiplier': () => W,
  'token.effectiveAt': () => 0n,
  'token.paused': () => false,
  'token.oraclePaused': () => false,
  // feeds
  'feed.latestRoundData': () => [(1n << 64n) | 10n, 0n, BigInt(MOCK_NOW - 60), BigInt(MOCK_NOW - 60), (1n << 64n) | 10n],
  'feed.decimals': () => 8,
  'feed.description': () => 'USD',
  // SeriesRegistry
  'registry.seriesCount': () => SERIES.length,
  'registry.series': ([id]) => {
    const s = SERIES.find((x) => x.id === Number(id));
    if (!s) revert('UnknownSeries');
    return { underlying: d.tokens[s!.sym]!, expiry: BigInt(E1), isCall: s!.isCall, strike: s!.strike };
  },
  'registry.settlementPriceOf': () => [0n, false],
  'registry.seriesId': () => 0,
  // kernel: simple, deterministic numbers (the real maths is tested against KernelReference in the SDK)
  'kernel.bsQuote': ([spot, strike, , , , isCall]) => {
    const S = spot as bigint;
    const K = strike as bigint;
    const intrinsic = isCall ? (S > K ? S - K : 0n) : K > S ? K - S : 0n;
    const otm = isCall ? K > S : K < S;
    const delta = (otm ? W / 4n : (3n * W) / 4n) * (isCall ? 1n : -1n);
    return [intrinsic + 2n * W, delta, 0n, 0n, 0n];
  },
  'kernel.scenarioGrid': ([, , ps]) => Array.from({ length: 39 }, (_, i) => ((ps as unknown[]).length ? BigInt(i - 19) * W : 0n)),
  'kernel.margin': ([, , ps]) => {
    const n = BigInt((ps as unknown[]).length);
    return [
      { mtm: (3n * W) / 2n, lossIM: (n * 3n * W) / 2n, lossCorr: (n * 3n * W) / 2n, lossIndep: 0n, shortMin: 0n, worstScenario: 0n },
      [],
    ];
  },
  // Clearinghouse
  'ch.ownerOf': ([id]) => (Number(id) === MOCK_ACCOUNT ? MOCK_OWNER : Number(id) <= 3 ? d.vaults[Number(id) - 1]!.address : zeroAddress),
  'ch.accountState': ([id]) => (Number(id) === MOCK_ACCOUNT ? STATE : { ...STATE, cash: 0n, mtm: 0n, equity: 0n, im: 0n, mm: 0n }),
  'ch.positionsOf': ([id]) => (Number(id) === MOCK_ACCOUNT ? [{ seriesId: 1, qty: W }] : []),
  'ch.marginAfter': ([, , qtyDelta, cashDelta]) => {
    const cash = STATE.cash + (cashDelta as bigint);
    if (cash < 0n) revert('InsufficientCash', [BigInt(MOCK_ACCOUNT), STATE.cash, -(cashDelta as bigint)]);
    const q = qtyDelta as bigint;
    const im = STATE.im + (q < 0n ? -q : q) * 2n;
    const equity = STATE.equity + (cashDelta as bigint) + q * 2n;
    return { ...STATE, cash, equity, im, mm: (im * 3n) / 4n, healthy: equity >= im };
  },
  'ch.cashOf': ([id]) => (Number(id) === MOCK_ACCOUNT ? STATE.cash : 3n * W),
  'ch.collateralTokensOf': () => [],
  'ch.collateralOf': () => 0n,
  'ch.claimableTotalOf': () => 0n,
  'ch.deficitExpiriesOf': () => [],
  'ch.subaccountsOf': ([owner]) => ((owner as string).toLowerCase() === MOCK_OWNER ? [BigInt(MOCK_ACCOUNT)] : []),
  'ch.pool': () => [0n, 0n, W],
  'ch.openInterest': ([sid]) => (Number(sid) === 1 ? W : 0n),
  'ch.cashIndex': () => W,
  'ch.underlyingsOf': () => [d.tokens.NVDA!],
  'ch.isAuthorized': ([id, actor]) => Number(id) === MOCK_ACCOUNT && [MOCK_OWNER, MOCK_AGENT].includes((actor as string).toLowerCase() as Address),
  // InsuranceFund
  'insurance.balanceWad': () => 100_000n * W,
  'insurance.outstandingWad': () => 0n,
  // vaults
  'vault.name': () => 'Novation vault',
  'vault.isLive': () => true,
  'vault.config': () => VAULT_CFG,
  'vault.EXIT_COOLDOWN': () => 3600n,
  'vault.epoch': () => 0n,
  'vault.escrowedShares': () => 0n,
  'vault.reservedAssets': () => 0n,
};

/** Per-contract answers that depend on which token, feed or vault was called. */
function special(kind: string, to: string, fn: string, args: readonly unknown[]): { hit: boolean; value?: unknown } {
  if (kind === 'token') {
    const s = symOf(to);
    const usdg = to.toLowerCase() === d.tokens.USDG!.toLowerCase();
    if (fn === 'symbol') return { hit: true, value: usdg ? 'USDG' : s };
    if (fn === 'name') return { hit: true, value: usdg ? 'Mock USDG' : `Mock ${s}` };
    if (fn === 'decimals') return { hit: true, value: usdg ? 6 : 18 };
    if (fn === 'effectiveAt') return { hit: true, value: s === HALTED ? BigInt(MOCK_NOW + 1800) : 0n };
  }
  if (kind === 'feed') {
    const s = feedSym(to) ?? 'NVDA';
    if (fn === 'latestRoundData') return { hit: true, value: [(1n << 64n) | 10n, SPOT[s] / 10n ** 10n, BigInt(MOCK_NOW - 60), BigInt(MOCK_NOW - 60), (1n << 64n) | 10n] };
    if (fn === 'description') return { hit: true, value: `${s} / USD` };
  }
  if (kind === 'vault') {
    const i = vaultIndex(to);
    const v = d.vaults[i]!;
    const put = v.type === 'putWrite';
    const assetDec = put ? 6 : 18;
    const supply = put ? 50_000n * 10n ** 12n : 100n * 10n ** 24n;
    const assets = put ? 50_000n * 10n ** 6n : 100n * W;
    const table: Record<string, unknown> = {
      name: put ? `Novation Put Write ${v.underlying}` : `Novation Covered Call ${v.underlying}`,
      symbol: put ? `npw${v.underlying}` : `ncc${v.underlying}`,
      underlying: d.tokens[v.underlying]!,
      asset: put ? d.tokens.USDG! : d.tokens[v.underlying]!,
      decimals: assetDec + 6,
      vaultId: BigInt(i + 1),
      totalAssets: assets,
      totalSupply: supply,
      freeAssets: assets,
      lockedAssets: 0n,
      convertToAssets: () => ((args[0] as bigint) * assets) / supply,
      previewWithdraw: () => ((args[0] as bigint) * supply) / assets,
      balanceOf: 0n,
      lastReceive: 0n,
      pendingRedeem: 0n,
      redeemable: 0n,
      maxWithdraw: 0n,
      maxRedeem: 0n,
    };
    if (fn in table) {
      const v = table[fn];
      return { hit: true, value: typeof v === 'function' ? (v as () => unknown)() : v };
    }
  }
  return { hit: false };
}

function kindOf(to: string): { kind: string; abi: Abi } | undefined {
  const a = to.toLowerCase();
  if (a === d.clearinghouse.toLowerCase()) return { kind: 'ch', abi: clearinghouseAbi as Abi };
  if (a === d.hub.toLowerCase()) return { kind: 'hub', abi: marketDataHubAbi as Abi };
  if (a === d.registry.toLowerCase()) return { kind: 'registry', abi: seriesRegistryAbi as Abi };
  if (a === d.riskParams.toLowerCase()) return { kind: 'riskParams', abi: riskParamsAbi as Abi };
  if (a === d.insurance.toLowerCase()) return { kind: 'insurance', abi: insuranceFundAbi as Abi };
  if (a === d.auctionHouse.toLowerCase()) return { kind: 'auction', abi: auctionHouseAbi as Abi };
  if (a === d.rfq.toLowerCase()) return { kind: 'rfq', abi: rfqVenueAbi as Abi };
  if (a === d.kernel.toLowerCase()) return { kind: 'kernel', abi: riskKernelAbi as Abi };
  if (vaultIndex(a) >= 0) return { kind: 'vault', abi: optionVaultAbi as Abi };
  if (Object.values(d.tokens).some((t) => t.toLowerCase() === a)) return { kind: 'token', abi: mockStockTokenAbi as Abi };
  if (Object.values(d.feeds).some((t) => t.toLowerCase() === a)) return { kind: 'feed', abi: aggregatorAbi as Abi };
  return undefined;
}

function zero(p: AbiParameter): unknown {
  if (p.type.endsWith(']')) return [];
  if (p.type === 'tuple') {
    const comps = (p as { components: readonly AbiParameter[] }).components;
    return Object.fromEntries(comps.map((c) => [c.name, zero(c)]));
  }
  if (p.type === 'bool') return false;
  if (p.type === 'address') return zeroAddress;
  if (p.type === 'string') return '';
  if (p.type === 'bytes') return '0x';
  if (p.type.startsWith('bytes')) return `0x${'00'.repeat(Number(p.type.slice(5)))}`;
  const bits = Number(p.type.replace(/^u?int/, '')) || 256;
  return bits <= 48 ? 0 : 0n;
}

/** One eth_call: the return data, or the revert data it fails with. */
function call(to: string, data: Hex): { ok: true; data: Hex } | { ok: false; data: Hex } {
  const k = kindOf(to);
  if (!k) return { ok: false, data: '0x' };
  const { functionName, args = [] } = decodeFunctionData({ abi: k.abi, data });
  const item = k.abi.find((x) => x.type === 'function' && x.name === functionName) as { outputs: readonly AbiParameter[] };
  try {
    const sp = special(k.kind, to, functionName, args);
    const value = sp.hit
      ? sp.value
      : HANDLERS[`${k.kind}.${functionName}`]
        ? HANDLERS[`${k.kind}.${functionName}`]!(args)
        : item.outputs.length === 1
          ? zero(item.outputs[0]!)
          : item.outputs.map(zero);
    return { ok: true, data: encodeFunctionResult({ abi: k.abi, functionName, result: value as never }) };
  } catch (e) {
    const r = (e as { revertData?: Hex }).revertData;
    if (r) return { ok: false, data: r };
    throw e;
  }
}

/** viem's deployless call: the wrapper's creation code with (code, data) as constructor arguments. */
function deployless(input: Hex): Hex {
  const args = `0x${input.slice(deploylessCallViaBytecodeBytecode.length)}` as Hex;
  const [, inner] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], args);
  const { args: a = [] } = decodeFunctionData({ abi: vaultQuoteLensAbi, data: inner });
  const [, vault, ids, qty] = a as readonly [Address, Address, readonly number[], bigint];
  const put = d.vaults[vaultIndex(vault)]?.type === 'putWrite';
  const exceeds = encodeErrorResult({ abi: novationErrorsAbi as Abi, errorName: 'ExceedsShort', args: [qty, 0n] });
  const quotes = ids.map(() => ({ ask: ((put ? 3n : 5n) * W * qty) / (2n * W), bid: 0n, askError: '0x' as Hex, bidError: exceeds }));
  return encodeFunctionResult({ abi: vaultQuoteLensAbi, functionName: 'quotes', result: [true, quotes] });
}

type Rpc = { id: number; jsonrpc: '2.0'; method: string; params?: unknown[] };

function block(n: bigint) {
  return {
    number: numberToHex(n),
    hash: `0x${n.toString(16).padStart(64, '0')}`,
    parentHash: `0x${(n - 1n).toString(16).padStart(64, '0')}`,
    timestamp: numberToHex(MOCK_NOW - Number(BLOCK - n) / 4),
    nonce: '0x0000000000000000',
    difficulty: '0x1',
    gasLimit: '0x4000000000000',
    gasUsed: '0x0',
    miner: zeroAddress,
    extraData: '0x',
    baseFeePerGas: '0x989680',
    logsBloom: `0x${'0'.repeat(512)}`,
    transactionsRoot: `0x${'0'.repeat(64)}`,
    stateRoot: `0x${'0'.repeat(64)}`,
    receiptsRoot: `0x${'0'.repeat(64)}`,
    sha3Uncles: `0x${'0'.repeat(64)}`,
    mixHash: `0x${'0'.repeat(64)}`,
    size: '0x100',
    totalDifficulty: '0x1',
    transactions: [],
    uncles: [],
  };
}

function answer(req: Rpc): object {
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: req.id, result });
  const fail = (data: Hex) => ({ jsonrpc: '2.0', id: req.id, error: { code: 3, message: 'execution reverted', data } });
  switch (req.method) {
    case 'eth_chainId':
      return ok('0xb626');
    case 'net_version':
      return ok('46630');
    case 'eth_blockNumber':
      return ok(numberToHex(BLOCK));
    case 'eth_getBlockByNumber': {
      const tag = req.params?.[0];
      return ok(block(typeof tag === 'string' && tag.startsWith('0x') ? BigInt(tag) : BLOCK));
    }
    case 'eth_getLogs':
      return ok([]);
    case 'eth_getTransactionByHash':
    case 'eth_getTransactionReceipt':
      return ok(null);
    case 'eth_call': {
      const tx = (req.params?.[0] ?? {}) as { to?: string; data?: Hex; input?: Hex };
      const data = (tx.data ?? tx.input ?? '0x') as Hex;
      if (!tx.to) return ok(deployless(data));
      if (tx.to.toLowerCase() === MULTICALL) {
        const { args = [] } = decodeFunctionData({ abi: multicall3Abi, data });
        const calls = args[0] as readonly { target: Address; allowFailure: boolean; callData: Hex }[];
        const results = calls.map((c) => {
          const r = call(c.target, c.callData);
          return { success: r.ok, returnData: r.data };
        });
        return ok(encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: results }));
      }
      const r = call(tx.to, data);
      return r.ok ? ok(r.data) : fail(r.data);
    }
    default:
      return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `mock chain: ${req.method} not supported` } };
  }
}

/** Routes the testnet RPC (and the block explorer's API) to the mock for this page. */
export async function mockChain(page: Page) {
  await page.route(
    (url) => url.hostname === RPC_HOST,
    async (route: Route) => {
      const body = route.request().postDataJSON() as Rpc | Rpc[];
      const out = Array.isArray(body) ? body.map(answer) : answer(body);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
    },
  );
  await page.route(
    (url) => url.hostname === EXPLORER_HOST,
    (route) => route.fulfill({ status: 404, body: '{}' }),
  );
}

/** A throwaway maker key derived for these tests; it holds nothing anywhere. */
const MAKER_KEY = keccak256(toHex('novation-e2e-maker'));
export const MOCK_MAKER_ID = 7;

/** Serves the RFQ relay's GET /quotes with a quote that maker signs for whatever is asked. */
export async function mockRelay(page: Page, price = 1.75, opts: { claimedPremium?: string } = {}) {
  const maker = privateKeyToAccount(MAKER_KEY);
  await page.route('**/api/rfq/quotes?*', async (route) => {
    const url = new URL(route.request().url());
    const series = Number(url.searchParams.get('series'));
    const side = url.searchParams.get('side') === 'sell' ? 'sell' : 'buy';
    const qty = toWad(url.searchParams.get('qty') ?? '1');
    const q = {
      signer: maker.address,
      makerId: BigInt(MOCK_MAKER_ID),
      seriesId: series,
      makerSells: side === 'buy',
      maxQty: qty,
      price: toWad(price),
      deadline: BigInt(MOCK_NOW + 60),
      nonce: 12345n,
    };
    const signature = await signQuote(maker, q, rfqDomain(46630, d.rfq));
    // a relay's extra fields are not signed; the app must ignore them (claimedPremium tests that)
    const premium = opts.claimedPremium ?? ((qty * q.price) / W).toString();
    const quote = Object.fromEntries(Object.entries(q).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ series, quotes: [{ side, quote, signature, premium, expiresAt: Math.floor(Date.now() / 1000) + 3600 }], refusals: [] }),
    });
  });
}

/** An injected EIP-1193 wallet for `address` on RH testnet. It connects and reports its chain; it never signs. */
export async function injectWallet(page: Page, address: Address) {
  await page.addInitScript((account) => {
    const w = window as unknown as { ethereum: unknown };
    w.ethereum = {
      isMetaMask: true,
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
        if (method === 'eth_chainId') return '0xb626';
        if (method === 'net_version') return '46630';
        if (method === 'wallet_requestPermissions' || method === 'wallet_getPermissions') return [{ parentCapability: 'eth_accounts' }];
        if (method === 'wallet_switchEthereumChain') return null;
        throw Object.assign(new Error(`test wallet: ${method} not supported`), { code: 4200 });
      },
      on: () => {},
      removeListener: () => {},
    };
  }, address);
}
