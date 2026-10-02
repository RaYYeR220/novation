import { BaseError, decodeErrorResult, isHex, type Hash, type Hex } from 'viem';
import { novationErrorsAbi } from './abi/errors';
import type { NovationContext } from './types';

type ErrorItem = Extract<(typeof novationErrorsAbi)[number], { type: 'error' }>;
type ErrorInputs = readonly { name: string; type: string }[];
/** Every custom error name a Novation contract can revert with, plus Solidity's Error and Panic. */
export type RefusalCode = ErrorItem['name'] | 'Error' | 'Panic';

/**
 * A decoded on-chain refusal: the custom error's name, its arguments by name (raw), and the numeric
 * ones as floats. WAD-denominated arguments (amounts, prices, quantities) are divided by 1e18; ids,
 * timestamps and raw token amounts are kept as plain integers.
 */
export interface Refusal {
  code: RefusalCode | (string & {});
  /** One sentence: what the rule is. */
  message: string;
  /** The 4-byte selector of the revert data. */
  selector: Hex;
  args: Record<string, bigint | string | boolean>;
  numbers: Record<string, number>;
}

/** Arguments that are integers, not WAD amounts. */
const INTEGER_ARGS = new Set(['id', 'bidderId', 'until', 'bits', 'requestId', 'epoch', 'code', 'index']);
/** Errors whose numeric arguments are raw token or share units (or plain integers), not WAD. */
const RAW_ERRORS = /^(ERC20|ERC4626|ERC721|SafeCast|Panic|ExceedsFreeAssets|BelowMinOut)/;

