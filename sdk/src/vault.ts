import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from 'viem';
import { clearinghouseAbi, erc20Abi, optionVaultAbi, seriesRegistryAbi, vaultPricingAbi, vaultQuoteLensAbi, vaultQuoteLensBytecode } from './abi/index';
import { decodeRevertData, type Refusal } from './refusal';
import { getSeries } from './registry';
import type { NovationContext, VaultKind } from './types';

/** OptionVaultBase.config(). Fractions are WAD. */
export interface VaultConfig {
  minOtm: bigint;
  maxTenorDays: number;
  skewSlope: bigint;
  utilSlope: bigint;
  spread: bigint;
  /** Vol add per session, REGULAR..HALTED, WAD. */
  sessionVolAdd: readonly bigint[];
  maxTradeQty: bigint;
  maxOpenSeries: number;
  minDelta: bigint;
  maxDelta: bigint;
  minNewSeriesQty: bigint;
}

/** One vault's state. Asset amounts are raw asset units; shares are raw share units. */
export interface VaultState {
  address: Address;
  kind: VaultKind;
  name: string;
  symbol: string;
  /** The stock token the vault writes options on. */
  underlying: Address;
  /** What deposits and exits pay in: the stock token (covered call) or USDG (put write). */
  asset: Address;
  assetDecimals: number;
  /** Asset decimals + 6 (ERC-4626 decimals offset). */
  shareDecimals: number;
  /** The vault's clearinghouse subaccount. */
  vaultId: bigint;
  totalAssets: bigint;
  totalSupply: bigint;
  /** Assets one whole share is worth (convertToAssets(10^shareDecimals)). */
  assetsPerShare: bigint;
  freeAssets: bigint;
  lockedAssets: bigint;
  epoch: bigint;
  escrowedShares: bigint;
  /** Assets held for rolled epochs and not yet claimed (claimRedeemed). */
  reservedAssets: bigint;
  /** The USDG part of those epochs (raw USDG units, claimRedeemedCash); 0 for a put write. */
  reservedCash: bigint;
  live: boolean;
  config: VaultConfig;
  /** EXIT_COOLDOWN, seconds. */
  cooldown: number;
}

export interface VaultHolding {
  shares: bigint;
  /** When the holder last received shares (exit cooldown runs from here). */
  lastReceive: number;
  /** Shares queued in the current epoch. */
  pendingShares: bigint;
  /** Assets claimable now from rolled epochs (claimRedeemed). */
  redeemable: bigint;
  /** Raw USDG units claimable now alongside them (claimRedeemedCash): the cash part of an in-kind exit. */
  redeemableCash: bigint;
  /** The asset part of the most the holder can take out now (0 during the cooldown, a halt, a deficit or a settlement wait). */
  maxWithdraw: bigint;
  maxRedeem: bigint;
}

/**
 * Both parts of a vault exit. A covered-call vault pays exits in kind: the holder's share of the
 * account's USDG cash in USDG, the rest of the value in the stock token. A put-write vault's asset is
 * USDG, so its exits have no second part.
 */
export interface InKindExit {
  /** Raw units of the vault's asset (the stock token for a covered call, USDG for a put write). */
  tokens: bigint;
  /** Raw USDG units paid on top (covered call only). */
  cash: bigint;
}

const v = (address: Address) => ({ address, abi: optionVaultAbi }) as const;

