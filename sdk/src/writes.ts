/**
 * Write helpers. Each one runs viem's simulateContract (an eth_call of the exact transaction from
 * `account`) and returns `{ request, result }`: hand `request` to a wallet client's writeContract to
 * send it. A simulation that reverts with a known error throws RefusalError (code and numbers), so
 * a refused transaction is caught before anything is signed.
 */
import type { Account, Address, Hash, Hex, PublicClient, TransactionReceipt, WalletClient } from 'viem';
import {
  auctionHouseAbi,
  clearinghouseAbi,
  marketDataHubAbi,
  mockAggregatorAbi,
  mockUsdgAbi,
  optionVaultAbi,
  rfqVenueAbi,
  seriesRegistryAbi,
  erc20Abi,
} from './abi/index';
import { explainTx, RefusalError, throwAsRefusal } from './refusal';
import { quoteTuple } from './rfq';
import type { AgentPolicy, NovationContext, RfqQuote } from './types';

type Who = Account | Address;

async function guard<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    return throwAsRefusal(e);
  }
}

const ch = (ctx: NovationContext) => ({ address: ctx.deployment.clearinghouse, abi: clearinghouseAbi }) as const;
const vault = (address: Address) => ({ address, abi: optionVaultAbi }) as const;

// ---------------------------------------------------------------- tokens

export function simulateApprove(ctx: NovationContext, account: Who, token: Address, spender: Address, amount: bigint) {
  return guard(ctx.client.simulateContract({ address: token, abi: erc20Abi, functionName: 'approve', args: [spender, amount], account }));
}

/** Testnet mocks only (MockUSDG, MockStockToken): anyone may mint. */
export function simulateMint(ctx: NovationContext, account: Who, token: Address, to: Address, amount: bigint) {
  return guard(ctx.client.simulateContract({ address: token, abi: mockUsdgAbi, functionName: 'mint', args: [to, amount], account }));
}

// ---------------------------------------------------------------- accounts and funds

export function simulateCreateSubaccount(ctx: NovationContext, account: Who) {
  return guard(ctx.client.simulateContract({ ...ch(ctx), functionName: 'createSubaccount', account }));
}

/** `amount` in raw token units. USDG becomes cash; a stock token becomes collateral (owner only). Needs an allowance. */
export function simulateDeposit(ctx: NovationContext, account: Who, id: bigint | number, token: Address, amount: bigint) {
  return guard(ctx.client.simulateContract({ ...ch(ctx), functionName: 'deposit', args: [BigInt(id), token, amount], account }));
}

/** Owner only, `amount` in raw token units; an account with positions must stay above initial margin. */
export function simulateWithdraw(ctx: NovationContext, account: Who, id: bigint | number, token: Address, amount: bigint, to: Address) {
  return guard(ctx.client.simulateContract({ ...ch(ctx), functionName: 'withdraw', args: [BigInt(id), token, amount, to], account }));
}

export function simulateGrantAgent(ctx: NovationContext, account: Who, id: bigint | number, agent: Address, p: AgentPolicy) {
  const policy = { maxWorstLoss: p.maxWorstLoss, maxPremiumPerTrade: p.maxPremiumPerTrade, allowedMask: p.allowedMask, expiresAt: BigInt(p.expiresAt) };
  return guard(ctx.client.simulateContract({ ...ch(ctx), functionName: 'grantAgent', args: [BigInt(id), agent, policy], account }));
}

export function simulateRevokeAgent(ctx: NovationContext, account: Who, id: bigint | number, agent: Address) {
  return guard(ctx.client.simulateContract({ ...ch(ctx), functionName: 'revokeAgent', args: [BigInt(id), agent], account }));
}

// ---------------------------------------------------------------- settlement

export function simulateSettleAccount(ctx: NovationContext, account: Who, id: bigint | number, expiry: number) {
  return guard(ctx.client.simulateContract({ ...ch(ctx), functionName: 'settleAccount', args: [BigInt(id), BigInt(expiry)], account }));
}

export function simulateClaim(ctx: NovationContext, account: Who, id: bigint | number, expiry: number) {
  return guard(ctx.client.simulateContract({ ...ch(ctx), functionName: 'claim', args: [BigInt(id), BigInt(expiry)], account }));
}

export function simulateRepayDeficit(ctx: NovationContext, account: Who, id: bigint | number) {
  return guard(ctx.client.simulateContract({ ...ch(ctx), functionName: 'repayDeficit', args: [BigInt(id)], account }));
}

export function simulateSettleExpiry(ctx: NovationContext, account: Who, underlying: Address, expiry: number, roundIdHint: bigint) {
  return guard(
    ctx.client.simulateContract({
      address: ctx.deployment.registry,
      abi: seriesRegistryAbi,
      functionName: 'settleExpiry',
      args: [underlying, BigInt(expiry), roundIdHint],
      account,
    }),
  );
}

export function simulateListSeries(ctx: NovationContext, account: Who, underlying: Address, expiry: number, strike: bigint, isCall: boolean) {
  return guard(
    ctx.client.simulateContract({
      address: ctx.deployment.registry,
      abi: seriesRegistryAbi,
      functionName: 'listSeries',
      args: [underlying, BigInt(expiry), strike, isCall],
      account,
    }),
  );
}

// ---------------------------------------------------------------- market data

/** Permissionless: folds every pending feed round into the hub's mark vol. */
export function simulateSyncVol(ctx: NovationContext, account: Who, token: Address) {
  return guard(ctx.client.simulateContract({ address: ctx.deployment.hub, abi: marketDataHubAbi, functionName: 'syncVol', args: [token], account }));
}

