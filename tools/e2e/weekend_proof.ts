/**
 * Weekend margin proof on a live Novation deployment (Robinhood Chain testnet).
 *
 * The margin's shock range scales with the market session: REGULAR 1.0, EXTENDED 1.2, WEEKEND and
 * HOLIDAY 1.75. Two twin subaccounts, W1 and W2, hold the same USDG deposit and take the same
 * trade: each sells the same NVDA calls to a maker account C, through one EIP-712 quote C signed.
 * W1 fills on a Friday in the REGULAR session and the trade clears. W2 sends the identical fill on
 * the Saturday after. The feeds don't print over the weekend, so spot stays where Friday left it
 * and only the session multiplier changes: W2's fill is mined and reverts with InsufficientMargin.
 *
 *   tsx tools/e2e/weekend_proof.ts --plan      read-only: the trade's what-if under REGULAR and WEEKEND shocks
 *   tsx tools/e2e/weekend_proof.ts --friday    gas, subaccounts and deposits for W1, W2 and C; W1 trades;
 *                                              W2's what-if is recorded at a pinned block
 *   tsx tools/e2e/weekend_proof.ts --saturday  W2 sends the same fill with a fixed gas limit; the revert is mined
 *   tsx tools/e2e/weekend_proof.ts --saturday --check   every Saturday check, nothing sent (any session)
 *   tsx tools/e2e/weekend_proof.ts --explain <tx>       why a mined transaction reverted (replay + explorer)
 *
 * Run it with the workspace's tsx (keeper/node_modules/.bin/tsx). Options: --rpc URL; --requote
 * (Saturday only: C signs a fresh quote for the same size at the current mark, for when the Friday
 * quote can't be filled any more).
 *
 * Keys: W1, W2 and C sign with keccak256(deployerKey ‖ "weekend-w1" | "weekend-w2" | "weekend-c"),
 * derived from DEPLOYER_PRIVATE_KEY (env or .env) and never printed. The deployer only sends them
 * gas. State and every transaction go to tools/e2e/out/weekend-<chainId>.json.
 */
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import {
  baseSession,
  bsQuote,
  buildKernelInput,
  clearinghouseAbi,
  createNovation,
  decodeRefusal,
  erc20Abi,
  explainTx,
  findSeriesId,
  fmtEt,
  getAccountState,
  getCash,
  getGlobals,
  getMarkVol,
  getQuoteFilled,
  getQuoteHashOnChain,
  getRfqDomain,
  getSession,
  getSpot,
  getSubaccountsOf,
  kernelMargin,
  mockUsdgAbi,
  quoteHash,
  quoteTuple,
  randomNonce,
  rfqPremium,
  rfqVenueAbi,
  robinhoodChainTestnet,
  scenarioGridFor,
  signQuote,
  tokenOf,
  WAD,
  whatIfTrade,
  type AccountState,
  type Novation,
  type RfqQuote,
  type Session,
} from '../../sdk/src/index';

const ROOT = path.resolve(__dirname, '..', '..');
// viem comes from the SDK's own dependencies (the repo root has none)
const sdkRequire = createRequire(path.join(ROOT, 'sdk', 'package.json'));
const viem = sdkRequire('viem') as typeof import('viem');
const { privateKeyToAccount } = sdkRequire('viem/accounts') as typeof import('viem/accounts');
type Hex = `0x${string}`;
type Address = `0x${string}`;
type LocalAccount = ReturnType<typeof privateKeyToAccount>;

// ---------------------------------------------------------------- the trade

const CHAIN_ID = 46630;
const EXPLORER = 'https://explorer.testnet.chain.robinhood.com';
const SYMBOL = 'NVDA';
const EXPIRY = 1791576000; // Fri 2026-10-09 16:00 ET
const STRIKE = 245n * WAD;
const IS_CALL = true;
/** Contracts each W sells to C. */
const QTY = 5n * WAD;
/** Each W's USDG deposit X (whole USDG). */
const DEPOSIT_USDG = 400n;
const MAKER_DEPOSIT_USDG = 2_000n;
const USDG_UNIT = 10n ** 6n;
/** Sun 2026-10-04 19:59:59 ET: the last second of the WEEKEND session. */
const QUOTE_DEADLINE = 1791158399n;
/** The Friday trade must be mined by 19:30 UTC (keepers settle the Oct 2 expiry from 19:45). */
const FRIDAY_CUTOFF_UTC_SEC = 19 * 3600 + 30 * 60;
/** Gas each throwaway key is topped up to, and the total the deployer may send. */
const GAS_TARGET: Record<Role, bigint> = { w1: 60_000_000_000_000n, w2: 80_000_000_000_000n, c: 30_000_000_000_000n };
const FUND_CAP = 400_000_000_000_000n;
/** Saturday's fixed gas limit: the Friday fill's gas used, plus half. */
const SATURDAY_GAS_PERCENT = 150n;
/** Plan thresholds: IM after the trade, as a share of equity after it. */
const MAX_REGULAR_SHARE = 0.9;
const MIN_WEEKEND_SHARE = 1.15;

type Role = 'w1' | 'w2' | 'c';
const ROLES: Role[] = ['w1', 'w2', 'c'];

