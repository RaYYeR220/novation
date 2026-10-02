import { readFileSync } from 'node:fs';
import { DEPLOYED_CHAIN_IDS, getDeployment, parseDeployment, type Deployment } from '@novation/sdk';
import { isHex, type Hex } from 'viem';

/** Gas limit for a ticket sent although the simulation refused it, so the revert is mined. */
export const DEFAULT_REFUSAL_GAS = 5_000_000n;
export const DEFAULT_CHAIN_ID = 46630;

export interface Config {
  chainId: number;
  /** Undefined: the chain's public RPC. */
  rpcUrl?: string;
  deployment: Deployment;
  /** The agent's private key. Undefined: read-only mode, no trading tools. */
  agentKey?: Hex;
  /** The subaccount the agent trades for. Undefined: found from the chain's AgentGranted log. */
  account?: bigint;
  refusalGas: bigint;
  /** NOVATION_ALLOW_FORCED_SEND=1: the trading tools offer send_even_if_refused. */
  allowForcedSend: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Reads the server's settings from the environment:
 *   NOVATION_AGENT_KEY    the agent's private key (0x + 64 hex). Absent: read-only mode.
 *   NOVATION_ACCOUNT      the subaccount id the agent trades for (found on-chain when absent).
 *   NOVATION_RPC_URL      JSON-RPC endpoint (default: the chain's public RPC).
 *   NOVATION_CHAIN_ID     default 46630, Robinhood Chain testnet.
 *   NOVATION_DEPLOYMENT   path to a contracts/deployments/<chainId>.json (default: the recorded one).
 *   NOVATION_REFUSAL_GAS  gas limit for send_even_if_refused (default 5,000,000).
 *   NOVATION_ALLOW_FORCED_SEND  1 to offer send_even_if_refused (mines refused tickets as proof).
 * There is deliberately no setting for an owner key.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const v = (k: string) => {
    const x = env[k]?.trim();
    return x ? x : undefined;
  };

  let deployment: Deployment;
  const path = v('NOVATION_DEPLOYMENT');
  if (path) {
    try {
      deployment = parseDeployment(JSON.parse(readFileSync(path, 'utf8')));
    } catch (e) {
      throw new ConfigError(`NOVATION_DEPLOYMENT: cannot read ${path}: ${(e as Error).message}`);
    }
  } else {
    const chainId = Number(v('NOVATION_CHAIN_ID') ?? DEFAULT_CHAIN_ID);
    if (!DEPLOYED_CHAIN_IDS.includes(chainId)) {
      throw new ConfigError(`no Novation deployment recorded for chain ${chainId}; set NOVATION_DEPLOYMENT to a deployments JSON`);
    }
    deployment = getDeployment(chainId);
  }
  const chainId = Number(v('NOVATION_CHAIN_ID') ?? deployment.chainId);
  if (chainId !== deployment.chainId) throw new ConfigError(`NOVATION_CHAIN_ID ${chainId} does not match the deployment's chain ${deployment.chainId}`);

  const key = v('NOVATION_AGENT_KEY');
  let agentKey: Hex | undefined;
  if (key) {
    const k = (key.startsWith('0x') ? key : `0x${key}`) as Hex;
    if (!isHex(k) || k.length !== 66) throw new ConfigError('NOVATION_AGENT_KEY must be a 32-byte hex private key');
    agentKey = k;
  }

  const acct = v('NOVATION_ACCOUNT');
  if (acct !== undefined && !/^\d+$/.test(acct)) throw new ConfigError('NOVATION_ACCOUNT must be a subaccount id (a positive integer)');
  const forced = v('NOVATION_ALLOW_FORCED_SEND');
  if (forced !== undefined && !/^(0|1|true|false)$/i.test(forced)) throw new ConfigError('NOVATION_ALLOW_FORCED_SEND must be 1 or 0');
  const gas = v('NOVATION_REFUSAL_GAS');
  if (gas !== undefined && !/^\d+$/.test(gas)) throw new ConfigError('NOVATION_REFUSAL_GAS must be an integer');

  return {
    chainId,
    rpcUrl: v('NOVATION_RPC_URL'),
    deployment,
    agentKey,
    account: acct !== undefined ? BigInt(acct) : undefined,
    refusalGas: gas !== undefined ? BigInt(gas) : DEFAULT_REFUSAL_GAS,
    allowForcedSend: forced !== undefined && /^(1|true)$/i.test(forced),
  };
}
