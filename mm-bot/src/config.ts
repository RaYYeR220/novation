/**
 * Building the maker and the relay from environment variables (the standalone server, a Next.js
 * route handler, scripts). Every MM_* variable is optional; a key and an RPC are what it needs.
 */
import { privateKeyToAccount } from 'viem/accounts';
import { createNovation, getSubaccountsOf, toWad, type NovationContext } from '@novation/sdk';
import { createRfqHandler, type RfqHandlerConfig } from './handler';
import { deriveKey, normalizeKey } from './keys';
import { Maker, type MakerInfo, type QuoteRequest, type QuoteResult, type QuoteSource } from './maker';
import { DEFAULT_PRICING, type PricingConfig, type Side } from './pricing';

export type Env = Record<string, string | undefined>;

const wad = (env: Env, name: string): bigint | undefined => {
  const v = env[name]?.trim();
  return v ? toWad(v) : undefined;
};
const int = (env: Env, name: string): number | undefined => {
  const v = env[name]?.trim();
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number`);
  return n;
};

/** The maker's private key: MM_MAKER_PRIVATE_KEY, else derived from DEPLOYER_PRIVATE_KEY ("maker"). */
export function makerKeyFromEnv(env: Env): `0x${string}` {
  if (env.MM_MAKER_PRIVATE_KEY) return normalizeKey(env.MM_MAKER_PRIVATE_KEY);
  if (env.DEPLOYER_PRIVATE_KEY) return deriveKey(env.DEPLOYER_PRIVATE_KEY, 'maker');
  throw new Error('set MM_MAKER_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY to derive it)');
}

/** Pricing overrides from MM_* variables, on top of DEFAULT_PRICING. */
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
  p.minTimeToExpiry = int(env, 'MM_MIN_TIME_TO_EXPIRY') ?? p.minTimeToExpiry;
  const age = int(env, 'MM_MAX_PRICE_AGE');
  if (age !== undefined) p.maxPriceAge = age;
  if (p.ttl <= 0) throw new Error('MM_TTL must be positive');
  return p;
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
  const chainId = int(env, 'MM_CHAIN_ID') ?? 46630;
  const rpcUrl = env.MM_RPC_URL || (chainId === 46630 ? env.RH_TESTNET_RPC : env.RH_MAINNET_RPC) || undefined;
  const n = createNovation({ chainId, rpcUrl });
  const signer = privateKeyToAccount(makerKeyFromEnv(env));
  let makerId: bigint;
  if (env.MM_MAKER_ID) makerId = BigInt(env.MM_MAKER_ID);
  else {
    const ids = await getSubaccountsOf(n.ctx, signer.address);
    if (ids.length === 0) throw new Error(`${signer.address} has no subaccount: run the maker setup first`);
    makerId = ids[0] as bigint;
  }
  const maker = new Maker({ ctx: n.ctx, signer, makerId, pricing: pricingFromEnv(env), maxOutstanding: int(env, 'MM_MAX_OUTSTANDING') });
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
    quote: async (req: QuoteRequest): Promise<QuoteResult> => (await get()).quote(req),
    quoteSides: async (seriesId: number, sides: readonly Side[], qty?: bigint) => (await get()).quoteSides(seriesId, sides, qty),
    info: async (): Promise<MakerInfo> => (await get()).info(),
  };
}

/**
 * The relay handler from the environment, for mounting in a framework:
 *
 *   // app/src/app/api/rfq/[...path]/route.ts
 *   const handler = createRfqHandlerFromEnv(process.env, { basePath: '/api/rfq' });
 *   export { handler as GET, handler as POST, handler as OPTIONS };
 *
 * MM_CORS sets Access-Control-Allow-Origin. Nothing touches the chain until the first request.
 */
export function createRfqHandlerFromEnv(env: Env = process.env, opts: Omit<RfqHandlerConfig, 'maker'> = {}) {
  return createRfqHandler({
    cors: env.MM_CORS || undefined,
    ...opts,
    maker: lazySource(async () => (await makerFromEnv(env)).maker),
  });
}
