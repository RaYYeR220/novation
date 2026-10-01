import { defineChain } from 'viem';

export const robinhoodChain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
});

export const robinhoodChainTestnet = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://explorer.testnet.chain.robinhood.com' } },
  testnet: true,
});

export const CHAINS = [robinhoodChain, robinhoodChainTestnet] as const;
export type AppChainId = (typeof CHAINS)[number]['id'];

/** The chain the app reads and trades on: mainnet unless NEXT_PUBLIC_CHAIN=testnet. */
export const targetChain = process.env.NEXT_PUBLIC_CHAIN === 'testnet' ? robinhoodChainTestnet : robinhoodChain;

export function isAppChain(id: number | undefined): id is AppChainId {
  return CHAINS.some((c) => c.id === id);
}

export function explorerTx(hash: string, chainId: number = targetChain.id): string {
  const chain = CHAINS.find((c) => c.id === chainId) ?? targetChain;
  return `${chain.blockExplorers.default.url}/tx/${hash}`;
}