const MESSAGES: Partial<Record<RefusalCode, string>> = {
  InsufficientMargin: 'Initial margin after the trade exceeds equity.',
  InsufficientCash: 'Cash does not cover the premium and fee. There is no cash borrowing.',
  InsufficientCollateral: 'The account holds less of that token than requested.',
  AgentRiskBudgetExceeded: "Worst-case loss after this trade exceeds the agent's risk budget.",
  AgentPremiumExceeded: "Premium exceeds the agent's per-trade cap.",
  AgentValueDrainExceeded: "The trade gives up more value than the agent's cap.",
  AgentUnderlyingNotAllowed: 'The agent may not trade this underlying.',
  OpeningNotAllowed: 'Opening trades are refused: the underlying is halted, opening is paused, or the account owes a deficit.',
  OpenInterestCap: 'The series is at its open interest cap.',
  RiskIncreaseNotAllowed: "While opening is blocked, a trade may not raise the account's worst-case loss.",
  NotAuthorized: 'The signer is neither the owner nor a live agent of the account.',
  NotOwner: 'Only the account owner can do this.',
  InDeficit: 'The account owes a deficit: withdrawals wait until it is repaid.',
  DustPosition: 'The position left would be below the minimum trade size.',
  QtyTooSmall: 'The quantity is below the minimum trade size.',
  SeriesExpired: 'The series has expired.',
  UnknownSeries: 'No such series.',
  UnknownAccount: 'No such subaccount.',
  SelfTrade: 'An account cannot trade with itself.',
  ZeroAmount: 'The amount is zero.',
  TokenNotAllowed: 'The token is not accepted as collateral.',
  DepositNotAllowed: 'Only the owner can deposit stock tokens into an account, and not while it owes a deficit.',
  TooManyPositions: 'The account holds the maximum number of series.',
  TooManyUnderlyings: 'The maximum number of underlyings is reached (per account, or in the registry).',
  TooManyClaimExpiries: 'The account would hold unpaid claims on more expiries than a liquidation bid may move: claim the ready ones first.',
  FallbackApplies: "The first print after the close is in the band: the 72-hour fallback settles this expiry, not the last resort.",
  UnderlyingDisabled: 'The underlying is disabled.',
  InvalidAgent: 'The agent must be a non-zero address other than the owner.',
  InvalidExpiry: 'The grant must expire in the future.',
  InvalidRecipient: 'The recipient is not valid.',
  VaultNotLive: 'The vault is not live: its underlying is halted or its mark vol is stale.',
  VolNotCurrent: "The mark vol is behind the feed's latest round: run syncVol first (a liquidation folds up to 8 rounds itself).",
  BadQty: 'The quantity is zero or above the vault’s per-trade maximum.',
  TenorTooLong: 'The vault does not sell expiries that far out.',
  StrikeNotOtm: 'The vault only sells strikes out of the money by its minimum distance.',
  WrongOptionType: 'The vault does not sell this option type.',
  WrongUnderlying: 'The series is not on the vault’s underlying.',
  TooManySeries: 'The vault is short its maximum number of series.',
  OutsideOfferBand: 'The vault only sells options whose delta is inside its offer band.',
  BelowMinNewSeries: 'A first sale in a series must be at least the vault’s minimum size.',
  VaultInDeficit: 'The vault owes a deficit.',
  ExitCooldown: 'Shares cannot leave within the exit cooldown after they arrive.',
  ExceedsCapacity: 'The vault does not have the backing to sell that much.',
  ExceedsShort: 'The vault buys back at most its short in the series.',
  ExceedsFreeAssets: 'Only the free assets can leave now; the rest waits for a roll.',
  BelowMinOut: 'The exit pays less than your minimum on one of its parts (tokens or USDG).',
  BadReceiver: 'The vault itself cannot receive a redemption.',
  PremiumAboveMax: 'The premium moved above your maximum.',
  PremiumBelowMin: 'The premium moved below your minimum.',
  NothingToClaim: 'Nothing to claim yet.',
  ZeroShares: 'The share amount is zero.',
  QuoteExpired: 'The quote has expired.',
  NonceCancelled: 'The maker cancelled this quote.',
  BadSignature: 'The quote signature does not match its signer.',
  SignerNotAuthorized: "The quote's signer can no longer act for the maker account.",
  Overfill: 'The fill exceeds what the quote has left.',
  NoPrice: 'The feed has no usable price.',
  ImplausiblePrice: "The feed's price is outside its plausibility band.",
  NothingToSettle: 'Nothing to settle for that expiry.',
  ExpiryNotSettled: 'The expiry has no settlement price yet.',
  PoolNotReady: 'The pool is not ready: shorts are unsettled or a shortfall is pending.',
  PoolShortfall: 'The pool cannot pay the claim.',
  NotLiquidatable: 'The account is above maintenance margin.',
  StillLiquidatable: 'The account is still below maintenance margin: its liquidation goes on.',
  AuctionActive: 'A liquidation of this account is already running.',
  AuctionNotActive: 'No liquidation of this account is running.',
  SaleNotActive: 'No deficit sale is running for that account and expiry.',
  FractionTooLarge: 'The bid takes a larger fraction of the account than one bid may.',
  PayAboveMax: 'The bid would pay more than your maximum.',
  SelfBid: 'An account cannot bid on itself.',
  NotBidder: 'Only the owner of the bidding account can bid with it.',
  BidderInDeficit: 'The bidding account owes a deficit.',
  ExceedsCollateral: 'The bid asks for more of the token than the account holds.',
  ExceedsDeficit: 'The bid buys more tokens than the account still owes.',
  NothingToSocialize: 'The account has no pending deficit to spread.',
  UnderlyingHalted: 'The underlying is halted, so no series can be listed now.',
  NotWeeklyExpiry: 'Series expire at the weekly close only.',
  BadExpiry: 'The expiry is in the past or further out than listing allows.',
  BadStrike: 'The strike is zero or off the strike grid.',
  StrikeTooFar: 'The strike is too far from spot to list.',
  AlreadySettled: 'That expiry is already settled.',
  TooEarly: 'Too early: the expiry (or the fallback delay after it) has not passed yet.',
  BadHint: 'That feed round cannot settle this expiry.',
  FallbackNotAllowed: 'The fallback price is only for an expiry without a usable print.',
  NotExpiry: 'That time is not a weekly expiry.',
  MarketClosed: 'Auctions pause while an underlying is halted or in a weekend session.',
  BidRaisesRisk: "The bid would raise the bidder's worst-case loss beyond its margin.",
  BidderUnhealthy: 'The bidder would be below initial margin after the bid.',
  ERC20InsufficientBalance: 'The wallet does not hold enough of the token.',
  ERC20InsufficientAllowance: 'The token allowance is too low: approve it first.',
  ERC4626ExceededMaxDeposit: 'The vault accepts no deposit right now.',
  ERC4626ExceededMaxWithdraw: 'More than the vault lets you withdraw now.',
  ERC4626ExceededMaxRedeem: 'More shares than the vault lets you redeem now.',
};