// ---------------------------------------------------------------- state file

interface TxRecord {
  label: string;
  from: Address;
  tx: Hex;
  url: string;
  status: 'success' | 'reverted';
  block: string;
  blockTime: string;
  session: string;
  gasUsed: string;
  gasLimit: string;
  expectedError?: string;
}

interface State {
  chainId: number;
  clearinghouse: Address;
  rfq: Address;
  trade: { underlying: Address; symbol: string; seriesId: number; strike: string; expiry: number; isCall: boolean; qty: string; depositUsdg: string };
  actors: Partial<Record<Role, { address: Address; subaccount?: string; deposited?: boolean }>>;
  funded: string;
  quote?: { fields: Record<string, string | number | boolean>; signature: Hex; hash: Hex; signedAt: string };
  txs: TxRecord[];
  friday?: Record<string, unknown>;
  w2Snapshot?: Record<string, unknown>;
  saturday?: Record<string, unknown>;
}

const outFile = (chainId: number) => path.join(ROOT, 'tools', 'e2e', 'out', `weekend-${chainId}.json`);
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2);

function loadState(chainId: number): State | undefined {
  const p = outFile(chainId);
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as State) : undefined;
}

function saveState(s: State) {
  const p = outFile(s.chainId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, json(s) + '\n');
}

function quoteOf(s: State): RfqQuote {
  const f = s.quote!.fields;
  return {
    signer: f.signer as Address,
    makerId: BigInt(f.makerId as string),
    seriesId: Number(f.seriesId),
    makerSells: Boolean(f.makerSells),
    maxQty: BigInt(f.maxQty as string),
    price: BigInt(f.price as string),
    deadline: BigInt(f.deadline as string),
    nonce: BigInt(f.nonce as string),
  };
}

// ---------------------------------------------------------------- keys

function loadEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    const k = t.slice(0, i).trim();
    if (process.env[k] === undefined) process.env[k] = t.slice(i + 1).trim().replace(/^"|"$/g, '');
  }
}

function deployerKey(): Hex {
  const k = process.env.DEPLOYER_PRIVATE_KEY;
  if (!k) throw new Error('DEPLOYER_PRIVATE_KEY is not set (env or .env)');
  return (k.startsWith('0x') ? k : `0x${k}`) as Hex;
}

/** keccak256(deployerKey ‖ "weekend-<role>"): the key bytes, then the label's UTF-8 bytes. */
function derived(role: Role): LocalAccount {
  return privateKeyToAccount(viem.keccak256(viem.concat([deployerKey(), viem.stringToHex(`weekend-${role}`)])));
}

// ---------------------------------------------------------------- formatting

const usd = (x: bigint | number) => (typeof x === 'bigint' ? Number(x) / 1e18 : x).toFixed(4);
const pct = (num: bigint, den: bigint) => (den <= 0n ? 'n/a' : `${((Number(num) / Number(den)) * 100).toFixed(1)}%`);
const iso = (ts: number | bigint) => new Date(Number(ts) * 1000).toISOString().replace('.000Z', 'Z');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function line(label: string, v: string) {
  console.log(`${label.padEnd(34)} ${v}`);
}

// ---------------------------------------------------------------- chain helpers

/** A public client whose every read is pinned to `block`, so a snapshot is one consistent state. */
function pinnedClient(rpc: string, block: bigint) {
  const tag = viem.toHex(block);
  let id = 0;
  return viem.createPublicClient({
    chain: robinhoodChainTestnet,
    batch: { multicall: true },
    transport: viem.custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        const p = Array.isArray(params) ? [...params] : [];
        if (method === 'eth_blockNumber') return tag;
        if (method === 'eth_getBlockByNumber' && p[0] === 'latest') p[0] = tag;
        if (['eth_call', 'eth_getBalance', 'eth_getCode', 'eth_getStorageAt'].includes(method)) {
          const at = method === 'eth_getStorageAt' ? 2 : 1;
          if (p[at] === undefined || p[at] === 'latest') p[at] = tag;
        }
        for (let attempt = 0; ; attempt++) {
          const r = await fetch(rpc, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: p }),
          });
          if (r.status === 429 && attempt < 5) {
            await sleep(1500 * (attempt + 1));
            continue;
          }
          const j = (await r.json()) as { result?: unknown; error?: { code: number; message: string; data?: unknown } };
          if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code, data: j.error.data });
          return j.result;
        }
      },
    }),
  });
}

async function blockInfo(n: Novation, block: bigint) {
  const b = await n.client.getBlock({ blockNumber: block });
  const ts = Number(b.timestamp);
  return { ts, session: baseSession(ts) };
}

class Sender {
  constructor(
    readonly n: Novation,
    readonly state: State,
  ) {}

