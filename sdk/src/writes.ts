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

/**
 * Permissionless: records that collateral `token` has no price now (with its feed's round), or
 * clears the record once it has one. A token marked 72 hours ago whose feed still shows the same
 * round and no price counts as 0 in socializeRemainder's dust test (see getPriceOutage).
 */
export function simulateMarkUnpriced(ctx: NovationContext, account: Who, token: Address) {
  return guard(ctx.client.simulateContract({ ...ch(ctx), functionName: 'markUnpriced', args: [token], account }));
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

/**
 * 72 hours after the close, when the last pre-close print is stale or outside the band: settles at
 * the first round printed after the close (`firstAfterHint`), which must be in the band.
 */
export function simulateSettleExpiryFallback(ctx: NovationContext, account: Who, underlying: Address, expiry: number, firstAfterHint: bigint) {
  return guard(
    ctx.client.simulateContract({
      address: ctx.deployment.registry,
      abi: seriesRegistryAbi,
      functionName: 'settleExpiryFallback',
      args: [underlying, BigInt(expiry), firstAfterHint],
      account,
    }),
  );
}

/**
 * The last resort, 7 days after the close: the last print at or before it (proven last as for
 * settleExpiry) without the lag bound, for a feed that died or whose first post-close print is
 * implausible. Reverts FallbackApplies while that first print is in the band (the 72-hour fallback
 * gives the price then).
 */
export function simulateSettleExpiryLastResort(ctx: NovationContext, account: Who, underlying: Address, expiry: number, roundIdHint: bigint) {
  return guard(
    ctx.client.simulateContract({
      address: ctx.deployment.registry,
      abi: seriesRegistryAbi,
      functionName: 'settleExpiryLastResort',
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

/** syncVol folding at most `maxRounds` (1 to 64) rounds; the result says whether the vol is then current. */
export function simulateSyncVolUpTo(ctx: NovationContext, account: Who, token: Address, maxRounds: number) {
  return guard(
    ctx.client.simulateContract({ address: ctx.deployment.hub, abi: marketDataHubAbi, functionName: 'syncVolUpTo', args: [token, BigInt(maxRounds)], account }),
  );
}

/**
 * Permissionless, after an aggregator migration: folds what is left of the old phase (up to 64
 * rounds) and rebases onto the new one in one transaction. The result is false when more than 64
 * old rounds were left (call again). Reverts NoPhaseChange when the feed hasn't moved phase.
 */
export function simulateSyncAndRebaseVol(ctx: NovationContext, account: Who, token: Address) {
  return guard(ctx.client.simulateContract({ address: ctx.deployment.hub, abi: marketDataHubAbi, functionName: 'syncAndRebaseVol', args: [token], account }));
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

/**
 * ERC-4626 redeem. For a covered-call vault the result is the token part only; the USDG part goes to
 * `receiver` on top. Prefer simulateVaultRedeemInKind, which returns and bounds both.
 */
export function simulateVaultRedeem(ctx: NovationContext, account: Who, v: Address, shares: bigint, receiver: Address, owner: Address) {
  return guard(ctx.client.simulateContract({ ...vault(v), functionName: 'redeem', args: [shares, receiver, owner], account }));
}

/**
 * Redeems `shares` in kind: `result` is [tokens, cash] (raw asset units, raw USDG units). Reverts
 * BelowMinOut unless each part meets its minimum: take them from previewRedeemInKind less a slippage
 * allowance (exitMinimums).
 */
export function simulateVaultRedeemInKind(
  ctx: NovationContext,
  account: Who,
  v: Address,
  shares: bigint,
  receiver: Address,
  owner: Address,
  minTokens: bigint,
  minCash: bigint,
) {
  return guard(
    ctx.client.simulateContract({ ...vault(v), functionName: 'redeemInKind', args: [shares, receiver, owner, minTokens, minCash], account }),
  );
}

/** Escrows `shares` for the current epoch; the roll that pays the epoch makes them claimable. */
export function simulateRequestRedeem(ctx: NovationContext, account: Who, v: Address, shares: bigint, receiver: Address) {
  return guard(ctx.client.simulateContract({ ...vault(v), functionName: 'requestRedeem', args: [shares, receiver], account }));
}

/** Pays `receiver` the asset part of its rolled redemptions (anyone may call it). */
export function simulateClaimRedeemed(ctx: NovationContext, account: Who, v: Address, receiver: Address) {
  return guard(ctx.client.simulateContract({ ...vault(v), functionName: 'claimRedeemed', args: [receiver], account }));
}

/** Pays `receiver` the USDG part of its rolled redemptions (covered call; anyone may call it). */
export function simulateClaimRedeemedCash(ctx: NovationContext, account: Who, v: Address, receiver: Address) {
  return guard(ctx.client.simulateContract({ ...vault(v), functionName: 'claimRedeemedCash', args: [receiver], account }));
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

/**
 * Permissionless: ends the liquidation of an account that is no longer liquidatable (it recovered
 * without a bid), so a later fall starts a fresh ramp. Reverts AuctionNotActive or StillLiquidatable.
 */
export function simulateEndLiquidation(ctx: NovationContext, account: Who, id: bigint | number) {
  return guard(
    ctx.client.simulateContract({ address: ctx.deployment.auctionHouse, abi: auctionHouseAbi, functionName: 'endLiquidation', args: [BigInt(id)], account }),
  );
}

/**
 * The caller (owner of `bidderId`) buys `tokenWad` of the account's `token` collateral in its
 * `expiry` deficit sale at spot less the discount, paying at most `maxPayWad`.
 */
export function simulateBidDeficit(
  ctx: NovationContext,
  account: Who,
  id: bigint | number,
  expiry: number,
  token: Address,
  tokenWad: bigint,
  bidderId: bigint | number,
  maxPayWad: bigint,
) {
  return guard(
    ctx.client.simulateContract({
      address: ctx.deployment.auctionHouse,
      abi: auctionHouseAbi,
      functionName: 'bidDeficit',
      args: [BigInt(id), BigInt(expiry), token, tokenWad, BigInt(bidderId), maxPayWad],
      account,
    }),
  );
}

/**
 * Permissionless: ends the deficit sale of (`id`, `expiry`) once the account owes nothing for it
 * (repaid by its own cash rather than a bid), so a later deficit starts a fresh ramp. Reverts
 * SaleNotActive or ExceedsDeficit.
 */
export function simulateEndDeficitSale(ctx: NovationContext, account: Who, id: bigint | number, expiry: number) {
  return guard(
    ctx.client.simulateContract({
      address: ctx.deployment.auctionHouse,
      abi: auctionHouseAbi,
      functionName: 'endDeficitSale',
      args: [BigInt(id), BigInt(expiry)],
      account,
    }),
  );
}

// ---------------------------------------------------------------- sending

/** Gas headroom over the estimate, in percent. Black-Scholes inside the margin check costs a little
 * more or less gas at a different block timestamp, so an exact estimate can run out by a few percent. */
export const GAS_HEADROOM_PERCENT = 125n;

/** `estimate` with the headroom added. */
export function padGas(estimate: bigint): bigint {
  return (estimate * GAS_HEADROOM_PERCENT) / 100n;
}

/**
 * Estimates a simulated request's gas (from the request's own account) and returns it with the
 * headroom set as `gas`. Every write should go out through this.
 */
export async function withGasHeadroom<R extends object>(client: PublicClient, request: R): Promise<R & { gas: bigint }> {
  const estimate = await client.estimateContractGas(request as unknown as Parameters<PublicClient['estimateContractGas']>[0]);
  return { ...request, gas: padGas(estimate) };
}

/** The address a simulated request was simulated from (its `account`), if it names one. */
export function simulatedAccountOf(request: unknown): Address | undefined {
  const a = (request as { account?: Address | { address?: Address } } | undefined)?.account;
  return typeof a === 'string' ? a : a?.address;
}

/**
 * Throws unless `request` was simulated for `signer`: a wallet that switched accounts after the
 * simulation must not sign a transaction checked for someone else. A request that names no account
 * passes.
 */
export function assertSimulatedFor(request: unknown, signer: Address): void {
  const from = simulatedAccountOf(request);
  if (from && from.toLowerCase() !== signer.toLowerCase()) {
    throw new Error(`The request was simulated for ${from}, but the wallet signs as ${signer}.`);
  }
}

/**
 * Signs a simulated request locally, sends it with gas headroom and waits for it. `wallet` must be
 * bound to a LocalAccount (privateKeyToAccount): public RPCs such as Robinhood Chain testnet's refuse
 * eth_sendTransaction, so nothing here asks the node to sign. A transaction that still reverts on
 * chain (state moved between simulation and inclusion) is explained and thrown as RefusalError when
 * the revert is one we know.
 */
export async function sendRequest(
  wallet: WalletClient,
  client: PublicClient,
  ctx: NovationContext | undefined,
  request: Parameters<WalletClient['writeContract']>[0],
): Promise<{ hash: Hash; receipt: TransactionReceipt }> {
  const account = wallet.account;
  if (!account || account.type !== 'local') {
    throw new Error('sendRequest signs locally: pass a wallet client bound to a LocalAccount (viem/accounts privateKeyToAccount).');
  }
  assertSimulatedFor(request, account.address);
  const req = await withGasHeadroom(client, { ...request, account } as Parameters<WalletClient['writeContract']>[0]);
  const hash = await wallet.writeContract(req);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    const why = ctx ? await explainTx(ctx, hash).catch(() => undefined) : undefined;
    if (why) throw new RefusalError(why.refusal);
    throw new Error(`transaction ${hash} reverted`);
  }
  return { hash, receipt };
}
