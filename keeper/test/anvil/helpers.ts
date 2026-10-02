import { inject } from 'vitest';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  maxUint256,
  parseEther,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import {
  baseSession,
  getSpot,
  mockAggregatorAbi,
  parseDeployment,
  simulateApprove,
  simulateCreateSubaccount,
  simulateDeposit,
  simulateMint,
  type Deployment,
  type NovationContext,
} from '@novation/sdk';

declare module 'vitest' {
  export interface ProvidedContext {
    anvil: { rpcUrl: string; deployment: unknown } | null;
  }
}

/** anvil's account 9 (public test mnemonic): stands in for the deployer the keeper key derives from. */
export const DEPLOYER_KEY: Hex = '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6';

export interface Local {
  rpcUrl: string;
  chain: ReturnType<typeof defineChain>;
  client: PublicClient;
  deployment: Deployment;
  ctx: NovationContext;
  rpc: (method: string, params?: unknown[]) => Promise<unknown>;
}

export function local(): Local | null {
  const a = inject('anvil');
  if (!a) return null;
  const chain = defineChain({
    id: 31337,
    name: 'anvil',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [a.rpcUrl] } },
  });
  const client = createPublicClient({ chain, transport: http(a.rpcUrl), pollingInterval: 50 }) as PublicClient;
  const deployment = parseDeployment(a.deployment);
  return {
    rpcUrl: a.rpcUrl,
    chain,
    client,
    deployment,
    ctx: { client, deployment },
    rpc: async (method, params = []) => {
      const r = await fetch(a.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = (await r.json()) as { result?: unknown; error?: { message: string } };
      if (j.error) throw new Error(j.error.message);
      return j.result;
    },
  };
}

export async function now(l: Local): Promise<number> {
  return Number((await l.client.getBlock()).timestamp);
}

/** Mines one block at exactly `ts`. */
export async function warpTo(l: Local, ts: number): Promise<void> {
  await l.rpc('evm_setNextBlockTimestamp', [ts]);
  await l.rpc('evm_mine');
}

/** The first moment at or after `ts` (stepping by the hour) when auctions may run. */
export function nextTradable(ts: number): number {
  let t = ts;
  for (let i = 0; i < 24 * 8; i++, t += 3600) {
    const s = baseSession(t);
    if (s === 'REGULAR' || s === 'EXTENDED') return t;
  }
  throw new Error('no tradable session within 8 days');
}

/** A moment inside the next weekend after `ts`: the first WEEKEND hour, plus twelve. */
export function nextWeekend(ts: number): number {
  let t = ts;
  for (let i = 0; i < 24 * 8; i++, t += 3600) if (baseSession(t) === 'WEEKEND') return t + 12 * 3600;
  throw new Error('no weekend within 8 days');
}

export interface Actor {
  account: PrivateKeyAccount;
  wallet: WalletClient;
}

/** A fresh key with 10 ETH. */
export async function actor(l: Local): Promise<Actor> {
  const account = privateKeyToAccount(generatePrivateKey());
  await l.rpc('anvil_setBalance', [account.address, `0x${parseEther('10').toString(16)}`]);
  return { account, wallet: createWalletClient({ account, chain: l.chain, transport: http(l.rpcUrl) }) };
}

export async function send(l: Local, who: Actor, sim: Promise<{ request: unknown }>): Promise<Hex> {
  const { request } = await sim;
  // sign locally: a simulation run from the bare address would go out as eth_sendTransaction
  const req = { ...(request as object), account: who.account } as Parameters<WalletClient['writeContract']>[0];
  const hash = await who.wallet.writeContract(req);
  const rc = await l.client.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error(`reverted: ${hash}`);
  return hash;
}

/** A subaccount for `who` with `usdg` whole USDG of cash (mock USDG, 6 decimals). */
export async function fundedAccount(l: Local, who: Actor, usdg: bigint): Promise<bigint> {
  const me = who.account.address;
  const USDG = l.deployment.tokens.USDG as Address;
  const raw = usdg * 10n ** 6n;
  await send(l, who, simulateMint(l.ctx, me, USDG, me, raw));
  await send(l, who, simulateApprove(l.ctx, me, USDG, l.deployment.clearinghouse, maxUint256));
  const c = await simulateCreateSubaccount(l.ctx, me);
  await send(l, who, Promise.resolve(c));
  await send(l, who, simulateDeposit(l.ctx, me, c.result, USDG, raw));
  return c.result;
}

/** Pushes a round on a mock feed: `price` in whole dollars (8 decimals) or raw, at `updatedAt`. */
export async function pushRound(l: Local, who: Actor, symbol: string, answer: bigint, updatedAt: number): Promise<void> {
  const feed = l.deployment.feeds[symbol] as Address;
  await send(
    l,
    who,
    l.client.simulateContract({ address: feed, abi: mockAggregatorAbi, functionName: 'pushRound', args: [answer, BigInt(updatedAt)], account: who.account }),
  );
}

/** Re-prints every feed at its current answer (or `overrides`, 8 decimals) at `updatedAt`, so nothing reads stale after a warp. */
export async function refreshFeeds(l: Local, who: Actor, updatedAt: number, overrides: Record<string, bigint> = {}): Promise<void> {
  for (const sym of Object.keys(l.deployment.feeds)) {
    const feed = l.deployment.feeds[sym] as Address;
    const r = await l.client.readContract({ address: feed, abi: mockAggregatorAbi, functionName: 'latestRoundData' });
    await pushRound(l, who, sym, overrides[sym] ?? r[1], updatedAt);
  }
}

export async function spotOf(l: Local, symbol: string): Promise<bigint> {
  return (await getSpot(l.ctx, l.deployment.tokens[symbol] as Address)).price;
}
