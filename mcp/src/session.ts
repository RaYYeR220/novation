import {
  chainById,
  clearinghouseAbi,
  createNovation,
  createNovationClient,
  getEvents,
  type AgentPolicy,
  type Deployment,
  type Novation,
  type SeriesInfo,
} from '@novation/sdk';
import { createWalletClient, defineChain, http, type Address, type Chain, type Hex, type PublicClient, type WalletClient } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { DEFAULT_REFUSAL_GAS, type Config } from './config';

/** What every tool runs against: the SDK bound to one deployment, and the agent if there is one. */
export interface Session {
  n: Novation;
  chain: Chain;
  /** The agent key's account and a wallet that signs with it. Absent in read-only mode. */
  agent?: { account: PrivateKeyAccount; wallet: WalletClient };
  /** The subaccount the agent trades for; the default account of the read tools. */
  accountId?: bigint;
  refusalGas: bigint;
  seriesCache: Map<number, SeriesInfo>;
  /** Serializes the agent's transactions so concurrent tool calls never race for a nonce. */
  lock: <T>(f: () => Promise<T>) => Promise<T>;
}

export interface SessionOptions {
  deployment: Deployment;
  rpcUrl?: string;
  agentKey?: Hex;
  account?: bigint;
  refusalGas?: bigint;
}

function chainFor(chainId: number, rpcUrl?: string): Chain {
  const known = chainById(chainId);
  if (known) return known;
  if (!rpcUrl) throw new Error(`chain ${chainId} has no public RPC on record: set NOVATION_RPC_URL`);
  return defineChain({
    id: chainId,
    name: `chain ${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

function mutex() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(f: () => Promise<T>): Promise<T> => {
    const run = tail.then(f, f);
    tail = run.catch(() => undefined);
    return run;
  };
}

export function createSession(o: SessionOptions): Session {
  const chain = chainFor(o.deployment.chainId, o.rpcUrl);
  const client = createNovationClient({ chain, rpcUrl: o.rpcUrl }) as PublicClient;
  const n = createNovation({ client, deployment: o.deployment });
  let agent: Session['agent'];
  if (o.agentKey) {
    const account = privateKeyToAccount(o.agentKey);
    agent = { account, wallet: createWalletClient({ account, chain, transport: http(o.rpcUrl) }) };
  }
  return {
    n,
    chain,
    agent,
    accountId: o.account,
    refusalGas: o.refusalGas ?? DEFAULT_REFUSAL_GAS,
    seriesCache: new Map(),
    lock: mutex(),
  };
}

export function sessionFromConfig(c: Config): Session {
  return createSession({ deployment: c.deployment, rpcUrl: c.rpcUrl, agentKey: c.agentKey, account: c.account, refusalGas: c.refusalGas });
}

/** Thrown at startup when the key isn't a live agent of the account: the server doesn't start. */
export class StartupRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupRefused';
  }
}

export interface VerifiedAgent {
  agent: Address;
  accountId: bigint;
  owner: Address;
  policy: AgentPolicy;
}

/** The live policies granted to `agent`, newest grant first, from the AgentGranted log. */
async function grantsTo(s: Session, agent: Address): Promise<bigint[]> {
  const logs = await getEvents(s.n.ctx, { address: s.n.deployment.clearinghouse, abi: clearinghouseAbi, eventName: 'AgentGranted', args: { agent } });
  const ids = [...new Set(logs.map((l) => l.args.id).filter((x): x is bigint => x !== undefined).reverse())];
  const now = Number((await s.n.client.getBlock()).timestamp);
  const live = await Promise.all(ids.map(async (id) => ((await s.n.clearinghouse.getAgentPolicy(id, agent)).expiresAt > now ? id : undefined)));
  return live.filter((x): x is bigint => x !== undefined);
}

/**
 * The startup check. With an agent key, the server runs only if the chain holds a live AgentPolicy
 * for (account, agent), and only if the key is not the account owner's: owner keys can withdraw
 * and re-grant, so the server refuses to hold one. Without NOVATION_ACCOUNT the account is the one
 * live grant to this agent in the AgentGranted log. Sets `s.accountId`.
 */
export async function verifyAgent(s: Session): Promise<VerifiedAgent> {
  if (!s.agent) throw new StartupRefused('no agent key: the server is read-only');
  const agent = s.agent.account.address;
  let id = s.accountId;
  if (id === undefined) {
    const live = await grantsTo(s, agent);
    if (live.length === 0) throw new StartupRefused(`no live AgentPolicy names ${agent} on chain ${s.chain.id}; the account owner must call grantAgent first`);
    if (live.length > 1) throw new StartupRefused(`${agent} is a live agent of accounts ${live.join(', ')}: set NOVATION_ACCOUNT to pick one`);
    id = live[0] as bigint;
  }
  let owner: Address;
  try {
    owner = await s.n.clearinghouse.getOwnerOf(id);
  } catch {
    throw new StartupRefused(`subaccount ${id} does not exist on chain ${s.chain.id}`);
  }
  if (/^0x0{40}$/i.test(owner)) throw new StartupRefused(`subaccount ${id} does not exist on chain ${s.chain.id}`);
  if (owner.toLowerCase() === agent.toLowerCase()) {
    throw new StartupRefused(
      `NOVATION_AGENT_KEY is the owner key of subaccount ${id}. The server only holds an agent key: grant a separate key with grantAgent and pass that one.`,
    );
  }
  const [policy, block] = await Promise.all([s.n.clearinghouse.getAgentPolicy(id, agent), s.n.client.getBlock()]);
  if (policy.expiresAt === 0) throw new StartupRefused(`no AgentPolicy for agent ${agent} on subaccount ${id}; the owner must call grantAgent first`);
  if (BigInt(policy.expiresAt) <= block.timestamp) {
    throw new StartupRefused(`the AgentPolicy for ${agent} on subaccount ${id} expired at ${new Date(policy.expiresAt * 1000).toISOString()}`);
  }
  s.accountId = id;
  return { agent, accountId: id, owner, policy };
}
