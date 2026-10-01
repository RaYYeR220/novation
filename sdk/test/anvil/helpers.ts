import { inject } from 'vitest';
import { createPublicClient, createWalletClient, defineChain, http, type Address, type PublicClient, type WalletClient } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { parseDeployment, type NovationContext } from '../../src/index';

/** anvil's default accounts 1-3 (public test mnemonic): a taker, a maker and an agent. */
const KEYS = [
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
] as const;

export const anvilChain = defineChain({
  id: 31337,
  name: 'anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
});

export interface Local {
  ctx: NovationContext;
  client: PublicClient;
  wallets: { account: PrivateKeyAccount; wallet: WalletClient }[];
  rpc: (method: string, params?: unknown[]) => Promise<unknown>;
}

export function local(): Local | null {
  const a = inject('anvil');
  if (!a) return null;
  const transport = http(a.rpcUrl);
  const client = createPublicClient({ chain: anvilChain, transport }) as PublicClient;
  const deployment = parseDeployment(a.deployment);
  return {
    ctx: { client, deployment },
    client,
    wallets: KEYS.map((k) => {
      const account = privateKeyToAccount(k);
      return { account, wallet: createWalletClient({ account, chain: anvilChain, transport }) };
    }),
    rpc: async (method, params = []) => {
      const r = await fetch(a.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const j = (await r.json()) as { result?: unknown; error?: { message: string } };
      if (j.error) throw new Error(j.error.message);
      return j.result;
    },
  };
}

/** Sends a simulated request and waits; throws if it reverts. */
export async function send(l: Local, wallet: WalletClient, request: unknown): Promise<`0x${string}`> {
  const hash = await wallet.writeContract(request as Parameters<WalletClient['writeContract']>[0]);
  const rc = await l.client.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error(`reverted: ${hash}`);
  return hash;
}

export type { Address };
