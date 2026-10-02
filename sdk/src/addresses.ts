import { getAddress, type Address } from 'viem';
import { deploymentsJson, proofTxsJson } from './data/deployments';
import type { Deployment, VaultKind } from './types';

type Json = Record<string, unknown>;

function addr(v: unknown, what: string): Address {
  if (typeof v !== 'string') throw new Error(`deployment: ${what} missing`);
  return getAddress(v);
}

function addrMap(v: unknown, what: string): Record<string, Address> {
  const out: Record<string, Address> = {};
  for (const [k, a] of Object.entries((v ?? {}) as Record<string, unknown>)) out[k] = addr(a, `${what}.${k}`);
  return out;
}

/**
 * Parses a contracts/deployments/<chainId>.json document (the forge scripts' output) into a typed
 * deployment. Used for the recorded table and for local deployments (anvil) read at runtime.
 */
export function parseDeployment(json: unknown): Deployment {
  const d = json as Json;
  const kernel = d.kernel as Json | string | undefined;
  return {
    chainId: Number(d.chainId),
    block: BigInt((d.block as number | undefined) ?? 0),
    kernel: addr(typeof kernel === 'string' ? kernel : kernel?.address, 'kernel'),
    ...(d.kernelReference ? { kernelReference: addr(d.kernelReference, 'kernelReference') } : {}),
    tokens: addrMap(d.tokens, 'tokens'),
    feeds: addrMap(d.feeds, 'feeds'),
    timelock: addr(d.timelock, 'timelock'),
    guardian: addr(d.guardian, 'guardian'),
    riskParams: addr(d.riskParams, 'riskParams'),
    hub: addr(d.hub, 'hub'),
    registry: addr(d.registry, 'registry'),
    insurance: addr(d.insurance, 'insurance'),
    clearinghouse: addr(d.clearinghouse, 'clearinghouse'),
    auctionHouse: addr(d.auctionHouse, 'auctionHouse'),
    rfq: addr(d.rfq, 'rfq'),
    vaults: ((d.vaults ?? []) as Json[]).map((v, i) => ({
      address: addr(v.address, `vaults[${i}].address`),
      type: v.type as VaultKind,
      underlying: String(v.underlying),
    })),
    ...(d.libraries ? { libraries: addrMap(d.libraries, 'libraries') } : {}),
  };
}

const TABLE = deploymentsJson as unknown as Record<string, unknown>;

/** Chains with a recorded Novation deployment. */
export const DEPLOYED_CHAIN_IDS: readonly number[] = Object.keys(TABLE).map(Number);

/** The deployment recorded for `chainId` in contracts/deployments. Throws for an unknown chain. */
export function getDeployment(chainId: number): Deployment {
  const j = TABLE[String(chainId)];
  if (!j) throw new Error(`no Novation deployment recorded for chain ${chainId}`);
  return parseDeployment(j);
}

export interface ProofRefusal {
  label: string;
  tx: `0x${string}`;
  block: number;
  expectedError: string | null;
}

/** The refused transactions tools/e2e/scenario.py sent on `chainId` (empty if none recorded). */
export function proofRefusals(chainId: number): ProofRefusal[] {
  const p = (proofTxsJson as unknown as Record<string, { refusals: ProofRefusal[] }>)[String(chainId)];
  return p ? p.refusals.map((r) => ({ ...r })) : [];
}

/** Symbol of a token in the deployment, or undefined. */
export function symbolOf(d: Deployment, token: Address): string | undefined {
  const t = token.toLowerCase();
  return Object.entries(d.tokens).find(([, a]) => a.toLowerCase() === t)?.[0];
}

/** Token address of a symbol. Throws if the deployment has no such token. */
export function tokenOf(d: Deployment, symbol: string): Address {
  const a = d.tokens[symbol];
  if (!a) throw new Error(`no ${symbol} token in the deployment`);
  return a;
}