  /**
   * Signs locally and sends. Retries with a fresh nonce on "nonce too low" / "replacement
   * underpriced" (the feed mirror signs with the deployer key too); "already known" means this
   * very transaction is in the pool already, so it is awaited. With `gas` set nothing is estimated,
   * so a transaction that reverts still goes out and is mined.
   */
  async send(
    who: LocalAccount,
    label: string,
    tx: { to: Address; data?: Hex; value?: bigint },
    opts: { gas?: bigint; maxFeePerGas?: bigint; expectRevert?: string } = {},
  ) {
    const c = this.n.client;
    const data = tx.data ?? '0x';
    const value = tx.value ?? 0n;
    const gas = opts.gas ?? ((await c.estimateGas({ account: who.address, to: tx.to, data, value })) * 130n) / 100n + 50_000n;
    let hash: Hex | undefined;
    for (let attempt = 0; hash === undefined; attempt++) {
      const [nonce, gasPrice] = await Promise.all([c.getTransactionCount({ address: who.address, blockTag: 'pending' }), c.getGasPrice()]);
      const maxFeePerGas = opts.maxFeePerGas ?? gasPrice * 2n;
      const raw = await who.signTransaction({
        chainId: CHAIN_ID,
        type: 'eip1559',
        to: tx.to,
        data,
        value,
        gas,
        nonce,
        maxFeePerGas,
        maxPriorityFeePerGas: 0n,
      });
      const h = viem.keccak256(raw);
      try {
        await c.sendRawTransaction({ serializedTransaction: raw });
        hash = h;
      } catch (e) {
        const msg = String((e as { details?: string }).details ?? (e as Error).message ?? e);
        if (/already known/i.test(msg)) hash = h;
        else if (attempt < 8 && /nonce too low|nonce too high|replacement transaction underpriced|invalid nonce/i.test(msg)) {
          console.log(`  ${label}: ${msg.slice(0, 80)}; retrying with a fresh nonce`);
          await sleep(3000);
        } else throw e;
      }
    }
    const rc = await c.waitForTransactionReceipt({ hash, timeout: 300_000, pollingInterval: 1000 });
    const { ts, session } = await blockInfo(this.n, rc.blockNumber);
    const rec: TxRecord = {
      label,
      from: who.address,
      tx: hash,
      url: `${EXPLORER}/tx/${hash}`,
      status: rc.status === 'success' ? 'success' : 'reverted',
      block: rc.blockNumber.toString(),
      blockTime: iso(ts),
      session,
      gasUsed: rc.gasUsed.toString(),
      gasLimit: gas.toString(),
      ...(opts.expectRevert ? { expectedError: opts.expectRevert } : {}),
    };
    this.state.txs.push(rec);
    saveState(this.state);
    console.log(`  ${label}: ${rec.status} ${hash} (block ${rec.block}, gas ${rec.gasUsed}/${gas})`);
    if (!opts.expectRevert && rc.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
    return { hash, receipt: rc, rec };
  }
}

// ---------------------------------------------------------------- the what-if

interface WhatIf {
  block: bigint;
  blockTime: number;
  chainSession: Session;
  spot: bigint;
  markVol: bigint;
  fee: bigint;
  premium: bigint;
  cashDelta: bigint;
  /** marginAfter on chain (the hub's current session). */
  after: AccountState;
  /** The kernel's IM after the trade with each session's shocks swapped in. */
  im: Record<'REGULAR' | 'EXTENDED' | 'WEEKEND', bigint>;
  shockRange: Record<'REGULAR' | 'EXTENDED' | 'WEEKEND', bigint>;
  mtm: bigint;
  worstScenario: Record<'REGULAR' | 'EXTENDED' | 'WEEKEND', number>;
}

/** The taker's what-if for the twin trade: chain marginAfter, plus the kernel under each session. */
async function whatIf(n: Novation, account: bigint, seriesId: number, premium: bigint): Promise<WhatIf> {
  const ctx = n.ctx;
  const u = tokenOf(n.deployment, SYMBOL);
  const blk = await n.client.getBlock();
  const now = Number(blk.timestamp);
  const [{ price: spot, session }, markVol, g] = await Promise.all([getSpot(ctx, u), getMarkVol(ctx, u), getGlobals(ctx)]);
  const wi = await whatIfTrade(ctx, { account, seriesId, qty: -QTY, premium, spot, globals: g });
  const whatIfPos = { seriesId, qtyDelta: -QTY };
  const sessions = ['REGULAR', 'EXTENDED', 'WEEKEND'] as const;
  const grids = await Promise.all(sessions.map((s) => scenarioGridFor(ctx, account, { whatIf: whatIfPos, session: s, now, globals: g })));
  const im = {} as WhatIf['im'];
  const range = {} as WhatIf['shockRange'];
  const worst = {} as WhatIf['worstScenario'];
  sessions.forEach((s, i) => {
    const r = grids[i]!;
    im[s] = r.out.lossIM;
    range[s] = r.shockRange.find((x) => x.token.toLowerCase() === u.toLowerCase())!.range;
    worst[s] = r.out.worstScenario;
  });
  return {
    block: blk.number!,
    blockTime: now,
    chainSession: session,
    spot,
    markVol,
    fee: wi.fee,
    premium,
    cashDelta: wi.cashDelta,
    after: wi.after,
    im,
    shockRange: range,
    mtm: grids[0]!.out.mtm,
    worstScenario: worst,
  };
}

function printWhatIf(title: string, w: WhatIf) {
  console.log(`\n${title} (block ${w.block}, ${iso(w.blockTime)}, ${fmtEt(w.blockTime)}, hub session ${w.chainSession})`);
  line('spot / mark vol', `${usd(w.spot)} / ${usd(w.markVol)}`);
  line('premium in / fee', `${usd(w.premium)} / ${usd(w.fee)}`);
  line('equity after (chain marginAfter)', usd(w.after.equity));
  line('IM after (chain marginAfter)', `${usd(w.after.im)} (${pct(w.after.im, w.after.equity)} of equity, ${w.after.healthy ? 'clears' : 'refused'})`);
  for (const s of ['REGULAR', 'EXTENDED', 'WEEKEND'] as const) {
    line(`IM after, ${s} shocks (kernel)`, `${usd(w.im[s])} (${pct(w.im[s], w.after.equity)}; shock range ${usd(w.shockRange[s])}, worst cell ${w.worstScenario[s]})`);
  }
}

function whatIfJson(w: WhatIf) {
  return {
    block: w.block,
    blockTime: iso(w.blockTime),
    hubSession: w.chainSession,
    spot: usd(w.spot),
    markVol: usd(w.markVol),
    premium: usd(w.premium),
    fee: usd(w.fee),
    chainMarginAfter: { equity: usd(w.after.equity), im: usd(w.after.im), cash: usd(w.after.cash), mtm: usd(w.after.mtm), healthy: w.after.healthy },
    kernel: Object.fromEntries(
      (['REGULAR', 'EXTENDED', 'WEEKEND'] as const).map((s) => [
        s,
        { im: usd(w.im[s]), imShareOfEquity: pct(w.im[s], w.after.equity), shockRange: usd(w.shockRange[s]), worstScenario: w.worstScenario[s] },
      ]),
    ),
    raw: { equity: w.after.equity, imChain: w.after.im, imRegular: w.im.REGULAR, imExtended: w.im.EXTENDED, imWeekend: w.im.WEEKEND },
  };
}

/** WEEKEND IM vs equity if spot opened elsewhere: the kernel on the same book with spot moved. */
async function spotSensitivity(n: Novation, account: bigint, seriesId: number, cashAfter: bigint, baseSpot: bigint) {
  const rows: { move: string; spot: string; equity: string; imRegular: string; imWeekend: string; regular: string; weekend: string }[] = [];
  const u = tokenOf(n.deployment, SYMBOL).toLowerCase();
  for (const move of [-10, -5, 0, 5, 10]) {
    const out: Record<string, { mtm: bigint; im: bigint }> = {};
    let spot = 0n;
    for (const s of ['REGULAR', 'WEEKEND'] as const) {
      const input = await buildKernelInput(n.ctx, account, { whatIf: { seriesId, qtyDelta: -QTY }, session: s });
      const i = input.tokens.findIndex((t) => t.toLowerCase() === u);
      const k = input.us[i]!;
      k.spot = (baseSpot * BigInt(100 + move)) / 100n;
      spot = k.spot;
      const m = await kernelMargin(n.ctx, input);
      out[s] = { mtm: m.out.mtm, im: m.out.lossIM };
    }
    const eq = cashAfter + out.REGULAR!.mtm;
    rows.push({
      move: `${move > 0 ? '+' : ''}${move}%`,
      spot: usd(spot),
      equity: usd(eq),
      imRegular: usd(out.REGULAR!.im),
      imWeekend: usd(out.WEEKEND!.im),
      regular: pct(out.REGULAR!.im, eq),
      weekend: pct(out.WEEKEND!.im, eq),
    });
  }
  return rows;
}

// ---------------------------------------------------------------- setup steps

async function seriesIdOf(n: Novation): Promise<number> {
  const id = await findSeriesId(n.ctx, tokenOf(n.deployment, SYMBOL), EXPIRY, STRIKE, IS_CALL);
  if (!id) throw new Error(`${SYMBOL} ${usd(STRIKE)} ${IS_CALL ? 'call' : 'put'} ${iso(EXPIRY)} is not listed`);
  return id;
}

async function fund(snd: Sender, deployer: LocalAccount, keys: Record<Role, LocalAccount>) {
  const s = snd.state;
  for (const r of ROLES) {
    const bal = await snd.n.client.getBalance({ address: keys[r].address });
    if (bal >= (GAS_TARGET[r] * 3n) / 4n) continue;
    const amount = GAS_TARGET[r] - bal;
    if (BigInt(s.funded) + amount > FUND_CAP) throw new Error(`funding ${r} would pass the ${viem.formatEther(FUND_CAP)} ETH cap`);
    await snd.send(deployer, `fund ${r.toUpperCase()} with ${viem.formatEther(amount)} ETH of gas`, { to: keys[r].address, value: amount });
    s.funded = (BigInt(s.funded) + amount).toString();
    saveState(s);
  }
}

async function ensureSubaccount(snd: Sender, who: LocalAccount, role: Role): Promise<bigint> {
  const a = snd.state.actors[role]!;
  if (a.subaccount) return BigInt(a.subaccount);
  let ids = await getSubaccountsOf(snd.n.ctx, who.address);
  if (ids.length === 0) {
    await snd.send(who, `${role.toUpperCase()} createSubaccount`, {
      to: snd.n.deployment.clearinghouse,
      data: viem.encodeFunctionData({ abi: clearinghouseAbi, functionName: 'createSubaccount' }),
    });
    ids = await getSubaccountsOf(snd.n.ctx, who.address);
  }
  a.subaccount = ids[0]!.toString();
  saveState(snd.state);
  return ids[0]!;
}

/** Mints mock USDG to `who`, approves the clearinghouse and deposits `usdg` whole USDG into `id`. */
async function ensureDeposit(snd: Sender, who: LocalAccount, role: Role, id: bigint, usdg: bigint) {
  const a = snd.state.actors[role]!;
  if (a.deposited) return;
  const n = snd.n;
  const token = tokenOf(n.deployment, 'USDG');
  const ch = n.deployment.clearinghouse;
  const cash = await getCash(n.ctx, id);
  if (cash !== 0n) throw new Error(`${role.toUpperCase()} (subaccount ${id}) already holds ${usd(cash)} USDG of cash`);
  const amount = usdg * USDG_UNIT;
  const [bal, allowance] = await Promise.all([
    n.client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who.address] }),
    n.client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [who.address, ch] }),
  ]);
  if (bal < amount) {
    await snd.send(who, `${role.toUpperCase()} mints ${usdg} mock USDG`, {
      to: token,
      data: viem.encodeFunctionData({ abi: mockUsdgAbi, functionName: 'mint', args: [who.address, amount - bal] }),
    });
  }
  if (allowance < amount) {
    await snd.send(who, `${role.toUpperCase()} approves the clearinghouse`, {
      to: token,
      data: viem.encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ch, viem.maxUint256] }),
    });
  }
  await snd.send(who, `${role.toUpperCase()} deposits ${usdg} USDG into subaccount ${id}`, {
    to: ch,
    data: viem.encodeFunctionData({ abi: clearinghouseAbi, functionName: 'deposit', args: [id, token, amount] }),
  });
  a.deposited = true;
  saveState(snd.state);
}

