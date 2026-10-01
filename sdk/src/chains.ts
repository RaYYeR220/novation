import { createPublicClient, defineChain, http, type Chain, type PublicClient } from 'viem';

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;

export const robinhoodChainTestnet = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://explorer.testnet.chain.robinhood.com' } },
  contracts: { multicall3: { address: MULTICALL3 } },
  testnet: true,
});

export const robinhoodChain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
  contracts: { multicall3: { address: MULTICALL3 } },
});

export const NOVATION_CHAINS = [robinhoodChainTestnet, robinhoodChain] as const;

export function chainById(id: number): Chain | undefined {
  return NOVATION_CHAINS.find((c) => c.id === id);
}

/**
 * A public client for a Novation chain: JSON-RPC batching on, and the chain's Multicall3 used to
 * aggregate concurrent reads when the chain has one.
 */
export function createNovationClient(opts: { chain: Chain; rpcUrl?: string; multicall?: boolean }): PublicClient {
  const multicall = opts.multicall ?? Boolean(opts.chain.contracts?.multicall3);
  return createPublicClient({
    chain: opts.chain,
    transport: http(opts.rpcUrl, { batch: { batchSize: 100, wait: 10 }, retryCount: 2 }),
    batch: multicall ? { multicall: { batchSize: 4096, wait: 10 } } : undefined,
  }) as PublicClient;
}