const ITEMS = new Map<string, ErrorItem>();
for (const e of novationErrorsAbi) if (e.type === 'error') ITEMS.set(e.name, e as ErrorItem);

export function refusalMessage(code: string): string {
  return MESSAGES[code as RefusalCode] ?? `Reverted with ${code}.`;
}

/** Revert data (selector + arguments) into a Refusal. Undefined if no known error matches. */
export function decodeRevertData(data: Hex): Refusal | undefined {
  if (!isHex(data) || data.length < 10) return undefined;
  let decoded: { errorName: string; args?: readonly unknown[]; abiItem: { inputs: ErrorInputs } };
  try {
    decoded = decodeErrorResult({ abi: novationErrorsAbi, data }) as typeof decoded;
  } catch {
    return undefined;
  }
  const { errorName, abiItem } = decoded;
  const values = decoded.args ?? [];
  const args: Refusal['args'] = {};
  const numbers: Refusal['numbers'] = {};
  const raw = RAW_ERRORS.test(errorName);
  abiItem.inputs.forEach((input, i) => {
    const name = input.name || `arg${i}`;
    const v = values[i];
    if (typeof v === 'bigint') {
      args[name] = v;
      numbers[name] = raw || INTEGER_ARGS.has(name) ? Number(v) : Number(v) / 1e18;
    } else if (typeof v === 'number') {
      args[name] = BigInt(v);
      numbers[name] = v;
    } else if (typeof v === 'string' || typeof v === 'boolean') {
      args[name] = v;
    }
  });
  if (errorName === 'Error' && typeof values[0] === 'string') {
    return { code: 'Error', message: values[0], selector: data.slice(0, 10) as Hex, args, numbers };
  }
  return { code: errorName, message: refusalMessage(errorName), selector: data.slice(0, 10) as Hex, args, numbers };
}

/** Finds revert data anywhere in a viem error's cause chain (or takes it directly as hex). */
export function revertDataOf(err: unknown): Hex | undefined {
  if (typeof err === 'string') return isHex(err) ? err : undefined;
  const seen = new Set<unknown>();
  let e: unknown = err;
  while (e && typeof e === 'object' && !seen.has(e)) {
    seen.add(e);
    const o = e as { raw?: unknown; data?: unknown; cause?: unknown };
    if (typeof o.raw === 'string' && isHex(o.raw) && o.raw.length >= 10) return o.raw;
    if (typeof o.data === 'string' && isHex(o.data) && o.data.length >= 10) return o.data;
    if (o.data && typeof o.data === 'object') {
      const inner = (o.data as { data?: unknown }).data;
      if (typeof inner === 'string' && isHex(inner) && inner.length >= 10) return inner;
    }
    e = o.cause;
  }
  return undefined;
}