/** C's quote: C buys up to 2 x QTY (the twins sell), at the kernel's Black-Scholes mark, floored to a cent. */
async function signMakerQuote(n: Novation, c: LocalAccount, makerId: bigint, seriesId: number) {
  const ctx = n.ctx;
  const u = tokenOf(n.deployment, SYMBOL);
  const [blk, { price: spot }, vol, g] = await Promise.all([n.client.getBlock(), getSpot(ctx, u), getMarkVol(ctx, u), getGlobals(ctx)]);
  const tau = BigInt(EXPIRY) - blk.timestamp;
  const bs = await bsQuote(ctx, { spot, strike: STRIKE, tau, vol, rate: g.rate, isCall: IS_CALL });
  const cent = 10n ** 16n;
  const q: RfqQuote = {
    signer: c.address,
    makerId,
    seriesId,
    makerSells: false,
    maxQty: 2n * QTY,
    price: (bs.price / cent) * cent,
    deadline: QUOTE_DEADLINE,
    nonce: randomNonce(),
  };
  const signature = await signQuote(c, q, getRfqDomain(ctx));
  const hash = quoteHash(ctx, q);
  const onChain = await getQuoteHashOnChain(ctx, q);
  if (onChain.toLowerCase() !== hash.toLowerCase()) throw new Error('quote hash mismatch with RfqVenue.hashQuote');
  return {
    fields: { ...q, makerId: q.makerId.toString(), maxQty: q.maxQty.toString(), price: q.price.toString(), deadline: q.deadline.toString(), nonce: q.nonce.toString() },
    signature,
    hash,
    signedAt: iso(blk.timestamp),
    mark: { spot: usd(spot), vol: usd(vol), bsPrice: usd(bs.price), block: blk.number!.toString() },
  };
}