export async function getVault(ctx: NovationContext, address: Address): Promise<VaultState> {
  const c = ctx.client;
  const kind = ctx.deployment.vaults.find((x) => x.address.toLowerCase() === address.toLowerCase())?.type;
  const [name, symbol, underlying, asset, shareDecimals, vaultId, totalAssets, totalSupply, freeAssets, lockedAssets, epoch, escrowedShares, reservedAssets, reservedCash, live, cfg, cooldown] =
    await Promise.all([
      c.readContract({ ...v(address), functionName: 'name' }),
      c.readContract({ ...v(address), functionName: 'symbol' }),
      c.readContract({ ...v(address), functionName: 'underlying' }),
      c.readContract({ ...v(address), functionName: 'asset' }),
      c.readContract({ ...v(address), functionName: 'decimals' }),
      c.readContract({ ...v(address), functionName: 'vaultId' }),
      c.readContract({ ...v(address), functionName: 'totalAssets' }),
      c.readContract({ ...v(address), functionName: 'totalSupply' }),
      c.readContract({ ...v(address), functionName: 'freeAssets' }),
      c.readContract({ ...v(address), functionName: 'lockedAssets' }),
      c.readContract({ ...v(address), functionName: 'epoch' }),
      c.readContract({ ...v(address), functionName: 'escrowedShares' }),
      c.readContract({ ...v(address), functionName: 'reservedAssets' }),
      c.readContract({ ...v(address), functionName: 'reservedCash' }),
      c.readContract({ ...v(address), functionName: 'isLive' }),
      c.readContract({ ...v(address), functionName: 'config' }),
      c.readContract({ ...v(address), functionName: 'EXIT_COOLDOWN' }),
    ]);
  const assetDecimals = Number(await c.readContract({ address: asset, abi: erc20Abi, functionName: 'decimals' }));
  const assetsPerShare = await c.readContract({ ...v(address), functionName: 'convertToAssets', args: [10n ** BigInt(shareDecimals)] });
  return {
    address,
    kind: kind ?? (asset.toLowerCase() === underlying.toLowerCase() ? 'coveredCall' : 'putWrite'),
    name,
    symbol,
    underlying,
    asset,
    assetDecimals,
    shareDecimals: Number(shareDecimals),
    vaultId,
    totalAssets,
    totalSupply,
    assetsPerShare,
    freeAssets,
    lockedAssets,
    epoch,
    escrowedShares,
    reservedAssets,
    reservedCash,
    live,
    config: {
      minOtm: BigInt(cfg.minOtm),
      maxTenorDays: Number(cfg.maxTenorDays),
      skewSlope: BigInt(cfg.skewSlope),
      utilSlope: BigInt(cfg.utilSlope),
      spread: BigInt(cfg.spread),
      sessionVolAdd: cfg.sessionVolAdd.map((x) => BigInt(x)),
      maxTradeQty: cfg.maxTradeQty,
      maxOpenSeries: Number(cfg.maxOpenSeries),
      minDelta: BigInt(cfg.minDelta),
      maxDelta: BigInt(cfg.maxDelta),
      minNewSeriesQty: cfg.minNewSeriesQty,
    },
    cooldown: Number(cooldown),
  };
}

/** Every vault in the deployment. */
export async function getVaults(ctx: NovationContext): Promise<VaultState[]> {
  return Promise.all(ctx.deployment.vaults.map((x) => getVault(ctx, x.address)));
}

/**
 * The vault's premium (WAD USDG) for `qty` (WAD) contracts: the ask when the taker buys, the bid when
 * the taker sells back. Reverts like the trade would on the vault side (ExceedsShort, DustPosition,
 * VaultNotLive). Note it doesn't check the strategy (type, moneyness, tenor, offer band): buy does.
 */
export async function getVaultQuote(ctx: NovationContext, vault: Address, seriesId: number, qty: bigint, takerBuys: boolean): Promise<bigint> {
  return ctx.client.readContract({ ...v(vault), functionName: 'quote', args: [seriesId, qty, takerBuys] });
}

export interface SyncedQuote {
  seriesId: number;
  /** WAD USDG for `qty`, or undefined when the vault refuses that side (see the refusal). */
  ask?: bigint;
  bid?: bigint;
  askRefusal?: Refusal;
  bidRefusal?: Refusal;
}

/**
 * The vault's ask and bid for each series as its next operation would price them: a deployless
 * eth_call of VaultQuoteLens folds the feed's pending rounds into the mark vol first (every vault
 * operation does), so quotes come back while the stored vol is a few rounds behind and the quote()
 * view alone would revert VaultNotLive. `live` is isLive() after that sync. Note quote() doesn't
 * check the strategy (type, moneyness, tenor, offer band): buy does.
 */
export async function getVaultQuotesSynced(
  ctx: NovationContext,
  vault: Address,
  seriesIds: number[],
  qty: bigint,
): Promise<{ live: boolean; quotes: SyncedQuote[] }> {
  // a non-view function, so a raw deployless call rather than readContract
  const { data } = await ctx.client.call({
    code: vaultQuoteLensBytecode,
    data: encodeFunctionData({ abi: vaultQuoteLensAbi, functionName: 'quotes', args: [ctx.deployment.hub, vault, seriesIds, qty] }),
  });
  if (!data) throw new Error('VaultQuoteLens returned nothing');
  const [live, out] = decodeFunctionResult({ abi: vaultQuoteLensAbi, functionName: 'quotes', data });
  const why = (e: Hex) => (e.length > 2 ? decodeRevertData(e) : undefined);
  return {
    live,
    quotes: out.map((q, i) => {
      const askRefusal = why(q.askError);
      const bidRefusal = why(q.bidError);
      return {
        seriesId: seriesIds[i] as number,
        ...(q.askError === '0x' ? { ask: q.ask } : {}),
        ...(q.bidError === '0x' ? { bid: q.bid } : {}),
        ...(askRefusal ? { askRefusal } : {}),
        ...(bidRefusal ? { bidRefusal } : {}),
      };
    }),
  };
}