/** A viem error (or revert data) into a Refusal; undefined when it isn't a contract revert we know. */
export function decodeRefusal(err: unknown): Refusal | undefined {
  const data = revertDataOf(err);
  if (data) return decodeRevertData(data);
  // viem already decoded it against the call's ABI but dropped the raw bytes
  if (err instanceof BaseError) {
    const r = err.walk((x) => (x as { data?: { errorName?: string } }).data?.errorName !== undefined) as
      | { data?: { errorName: string; args?: readonly unknown[] }; signature?: Hex }
      | null;
    if (r?.data) {
      const item = ITEMS.get(r.data.errorName);
      const args: Refusal['args'] = {};
      const numbers: Refusal['numbers'] = {};
      ((item?.inputs ?? []) as ErrorInputs).forEach((input, i) => {
        const v = r.data!.args?.[i];
        if (typeof v === 'bigint') {
          args[input.name] = v;
          numbers[input.name] = RAW_ERRORS.test(r.data!.errorName) || INTEGER_ARGS.has(input.name) ? Number(v) : Number(v) / 1e18;
        } else if (typeof v === 'string' || typeof v === 'boolean') args[input.name] = v;
      });
      return { code: r.data.errorName, message: refusalMessage(r.data.errorName), selector: r.signature ?? '0x', args, numbers };
    }
  }
  return undefined;
}

/** Thrown by the write helpers when the simulation reverts with a known error. */
export class RefusalError extends Error {
  readonly refusal: Refusal;
  constructor(refusal: Refusal, options?: { cause?: unknown }) {
    super(`${refusal.code}: ${refusal.message}`, options);
    this.name = 'RefusalError';
    this.refusal = refusal;
  }
}

/** Rethrows `err` as a RefusalError when it carries a known revert; otherwise rethrows it as is. */
export function throwAsRefusal(err: unknown): never {
  const r = decodeRefusal(err);
  if (r) throw new RefusalError(r, { cause: err });
  throw err;
}

export interface ExplainedTx {
  refusal: Refusal;
  /** How the revert data was recovered: an eth_call replay at a block, or the explorer's record. */
  source: { kind: 'replay'; block: bigint } | { kind: 'explorer'; url: string };
  block: bigint;
  from: `0x${string}`;
  to: `0x${string}` | null;
}

/** Blockscout API v2 keeps the raw revert data of every failed transaction. */
async function revertFromExplorer(explorer: string, hash: Hash): Promise<{ data?: Hex; url: string }> {
  const url = `${explorer.replace(/\/$/, '')}/api/v2/transactions/${hash}`;
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) return { url };
  const j = (await r.json()) as { revert_reason?: { raw?: string } | string | null };
  const raw = typeof j.revert_reason === 'object' && j.revert_reason ? j.revert_reason.raw : undefined;
  return { data: raw && isHex(raw) ? raw : undefined, url };
}

/**
 * Why a mined transaction reverted. Robinhood Chain has no debug tracing, so the transaction is
 * replayed with eth_call against the state before its block (then at its block). Public nodes prune
 * old state; then the chain's block explorer (Blockscout) is asked for the recorded revert data.
 * Pass `explorer: false` to stay on the RPC. Undefined when the transaction succeeded or nothing
 * explains it.
 */
export async function explainTx(
  ctx: NovationContext,
  hash: Hash,
  opts: { explorer?: string | false } = {},
): Promise<ExplainedTx | undefined> {
  const [tx, receipt] = await Promise.all([ctx.client.getTransaction({ hash }), ctx.client.getTransactionReceipt({ hash })]);
  if (receipt.status === 'success' || !tx.to) return undefined;
  const base = { block: receipt.blockNumber, from: tx.from, to: tx.to };
  for (const blockNumber of [receipt.blockNumber - 1n, receipt.blockNumber]) {
    try {
      await ctx.client.call({ account: tx.from, to: tx.to, data: tx.input, value: tx.value, blockNumber, gas: tx.gas });
    } catch (err) {
      const refusal = decodeRefusal(err);
      if (refusal) return { refusal, source: { kind: 'replay', block: blockNumber }, ...base };
    }
  }
  const explorer = opts.explorer === false ? undefined : (opts.explorer ?? ctx.client.chain?.blockExplorers?.default.url);
  if (explorer) {
    try {
      const { data, url } = await revertFromExplorer(explorer, hash);
      const refusal = data ? decodeRevertData(data) : undefined;
      if (refusal) return { refusal, source: { kind: 'explorer', url }, ...base };
    } catch {
      /* explorer unreachable: nothing more to try */
    }
  }
  return undefined;
}
