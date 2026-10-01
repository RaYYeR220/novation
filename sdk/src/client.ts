import type { Chain, PublicClient } from 'viem';
import { getDeployment } from './addresses';
import { chainById, createNovationClient } from './chains';
import * as clearinghouse from './clearinghouse';
import * as events from './events';
import * as hub from './hub';
import * as kernel from './kernel';
import * as refusal from './refusal';
import * as registry from './registry';
import * as rfq from './rfq';
import * as vault from './vault';
import * as writes from './writes';
import type { Deployment, NovationContext } from './types';

type AnyFn = (ctx: NovationContext, ...args: never[]) => unknown;
/** A module's context-first functions with the context bound. */
export type Bound<T> = {
  [K in keyof T as T[K] extends AnyFn ? K : never]: T[K] extends (ctx: NovationContext, ...args: infer A) => infer R ? (...args: A) => R : never;
};

function bind<T extends object>(mod: T, ctx: NovationContext): Bound<T> {
  const out: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(mod)) {
    if (typeof f === 'function' && f.length >= 1) out[k] = (...a: unknown[]) => (f as (...x: unknown[]) => unknown)(ctx, ...a);
  }
  return out as Bound<T>;
}

/** Every SDK helper with one context bound: `n.clearinghouse.getAccountState(7n)`. */
export interface Novation {
  ctx: NovationContext;
  deployment: Deployment;
  client: PublicClient;
  hub: Bound<typeof hub>;
  registry: Bound<typeof registry>;
  clearinghouse: Bound<typeof clearinghouse>;
  vault: Bound<typeof vault>;
  rfq: Bound<typeof rfq>;
  kernel: Bound<typeof kernel>;
  events: Bound<typeof events>;
  writes: Bound<typeof writes>;
  explainTx: Bound<typeof refusal>['explainTx'];
}

/**
 * Binds the SDK to a client and a deployment. Pass a viem public client, or a chain id (and an
 * optional RPC URL) for one built with batching on. The deployment defaults to the one recorded in
 * contracts/deployments for the chain.
 */
export function createNovation(opts: { client?: PublicClient; chainId?: number; chain?: Chain; rpcUrl?: string; deployment?: Deployment }): Novation {
  const chainId = opts.chainId ?? opts.chain?.id ?? opts.client?.chain?.id ?? opts.deployment?.chainId;
  if (chainId === undefined) throw new Error('createNovation: pass a client with a chain, a chainId or a deployment');
  const deployment = opts.deployment ?? getDeployment(chainId);
  let client = opts.client;
  if (!client) {
    const chain = opts.chain ?? chainById(chainId);
    if (!chain) throw new Error(`createNovation: no chain definition for ${chainId}; pass a client`);
    client = createNovationClient({ chain, rpcUrl: opts.rpcUrl });
  }
  const ctx: NovationContext = { client, deployment };
  return {
    ctx,
    deployment,
    client,
    hub: bind(hub, ctx),
    registry: bind(registry, ctx),
    clearinghouse: bind(clearinghouse, ctx),
    vault: bind(vault, ctx),
    rfq: bind(rfq, ctx),
    kernel: bind(kernel, ctx),
    events: bind(events, ctx),
    writes: bind(writes, ctx),
    explainTx: (hash) => refusal.explainTx(ctx, hash),
  };
}