export async function getVaultHolding(ctx: NovationContext, vault: Address, owner: Address): Promise<VaultHolding> {
  const c = ctx.client;
  const [shares, lastReceive, pendingShares, redeemable, redeemableCash, maxWithdraw, maxRedeem] = await Promise.all([
    c.readContract({ ...v(vault), functionName: 'balanceOf', args: [owner] }),
    c.readContract({ ...v(vault), functionName: 'lastReceive', args: [owner] }),
    c.readContract({ ...v(vault), functionName: 'pendingRedeem', args: [owner] }),
    c.readContract({ ...v(vault), functionName: 'redeemable', args: [owner] }),
    c.readContract({ ...v(vault), functionName: 'redeemableCash', args: [owner] }),
    c.readContract({ ...v(vault), functionName: 'maxWithdraw', args: [owner] }),
    c.readContract({ ...v(vault), functionName: 'maxRedeem', args: [owner] }),
  ]);
  return { shares, lastReceive: Number(lastReceive), pendingShares, redeemable, redeemableCash, maxWithdraw, maxRedeem };
}

/**
 * Both parts of redeeming `shares` now (OptionVaultBase.previewRedeemInKind): `tokens` of the asset
 * and `cash` raw USDG units. previewRedeem alone returns only the asset part.
 */
export async function previewRedeemInKind(ctx: NovationContext, vault: Address, shares: bigint): Promise<InKindExit> {
  const [tokens, cash] = await ctx.client.readContract({ ...v(vault), functionName: 'previewRedeemInKind', args: [shares] });
  return { tokens, cash };
}

/**
 * The per-leg minimums for redeemInKind: each part of a preview less `slippageBps` basis points,
 * rounded down. A part the preview shows as 0 has no minimum.
 */
export function exitMinimums(preview: InKindExit, slippageBps: number | bigint): { minTokens: bigint; minCash: bigint } {
  const bps = BigInt(slippageBps);
  if (bps < 0n || bps > 10_000n) throw new RangeError('slippageBps must be between 0 and 10000');
  const keep = 10_000n - bps;
  return { minTokens: (preview.tokens * keep) / 10_000n, minCash: (preview.cash * keep) / 10_000n };
}

/** Why a vault's deposits and exits wait (see getVaultExitWait). */
export interface VaultExitWait {
  /**
   * The vault's account holds a position whose series has expired and isn't settled into it: its
   * payoff isn't in the expiry's pool yet and NAV marks it at today's spot, not the settlement
   * print. Deposits (maxDeposit reads 0), withdraw, redeem, redeemInKind (maxWithdraw and maxRedeem
   * read 0) and the queue's payout wait until roll settles it. Queuing a redemption still works.
   */
  waiting: boolean;
  /** The expiries holding them, oldest first. */
  expiries: number[];
  /** True while one of them still lacks its settlement price in the registry. */
  awaitingPrice: boolean;
  /** True when the registry has the price of one of them: anyone can roll the vault now to settle it. */
  rollable: boolean;
  /**
   * Unix seconds: when an expiry still lacking its price stops holding the vault (SETTLEMENT_WAIT
   * after it: the 72-hour oracle fallback plus a week). Undefined while a priced one holds it.
   */
  until?: number;
}

/**
 * Whether a vault's deposits and exits wait for an expired series to settle, and which, by the
 * vault's own rule (OptionVaultBase._holdsExpired): an expired position holds them while the
 * registry has its price (roll settles it), or until SETTLEMENT_WAIT after its expiry while the
 * price is still missing.
 */
