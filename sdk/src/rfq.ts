import type { Address, Hex } from 'viem';
import { rfqVenueAbi } from './abi/index';
import { hashQuote, rfqDomain } from './quote712';
import type { NovationContext, RfqQuote } from './types';

const r = (ctx: NovationContext) => ({ address: ctx.deployment.rfq, abi: rfqVenueAbi }) as const;

const tuple = (q: RfqQuote) => ({
  signer: q.signer,
  makerId: q.makerId,
  seriesId: q.seriesId,
  makerSells: q.makerSells,
  maxQty: q.maxQty,
  price: q.price,
  deadline: q.deadline,
  nonce: q.nonce,
});

/** The venue's EIP-712 domain on this deployment. */
export function getRfqDomain(ctx: NovationContext) {
  return rfqDomain(ctx.deployment.chainId, ctx.deployment.rfq);
}

/** The quote's digest, computed locally against this deployment's venue. */
export function quoteHash(ctx: NovationContext, q: RfqQuote): Hex {
  return hashQuote(q, getRfqDomain(ctx));
}

/** RfqVenue.hashQuote, on chain. Equal to quoteHash for the same deployment. */
export async function getQuoteHashOnChain(ctx: NovationContext, q: RfqQuote): Promise<Hex> {
  return ctx.client.readContract({ ...r(ctx), functionName: 'hashQuote', args: [tuple(q)] });
}

/** WAD contracts already filled against the quote with this digest. */
export async function getQuoteFilled(ctx: NovationContext, hash: Hex): Promise<bigint> {
  return ctx.client.readContract({ ...r(ctx), functionName: 'filled', args: [hash] });
}

export async function isNonceCancelled(ctx: NovationContext, signer: Address, nonce: bigint): Promise<boolean> {
  return ctx.client.readContract({ ...r(ctx), functionName: 'isNonceCancelled', args: [signer, nonce] });
}

/** What is left to fill on a quote: maxQty less what was filled, zero once cancelled or expired. */
export async function getQuoteRemaining(ctx: NovationContext, q: RfqQuote, now?: number): Promise<bigint> {
  const t = now ?? Number((await ctx.client.getBlock()).timestamp);
  if (BigInt(t) > q.deadline) return 0n;
  const [filled, cancelled] = await Promise.all([getQuoteFilled(ctx, quoteHash(ctx, q)), isNonceCancelled(ctx, q.signer, q.nonce)]);
  if (cancelled) return 0n;
  return q.maxQty > filled ? q.maxQty - filled : 0n;
}

/** Premium the venue charges for `qty` of `q`: rounded against the payer (up when the taker buys). */
export function rfqPremium(q: RfqQuote, qty: bigint): bigint {
  const p = qty * q.price;
  if (!q.makerSells) return p / 10n ** 18n;
  return p === 0n ? 0n : (p - 1n) / 10n ** 18n + 1n;
}

export { tuple as quoteTuple };
