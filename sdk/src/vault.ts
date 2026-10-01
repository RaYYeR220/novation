import type { Address } from 'viem';
import { erc20Abi, optionVaultAbi } from './abi/index';
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
  reservedAssets: bigint;
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
  /** Assets claimable now from rolled epochs. */
  redeemable: bigint;
  maxWithdraw: bigint;
  maxRedeem: bigint;
}

const v = (address: Address) => ({ address, abi: optionVaultAbi }) as const;

export async function getVault(ctx: NovationContext, address: Address): Promise<VaultState> {
  const c = ctx.client;
  const kind = ctx.deployment.vaults.find((x) => x.address.toLowerCase() === address.toLowerCase())?.type;
  const [name, symbol, underlying, asset, shareDecimals, vaultId, totalAssets, totalSupply, freeAssets, lockedAssets, epoch, escrowedShares, reservedAssets, live, cfg, cooldown] =
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

export async function getVaultHolding(ctx: NovationContext, vault: Address, owner: Address): Promise<VaultHolding> {
  const c = ctx.client;
  const [shares, lastReceive, pendingShares, redeemable, maxWithdraw, maxRedeem] = await Promise.all([
    c.readContract({ ...v(vault), functionName: 'balanceOf', args: [owner] }),
    c.readContract({ ...v(vault), functionName: 'lastReceive', args: [owner] }),
    c.readContract({ ...v(vault), functionName: 'pendingRedeem', args: [owner] }),
    c.readContract({ ...v(vault), functionName: 'redeemable', args: [owner] }),
    c.readContract({ ...v(vault), functionName: 'maxWithdraw', args: [owner] }),
    c.readContract({ ...v(vault), functionName: 'maxRedeem', args: [owner] }),
  ]);
  return { shares, lastReceive: Number(lastReceive), pendingShares, redeemable, maxWithdraw, maxRedeem };
}

export async function previewDeposit(ctx: NovationContext, vault: Address, assets: bigint): Promise<bigint> {
  return ctx.client.readContract({ ...v(vault), functionName: 'previewDeposit', args: [assets] });
}

export async function previewWithdraw(ctx: NovationContext, vault: Address, assets: bigint): Promise<bigint> {
  return ctx.client.readContract({ ...v(vault), functionName: 'previewWithdraw', args: [assets] });
}

export async function convertToAssets(ctx: NovationContext, vault: Address, shares: bigint): Promise<bigint> {
  return ctx.client.readContract({ ...v(vault), functionName: 'convertToAssets', args: [shares] });
}

/** maxDeposit(receiver): unlimited while live and not in deficit, else 0. */
export async function getMaxDeposit(ctx: NovationContext, vault: Address, receiver: Address): Promise<bigint> {
  return ctx.client.readContract({ ...v(vault), functionName: 'maxDeposit', args: [receiver] });
}