function fillData(q: RfqQuote, signature: Hex, takerId: bigint): Hex {
  return viem.encodeFunctionData({ abi: rfqVenueAbi, functionName: 'fill', args: [quoteTuple(q), signature, takerId, QTY] });
}

/** eth_call of the fill from `from`; undefined if it would succeed, else the decoded refusal. */
async function simulateFill(n: Novation, from: Address, data: Hex) {
  try {
    await n.client.call({ account: from, to: n.deployment.rfq, data });
    return undefined;
  } catch (e) {
    return decodeRefusal(e) ?? { code: 'unknown', message: String((e as Error).message).slice(0, 200), args: {}, numbers: {}, selector: '0x' as Hex };
  }
}

// ---------------------------------------------------------------- modes

function initState(n: Novation, seriesId: number, keys: Record<Role, LocalAccount>): State {
  const s = loadState(CHAIN_ID) ?? {
    chainId: CHAIN_ID,
    clearinghouse: n.deployment.clearinghouse,
    rfq: n.deployment.rfq,
    trade: {
      underlying: tokenOf(n.deployment, SYMBOL),
      symbol: SYMBOL,
      seriesId,
      strike: usd(STRIKE),
      expiry: EXPIRY,
      isCall: IS_CALL,
      qty: usd(QTY),
      depositUsdg: DEPOSIT_USDG.toString(),
    },
    actors: {},
    funded: '0',
    txs: [],
  };
  if (s.clearinghouse.toLowerCase() !== n.deployment.clearinghouse.toLowerCase()) {
    throw new Error(`${outFile(CHAIN_ID)} belongs to clearinghouse ${s.clearinghouse}; move it away to start over`);
  }
  for (const r of ROLES) s.actors[r] ??= { address: keys[r].address };
  return s;
}

