/**
 * Building the maker and the relay from environment variables (the standalone server, a Next.js
 * route handler, scripts). Every MM_* variable is optional except the key on a production chain.
 * Settings are validated when the handler is built, so a bad value fails at startup.
 */
import { privateKeyToAccount } from 'viem/accounts';
import { createNovation, getSubaccountsOf, toWad, type NovationContext } from '@novation/sdk';
import { createRfqHandler, DEFAULT_RATE_LIMIT, type RateLimit, type RfqHandlerConfig } from './handler';
import { deriveKey, normalizeKey } from './keys';
import { Maker, type MakerInfo, type QuoteOptions, type QuoteRequest, type QuoteResult, type QuoteSource } from './maker';
import { DEFAULT_PRICING, validatePricing, type PricingConfig, type Side } from './pricing';

export type Env = Record<string, string | undefined>;

/** Robinhood Chain testnet: the only chain where the maker key may be derived from the deployer's. */
export const DEMO_CHAIN_ID = 46630;

const wad = (env: Env, name: string): bigint | undefined => {
  const v = env[name]?.trim();
  if (!v) return undefined;
  if (!/^-?\d+(\.\d+)?$/.test(v)) throw new Error(`${name} must be a decimal number, got "${v}"`);
  return toWad(v);
};
const int = (env: Env, name: string): number | undefined => {
  const v = env[name]?.trim();
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number`);
  return n;
};

export function chainIdFromEnv(env: Env): number {
  return int(env, 'MM_CHAIN_ID') ?? DEMO_CHAIN_ID;
}

/**
 * The maker's private key: MM_MAKER_PRIVATE_KEY. On Robinhood Chain testnet only, and as a demo
 * convenience, it falls back to keccak256(DEPLOYER_PRIVATE_KEY || "maker"). Every other chain
 * needs an explicit key.
 */
export function makerKeyFromEnv(env: Env, chainId: number = chainIdFromEnv(env)): `0x${string}` {
  if (env.MM_MAKER_PRIVATE_KEY) return normalizeKey(env.MM_MAKER_PRIVATE_KEY);
  if (chainId !== DEMO_CHAIN_ID) throw new Error(`set MM_MAKER_PRIVATE_KEY: chain ${chainId} needs its own maker key`);
  if (env.DEPLOYER_PRIVATE_KEY) return deriveKey(env.DEPLOYER_PRIVATE_KEY, 'maker');
  throw new Error('set MM_MAKER_PRIVATE_KEY (or, on testnet, DEPLOYER_PRIVATE_KEY to derive it)');
}

/** Pricing overrides from MM_* variables on top of DEFAULT_PRICING, validated. */
export function pricingFromEnv(env: Env): PricingConfig {
  const p: PricingConfig = { ...DEFAULT_PRICING, sessionVolAdd: { ...DEFAULT_PRICING.sessionVolAdd } };
  p.volSpread = wad(env, 'MM_VOL_SPREAD') ?? p.volSpread;
  p.priceSpread = wad(env, 'MM_PRICE_SPREAD') ?? p.priceSpread;
  p.skewSlope = wad(env, 'MM_SKEW_SLOPE') ?? p.skewSlope;
  p.inventorySlope = wad(env, 'MM_INVENTORY_SLOPE') ?? p.inventorySlope;
  p.maxQtyPerQuote = wad(env, 'MM_MAX_QTY') ?? p.maxQtyPerQuote;
  p.maxInventoryPerSeries = wad(env, 'MM_MAX_INVENTORY') ?? p.maxInventoryPerSeries;
  p.defaultQty = wad(env, 'MM_DEFAULT_QTY') ?? p.defaultQty;
  p.marginBuffer = wad(env, 'MM_MARGIN_BUFFER') ?? p.marginBuffer;
  p.ttl = int(env, 'MM_TTL') ?? p.ttl;
  p.indicativeTtl = int(env, 'MM_INDICATIVE_TTL') ?? Math.min(p.indicativeTtl, p.ttl);
  p.minTimeToExpiry = int(env, 'MM_MIN_TIME_TO_EXPIRY') ?? p.minTimeToExpiry;
  const age = int(env, 'MM_MAX_PRICE_AGE');
  if (age !== undefined) p.maxPriceAge = age;
  return validatePricing(p);
}

/** MM_RATE_BURST and MM_RATE_PER_MIN (default 10 and 30); MM_RATE_PER_MIN=0 turns the limit off. */
export function rateLimitFromEnv(env: Env): RateLimit | false {
  const perMinute = int(env, 'MM_RATE_PER_MIN') ?? DEFAULT_RATE_LIMIT.perMinute;
  if (perMinute === 0) return false;
  const burst = int(env, 'MM_RATE_BURST') ?? DEFAULT_RATE_LIMIT.burst;
  if (burst < 1) throw new Error('MM_RATE_BURST must be at least 1');
  return { burst, perMinute };
}

/** The Maker's limits from MM_MAX_OUTSTANDING, MM_MAX_PER_CLIENT and MM_MAX_QUEUE. */
function limitsFromEnv(env: Env) {
  return { maxOutstanding: int(env, 'MM_MAX_OUTSTANDING'), maxOutstandingPerClient: int(env, 'MM_MAX_PER_CLIENT'), maxQueue: int(env, 'MM_MAX_QUEUE') };
}

export interface MakerFromEnv {
  maker: Maker;
  ctx: NovationContext;
}

/**
 * The Maker the environment describes. Chain: MM_CHAIN_ID (default 46630, Robinhood Chain
 * testnet); RPC: MM_RPC_URL, else RH_TESTNET_RPC / RH_MAINNET_RPC. Account: MM_MAKER_ID, else the
 * maker's first subaccount. Checks that the key can act for the account.
 */
export async function makerFromEnv(env: Env = process.env): Promise<MakerFromEnv> {
  const chainId = chainIdFromEnv(env);
  const signer = privateKeyToAccount(makerKeyFromEnv(env, chainId));
  const pricing = pricingFromEnv(env);
  const rpcUrl = env.MM_RPC_URL || (chainId === DEMO_CHAIN_ID ? env.RH_TESTNET_RPC : env.RH_MAINNET_RPC) || undefined;
  const n = createNovation({ chainId, rpcUrl });
  let makerId: bigint;
  if (env.MM_MAKER_ID) makerId = BigInt(env.MM_MAKER_ID);
  else {
    const ids = await getSubaccountsOf(n.ctx, signer.address);
    if (ids.length === 0) throw new Error(`${signer.address} has no subaccount: run the maker setup first`);
    makerId = ids[0] as bigint;
  }
  const maker = new Maker({ ctx: n.ctx, signer, makerId, pricing, ...limitsFromEnv(env) });
  await maker.assertAuthorized();
  return { maker, ctx: n.ctx };
}

/** A QuoteSource that builds its maker on first use (and tries again if the build failed). */
export function lazySource(init: () => Promise<QuoteSource>): QuoteSource {
  let p: Promise<QuoteSource> | undefined;
  const get = () => {
    p ??= init().catch((e: unknown) => {
      p = undefined;
      throw e;
    });
    return p;
  };
  return {
    quote: async (req: QuoteRequest, opts?: QuoteOptions): Promise<QuoteResult> => (await get()).quote(req, opts),
    quoteSides: async (seriesId: number, sides: readonly Side[], qty?: bigint, opts?: QuoteOptions) => (await get()).quoteSides(seriesId, sides, qty, opts),
    info: async (): Promise<MakerInfo> => (await get()).info(),
  };
}

/**
 * The relay handler from the environment, for mounting in a framework:
 *
 *   // app/src/app/api/rfq/[[...path]]/route.ts
 *   const handler = createRfqHandlerFromEnv(process.env, { basePath: '/api/rfq' });
 *   export { handler as GET, handler as POST, handler as OPTIONS };
 *
 * The key, pricing and limits are checked here, so a bad setting throws when the route loads;
 * the chain is first read on the first request. MM_CORS sets Access-Control-Allow-Origin.
 */
export function createRfqHandlerFromEnv(env: Env = process.env, opts: Omit<RfqHandlerConfig, 'maker'> = {}) {
  makerKeyFromEnv(env);
  pricingFromEnv(env);
  const rateLimit = rateLimitFromEnv(env);
  return createRfqHandler({
    cors: env.MM_CORS || undefined,
    rateLimit,
    ...opts,
    maker: lazySource(async () => (await makerFromEnv(env)).maker),
  });
}