export async function getVaultExitWait(ctx: NovationContext, vault: Address): Promise<VaultExitWait> {
  const c = ctx.client;
  const [vaultId, wait, block] = await Promise.all([
    c.readContract({ ...v(vault), functionName: 'vaultId' }),
    c.readContract({ ...v(vault), functionName: 'SETTLEMENT_WAIT' }),
    c.getBlock(),
  ]);
  const positions = await c.readContract({ address: ctx.deployment.clearinghouse, abi: clearinghouseAbi, functionName: 'positionsOf', args: [vaultId] });
  const now = Number(block.timestamp);
  const series = (await Promise.all(positions.map((p) => getSeries(ctx, Number(p.seriesId))))).filter((s) => s.expiry <= now);
  const priced = await Promise.all(
    series.map((s) =>
      c.readContract({ address: ctx.deployment.registry, abi: seriesRegistryAbi, functionName: 'settlementPriceOf', args: [s.underlying, BigInt(s.expiry)] }),
    ),
  );
  const expiries = new Set<number>();
  let rollable = false;
  let awaitingPrice = false;
  let until = 0;
  series.forEach((s, i) => {
    const settled = priced[i]![1];
    const end = s.expiry + Number(wait);
    if (settled) {
      rollable = true;
      expiries.add(s.expiry);
    } else if (now <= end) {
      awaitingPrice = true;
      until = Math.max(until, end);
      expiries.add(s.expiry);
    }
  });
  return {
    waiting: expiries.size > 0,
    expiries: [...expiries].sort((a, b) => a - b),
    awaitingPrice,
    rollable,
    ...(awaitingPrice && !rollable ? { until } : {}),
  };
}

/** VaultPricing.unitPrice inputs: WAD amounts, `tau` in seconds. */
export interface VaultPriceInput {
  spot: bigint;
  strike: bigint;
  tau: bigint | number;
  /** The hub's mark vol. */
  vol: bigint;
  skewSlope: bigint;
  /** utilSlope x utilization after the trade (the vault computes it from its book). */
  utilTerm: bigint;
  /** The vault's vol add for the session. */
  sessionAdd: bigint;
  rate: bigint;
  isCall: boolean;
  takerBuys: boolean;
}

function pricingLibrary(ctx: NovationContext, library?: Address): Address {
  const address = library ?? ctx.deployment.libraries?.VaultPricing;
  if (!address) throw new Error('No VaultPricing library recorded for this deployment: pass its address.');
  return address;
}

/**
 * The vaults' price per contract (the linked VaultPricing library, pure): Black-Scholes at
 * vol x (1 + skewSlope x |ln(K/S)| + utilTerm) + sessionAdd, and for a buyback never above the
 * price at the plain mark vol. `library` defaults to the deployment's recorded VaultPricing.
 */
export async function getVaultUnitPrice(ctx: NovationContext, p: VaultPriceInput, library?: Address): Promise<bigint> {
  return ctx.client.readContract({
    address: pricingLibrary(ctx, library),
    abi: vaultPricingAbi,
    functionName: 'unitPrice',
    args: [p.spot, p.strike, BigInt(p.tau), p.vol, p.skewSlope, p.utilTerm, p.sessionAdd, p.rate, p.isCall, p.takerBuys],
  });
}

/** |delta| of the option at `vol` (VaultPricing.absDelta): the number the vaults' offer band checks. */
export async function getVaultAbsDelta(
  ctx: NovationContext,
  p: Pick<VaultPriceInput, 'spot' | 'strike' | 'tau' | 'vol' | 'rate' | 'isCall'>,
  library?: Address,
): Promise<bigint> {
  return ctx.client.readContract({
    address: pricingLibrary(ctx, library),
    abi: vaultPricingAbi,
    functionName: 'absDelta',
    args: [p.spot, p.strike, BigInt(p.tau), p.vol, p.rate, p.isCall],
  });
}

export async function previewDeposit(ctx: NovationContext, vault: Address, assets: bigint): Promise<bigint> {
  return ctx.client.readContract({ ...v(vault), functionName: 'previewDeposit', args: [assets] });
}

/** The shares withdraw(assets) burns: enough that their asset part is `assets` (a covered-call exit pays USDG on top). */
export async function previewWithdraw(ctx: NovationContext, vault: Address, assets: bigint): Promise<bigint> {
  return ctx.client.readContract({ ...v(vault), functionName: 'previewWithdraw', args: [assets] });
}

/** The value of `shares` at NAV, in asset units (an exit pays it partly in USDG: previewRedeemInKind). */
export async function convertToAssets(ctx: NovationContext, vault: Address, shares: bigint): Promise<bigint> {
  return ctx.client.readContract({ ...v(vault), functionName: 'convertToAssets', args: [shares] });
}

/** The shares worth `assets` (asset units) at NAV, rounded down. */
export async function convertToShares(ctx: NovationContext, vault: Address, assets: bigint): Promise<bigint> {
  return ctx.client.readContract({ ...v(vault), functionName: 'convertToShares', args: [assets] });
}

/** maxDeposit(receiver): unlimited while live and not in deficit, else 0. */
export async function getMaxDeposit(ctx: NovationContext, vault: Address, receiver: Address): Promise<bigint> {
  return ctx.client.readContract({ ...v(vault), functionName: 'maxDeposit', args: [receiver] });
}