async function plan(n: Novation, keys: Record<Role, LocalAccount>) {
  const seriesId = await seriesIdOf(n);
  const st = loadState(CHAIN_ID);
  const g = await getGlobals(n.ctx);
  const u = tokenOf(n.deployment, SYMBOL);
  const [{ price: spot }, vol, blk] = await Promise.all([getSpot(n.ctx, u), getMarkVol(n.ctx, u), n.client.getBlock()]);
  const bs = await bsQuote(n.ctx, { spot, strike: STRIKE, tau: BigInt(EXPIRY) - blk.timestamp, vol, rate: g.rate, isCall: IS_CALL });
  const price = st?.quote ? quoteOf(st).price : (bs.price / 10n ** 16n) * 10n ** 16n;
  const premium = (QTY * price) / WAD;
  // a subaccount id nobody owns reads as empty: the what-if of a fresh twin before any deposit
  const w2 = st?.actors.w2?.subaccount ? BigInt(st.actors.w2.subaccount) : 10n ** 12n;
  const fresh = !st?.actors.w2?.deposited;
  console.log(`trade: W sells ${usd(QTY)} ${SYMBOL} ${usd(STRIKE)} calls exp ${iso(EXPIRY)} (series ${seriesId}) to C at ${usd(price)} each`);
  console.log(`twin W2 = subaccount ${fresh ? `(not funded yet: equity shown + ${DEPOSIT_USDG} USDG)` : w2}`);
  for (const r of ROLES) line(`${r.toUpperCase()} address`, keys[r].address);
  const w = await whatIf(n, w2, seriesId, premium);
  if (fresh) {
    const x = DEPOSIT_USDG * WAD;
    w.after = { ...w.after, cash: w.after.cash + x, equity: w.after.equity + x, healthy: w.after.equity + x >= BigInt(w.after.im) };
  }
  printWhatIf('W2 what-if', w);
  const cashAfter = w.after.cash;
  console.log('\nspot sensitivity (same book, IM share of equity):');
  console.table(await spotSensitivity(n, w2, seriesId, cashAfter, w.spot));
}

async function friday(n: Novation, deployer: LocalAccount, keys: Record<Role, LocalAccount>) {
  const blk = await n.client.getBlock();
  const now = Number(blk.timestamp);
  const u = tokenOf(n.deployment, SYMBOL);
  const sess = await getSession(n.ctx, u);
  if (baseSession(now) !== 'REGULAR' || sess !== 'REGULAR') throw new Error(`--friday needs the REGULAR session (calendar ${baseSession(now)}, hub ${sess})`);
  if (now % 86400 >= FRIDAY_CUTOFF_UTC_SEC) throw new Error('past 19:30 UTC: too close to the Oct 2 settlement window');
  const seriesId = await seriesIdOf(n);
  const s = initState(n, seriesId, keys);
  saveState(s);
  const snd = new Sender(n, s);

  console.log('1. gas for the throwaway keys');
  await fund(snd, deployer, keys);

  console.log('2. subaccounts and deposits');
  const id = {} as Record<Role, bigint>;
  for (const r of ROLES) id[r] = await ensureSubaccount(snd, keys[r], r);
  await ensureDeposit(snd, keys.c, 'c', id.c, MAKER_DEPOSIT_USDG);
  await ensureDeposit(snd, keys.w1, 'w1', id.w1, DEPOSIT_USDG);
  await ensureDeposit(snd, keys.w2, 'w2', id.w2, DEPOSIT_USDG);
  for (const r of ROLES) line(`${r.toUpperCase()} subaccount`, `${id[r]} (${keys[r].address})`);

  console.log('3. C signs the quote');
  if (!s.quote) {
    s.quote = await signMakerQuote(n, keys.c, id.c, seriesId);
    saveState(s);
  }
  const q = quoteOf(s);
  const premium = rfqPremium(q, QTY);
  line('quote', `${s.quote.hash}: C buys up to ${usd(q.maxQty)} at ${usd(q.price)}, deadline ${iso(q.deadline)}`);

  const done = s.txs.find((t) => t.label.startsWith('W1 fills') && t.status === 'success');
  if (!done) {
    console.log('4. W1 what-if, then the trade');
    const w = await whatIf(n, id.w1, seriesId, premium);
    printWhatIf('W1 what-if', w);
    const eq = w.after.equity;
    const regShare = Number(w.after.im) / Number(eq);
    const wkShare = Number(w.im.WEEKEND) / Number(eq);
    if (!(regShare <= MAX_REGULAR_SHARE && wkShare >= MIN_WEEKEND_SHARE)) {
      throw new Error(`margins no longer bracket equity (REGULAR ${regShare.toFixed(3)}, WEEKEND ${wkShare.toFixed(3)}): re-plan before trading`);
    }
    const data = fillData(q, s.quote.signature, id.w1);
    const sim = await simulateFill(n, keys.w1.address, data);
    if (sim) throw new Error(`W1's fill would revert: ${sim.code} ${sim.message}`);
    s.friday = { w1WhatIf: whatIfJson(w) };
    saveState(s);
    const { rec } = await snd.send(keys.w1, `W1 fills C's quote: sells ${usd(QTY)} ${SYMBOL} ${usd(STRIKE)} calls exp Oct 9 (REGULAR session)`, {
      to: n.deployment.rfq,
      data,
    });
    const after = await getAccountState(n.ctx, id.w1);
    s.friday = {
      ...s.friday,
      tx: rec.tx,
      block: rec.block,
      gasUsed: rec.gasUsed,
      w1After: { equity: usd(after.equity), im: usd(after.im), healthy: after.healthy, imShareOfEquity: pct(after.im, after.equity) },
    };
    saveState(s);
  } else {
    console.log(`4. W1 already traded: ${done.tx}`);
  }

  console.log('5. W2 snapshot at a pinned block');
  const head = await n.client.getBlockNumber();
  const pinned = createNovation({ client: pinnedClient(rpcUrl(), head) as never, deployment: n.deployment });
  const w2 = await whatIf(pinned, id.w2, seriesId, premium);
  printWhatIf('W2 what-if (pinned)', w2);
  const sim = await simulateFill(pinned, keys.w2.address, fillData(q, s.quote.signature, id.w2));
  line('W2 fill simulated at this block', sim ? `reverts ${sim.code}` : 'clears');
  const sens = await spotSensitivity(pinned, id.w2, seriesId, w2.after.cash, w2.spot);
  console.table(sens);
  s.w2Snapshot = { ...whatIfJson(w2), fillSimulation: sim ? sim.code : 'clears', spotSensitivity: sens };
  saveState(s);
  console.log(`\nwrote ${outFile(CHAIN_ID)}`);
}