/** Testnet MockAggregator only: pushes the next round. */
export function simulatePushRound(ctx: NovationContext, account: Who, feed: Address, answer: bigint, updatedAt: bigint) {
  return guard(ctx.client.simulateContract({ address: feed, abi: mockAggregatorAbi, functionName: 'pushRound', args: [answer, updatedAt], account }));
}

// ---------------------------------------------------------------- vaults

/** The caller (owner or agent of `takerId`) buys `qty` WAD contracts from the vault, paying at most `maxPremium` (WAD USDG). */
export function simulateVaultBuy(ctx: NovationContext, account: Who, v: Address, seriesId: number, qty: bigint, maxPremium: bigint, takerId: bigint | number) {
  return guard(ctx.client.simulateContract({ ...vault(v), functionName: 'buy', args: [seriesId, qty, maxPremium, BigInt(takerId)], account }));
}

export function simulateVaultSellBack(ctx: NovationContext, account: Who, v: Address, seriesId: number, qty: bigint, minPremium: bigint, takerId: bigint | number) {
  return guard(ctx.client.simulateContract({ ...vault(v), functionName: 'sellBack', args: [seriesId, qty, minPremium, BigInt(takerId)], account }));
}

/** ERC-4626 deposit of `assets` raw asset units; needs an allowance to the vault. */
export function simulateVaultDeposit(ctx: NovationContext, account: Who, v: Address, assets: bigint, receiver: Address) {
  return guard(ctx.client.simulateContract({ ...vault(v), functionName: 'deposit', args: [assets, receiver], account }));
}

export function simulateVaultWithdraw(ctx: NovationContext, account: Who, v: Address, assets: bigint, receiver: Address, owner: Address) {
  return guard(ctx.client.simulateContract({ ...vault(v), functionName: 'withdraw', args: [assets, receiver, owner], account }));
}

export function simulateVaultRedeem(ctx: NovationContext, account: Who, v: Address, shares: bigint, receiver: Address, owner: Address) {
  return guard(ctx.client.simulateContract({ ...vault(v), functionName: 'redeem', args: [shares, receiver, owner], account }));
}

/** Escrows `shares` for the current epoch; the roll that pays the epoch makes them claimable. */
export function simulateRequestRedeem(ctx: NovationContext, account: Who, v: Address, shares: bigint, receiver: Address) {
  return guard(ctx.client.simulateContract({ ...vault(v), functionName: 'requestRedeem', args: [shares, receiver], account }));
}

export function simulateClaimRedeemed(ctx: NovationContext, account: Who, v: Address, receiver: Address) {
  return guard(ctx.client.simulateContract({ ...vault(v), functionName: 'claimRedeemed', args: [receiver], account }));
}

export function simulateVaultRoll(ctx: NovationContext, account: Who, v: Address, expiries: number[]) {
  return guard(ctx.client.simulateContract({ ...vault(v), functionName: 'roll', args: [expiries.map(BigInt)], account }));
}

// ---------------------------------------------------------------- RFQ

/** The caller (owner or agent of `takerId`) fills `qty` WAD of a maker's signed quote. */
export function simulateRfqFill(ctx: NovationContext, account: Who, q: RfqQuote, signature: Hex, takerId: bigint | number, qty: bigint) {
  return guard(
    ctx.client.simulateContract({
      address: ctx.deployment.rfq,
      abi: rfqVenueAbi,
      functionName: 'fill',
      args: [quoteTuple(q), signature, BigInt(takerId), qty],
      account,
    }),
  );
}

export function simulateCancelNonce(ctx: NovationContext, account: Who, nonce: bigint) {
  return guard(ctx.client.simulateContract({ address: ctx.deployment.rfq, abi: rfqVenueAbi, functionName: 'cancelNonce', args: [nonce], account }));
}

// ---------------------------------------------------------------- auctions

export function simulateStartLiquidation(ctx: NovationContext, account: Who, id: bigint | number) {
  return guard(
    ctx.client.simulateContract({ address: ctx.deployment.auctionHouse, abi: auctionHouseAbi, functionName: 'startLiquidation', args: [BigInt(id)], account }),
  );
}

export function simulateBidLiquidation(ctx: NovationContext, account: Who, id: bigint | number, fractionWad: bigint, bidderId: bigint | number, maxPayWad: bigint) {
  return guard(
    ctx.client.simulateContract({
      address: ctx.deployment.auctionHouse,
      abi: auctionHouseAbi,
      functionName: 'bidLiquidation',
      args: [BigInt(id), fractionWad, BigInt(bidderId), maxPayWad],
      account,
    }),
  );
}

// ---------------------------------------------------------------- sending

/**
 * Sends a simulated request and waits for it. A transaction that still reverts on chain (state
 * moved between simulation and inclusion) is replayed and thrown as RefusalError when the revert
 * is one we know.
 */
export async function sendRequest(
  wallet: WalletClient,
  client: PublicClient,
  ctx: NovationContext | undefined,
  request: Parameters<WalletClient['writeContract']>[0],
): Promise<{ hash: Hash; receipt: TransactionReceipt }> {
  const hash = await wallet.writeContract(request);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    const why = ctx ? await explainTx(ctx, hash).catch(() => undefined) : undefined;
    if (why) throw new RefusalError(why.refusal);
    throw new Error(`transaction ${hash} reverted`);
  }
  return { hash, receipt };
}