/** Why a mined transaction reverted: an eth_call replay before its block, and Blockscout's recorded revert data. */
async function explain(n: Novation, hash: Hex) {
  const replay = await explainTx(n.ctx, hash, { explorer: false });
  if (replay) line(`replay at block ${replay.source.kind === 'replay' ? replay.source.block : '?'}`, `${replay.refusal.code} ${json(replay.refusal.numbers)}`);
  else line('replay', 'nothing decoded');
  let explorer: { url: string; raw?: string; decoded?: unknown; result?: string } = { url: `${EXPLORER}/api/v2/transactions/${hash}` };
  for (let i = 0; i < 12; i++) {
    try {
      const r = await fetch(explorer.url, { headers: { accept: 'application/json' } });
      if (r.ok) {
        const j = (await r.json()) as { revert_reason?: { raw?: string } | string | null; result?: string };
        const raw = typeof j.revert_reason === 'object' && j.revert_reason ? j.revert_reason.raw : undefined;
        explorer = { ...explorer, result: j.result, raw };
        if (raw) {
          const d = decodeRefusal(raw as Hex);
          explorer.decoded = d ? { code: d.code, numbers: d.numbers } : undefined;
          break;
        }
      }
    } catch {
      /* explorer indexing lag: retry */
    }
    await sleep(5000);
  }
  line('explorer', `${explorer.result ?? '?'} ${explorer.raw ? json(explorer.decoded) : '(no revert data yet)'}`);
  return {
    replay: replay
      ? { block: replay.source.kind === 'replay' ? replay.source.block : undefined, code: replay.refusal.code, args: replay.refusal.args, numbers: replay.refusal.numbers }
      : null,
    explorer,
  };
}

/** With `check`, runs every pre-send check and stops before sending (any session, nothing written). */
async function saturday(n: Novation, keys: Record<Role, LocalAccount>, opts: { requote: boolean; check: boolean }) {
  const { requote, check } = opts;
  const s = loadState(CHAIN_ID);
  if (!s?.quote || !s.actors.w2?.subaccount) throw new Error('run --friday first');
  const prev = s.txs.find((t) => t.label.startsWith('W2 sends'));
  const fri = s.txs.find((t) => t.label.startsWith('W1 fills') && t.status === 'success');
  if (!fri) throw new Error('no successful Friday fill recorded');
  const snd = new Sender(n, s);
  const w2Id = BigInt(s.actors.w2.subaccount);
  const seriesId = s.trade.seriesId;

  if (prev && check) {
    console.log(`check: W2 already sent ${prev.tx} (${prev.status})`);
    return;
  }
  if (!prev) {
    const blk = await n.client.getBlock();
    const now = Number(blk.timestamp);
    const sess = await getSession(n.ctx, tokenOf(n.deployment, SYMBOL));
    if (baseSession(now) !== 'WEEKEND' || sess !== 'WEEKEND') {
      const msg = `--saturday needs the WEEKEND session (calendar ${baseSession(now)}, hub ${sess})`;
      if (!check) throw new Error(msg);
      console.log(`check: ${msg}; checking anyway`);
    }

    let q = quoteOf(s);
    const filled = await getQuoteFilled(n.ctx, s.quote.hash);
    line('Friday quote', `${s.quote.hash}: ${usd(filled)} of ${usd(q.maxQty)} filled, deadline ${iso(q.deadline)}`);
    if (requote || BigInt(now) + 120n > q.deadline || filled + QTY > q.maxQty) {
      if (!requote) throw new Error('the Friday quote can no longer be filled for the full size: rerun with --requote');
      if (check) throw new Error('--check does not sign a new quote');
      const fresh = await signMakerQuote(n, keys.c, BigInt(s.actors.c!.subaccount!), seriesId);
      s.saturday = { ...(s.saturday ?? {}), requoted: { from: s.quote, reason: 'requested' } };
      s.quote = fresh;
      saveState(s);
      q = quoteOf(s);
    }
    const premium = rfqPremium(q, QTY);

    console.log('1. W2 what-if in the WEEKEND session');
    const w = await whatIf(n, w2Id, seriesId, premium);
    printWhatIf('W2 what-if', w);
    const data = fillData(q, s.quote.signature, w2Id);
    const sim = await simulateFill(n, keys.w2.address, data);
    if (check) {
      line('check: W2 fill simulated', sim ? `reverts ${sim.code} ${json(sim.numbers)}` : 'clears');
      line('check: fixed gas limit', `${(BigInt(fri.gasUsed) * SATURDAY_GAS_PERCENT + 99n) / 100n} (Friday used ${fri.gasUsed})`);
      line('check: W2 gas balance', `${viem.formatEther(await n.client.getBalance({ address: keys.w2.address }))} ETH`);
      return;
    }
    if (w.after.healthy) throw new Error('W2 would clear: the weekend margin does not exceed equity at this spot; re-plan before sending');
    if (!sim || sim.code !== 'InsufficientMargin' || BigInt(sim.args.id as bigint) !== w2Id) {
      throw new Error(`W2's fill must simulate to InsufficientMargin for subaccount ${w2Id}; got ${sim ? `${sim.code} ${json(sim.args)}` : 'success'}`);
    }
    line('W2 fill simulated', `reverts ${sim.code}(id ${sim.args.id}, equity ${usd(sim.args.equity as bigint)}, im ${usd(sim.args.im as bigint)})`);
    s.saturday = { ...(s.saturday ?? {}), w2WhatIf: whatIfJson(w), simulation: { code: sim.code, args: sim.args } };
    saveState(s);

    console.log('2. W2 sends the identical fill with a fixed gas limit');
    const gas = (BigInt(fri.gasUsed) * SATURDAY_GAS_PERCENT + 99n) / 100n;
    const [bal, gasPrice] = await Promise.all([n.client.getBalance({ address: keys.w2.address }), n.client.getGasPrice()]);
    let maxFee = gasPrice * 2n;
    if (gas * maxFee > bal) maxFee = bal / gas;
    if (maxFee < gasPrice) throw new Error(`W2 holds ${viem.formatEther(bal)} ETH: not enough for ${gas} gas at ${gasPrice} wei`);
    await snd.send(
      keys.w2,
      `W2 sends the same fill: sells ${usd(QTY)} ${SYMBOL} ${usd(STRIKE)} calls exp Oct 9 (WEEKEND session)`,
      { to: n.deployment.rfq, data },
      { gas, maxFeePerGas: maxFee, expectRevert: 'InsufficientMargin' },
    );
  }

  const rec = s.txs.find((t) => t.label.startsWith('W2 sends'))!;
  if (rec.status !== 'reverted') throw new Error(`W2's fill was mined as ${rec.status}: ${rec.tx}`);
  if (BigInt(rec.gasUsed) >= BigInt(rec.gasLimit)) throw new Error(`W2's fill used its whole gas limit: ${rec.tx}`);

  console.log('3. why it reverted: eth_call replay before its block, and the explorer record');
  const { replay, explorer } = await explain(n, rec.tx);
  s.saturday = {
    ...(s.saturday ?? {}),
    tx: rec.tx,
    block: rec.block,
    gasUsed: rec.gasUsed,
    gasLimit: rec.gasLimit,
    replay,
    explorer,
  };
  saveState(s);
  console.log(`\nFriday:   ${fri.tx} (block ${fri.block}, ${fri.session}) success`);
  console.log(`Saturday: ${rec.tx} (block ${rec.block}, ${rec.session}) reverted ${replay?.code ?? '?'}`);
  console.log(`wrote ${outFile(CHAIN_ID)}`);
}

// ---------------------------------------------------------------- main

let RPC = '';
const rpcUrl = () => RPC;

async function main() {
  const args = process.argv.slice(2);
  const mode = args.find((a) => ['--plan', '--friday', '--saturday', '--explain'].includes(a)) ?? '--plan';
  const i = args.indexOf('--rpc');
  loadEnv();
  RPC = (i >= 0 ? args[i + 1] : undefined) ?? process.env.RH_TESTNET_RPC ?? 'https://rpc.testnet.chain.robinhood.com';
  const n = createNovation({ chainId: CHAIN_ID, rpcUrl: RPC });
  const keys = { w1: derived('w1'), w2: derived('w2'), c: derived('c') } as Record<Role, LocalAccount>;
  if (mode === '--plan') return plan(n, keys);
  if (mode === '--friday') return friday(n, privateKeyToAccount(deployerKey()), keys);
  if (mode === '--explain') {
    await explain(n, args[args.indexOf('--explain') + 1] as Hex);
    return;
  }
  return saturday(n, keys, { requote: args.includes('--requote'), check: args.includes('--check') });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
