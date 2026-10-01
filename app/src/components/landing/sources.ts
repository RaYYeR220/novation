import { CONTRACTS, testnetAddress } from './site';

export interface SourceLink {
  label: string;
  href: string;
}

export interface Source {
  id: SourceId;
  /** What the note establishes, in one or two sentences. */
  text: string;
  links: SourceLink[];
}

export type SourceId = 'tokens' | 'tvl' | 'feeds' | 'bench' | 'kernel' | 'demo' | 'issuer';

/** Every figure on the landing points at one of these; the order is the footnote numbering. */
export const SOURCES: readonly Source[] = [
  {
    id: 'tokens',
    text: '195 active stock tokens on Robinhood Chain (chain 4663), from Robinhood’s public stock-token asset list, read Sep 25, 2026.',
    links: [
      { label: 'docs.robinhood.com/chain', href: 'https://docs.robinhood.com/chain' },
      { label: 'api.robinhood.com/rhj/assets', href: 'https://api.robinhood.com/rhj/assets' },
    ],
  },
  {
    id: 'tvl',
    text: 'Robinhood Chain TVL about $1.0B on Sep 24, 2026, of which tokenized equities were about $125M.',
    links: [{ label: 'cryptoticker.io', href: 'https://cryptoticker.io/en/robinhood-chain-memecoins-explained/' }],
  },
  {
    id: 'feeds',
    text: 'Chainlink equity feeds on Robinhood Chain follow 24/5 US market hours and have no heartbeat off-hours. In 13 weeks of on-chain round history for NVDA, TSLA, AAPL and SPY there was no round between Friday afternoon and the forced round at Sunday 20:00 ET.',
    links: [
      { label: 'data.chain.link', href: 'https://data.chain.link' },
      { label: 'docs.robinhood.com/chain/oracles-and-price-feeds', href: 'https://docs.robinhood.com/chain/oracles-and-price-feeds' },
    ],
  },
  {
    id: 'bench',
    text: 'Black-Scholes margin over 39 scenarios, eth_estimateGas on Robinhood Chain testnet (chain 46630), L2 gas. Both contracts return identical integers on 659 on-chain cases. The per-transaction gas cap of 32,000,000 is ArbGasInfo.getMaxTxGasLimit() on the same chain. Marginal cost from 1 to 128 positions: 92,452 gas per position in Solidity, 5,311 in Stylus.',
    links: [
      { label: `Solidity ${CONTRACTS.benchSolidity.slice(0, 6)}…`, href: testnetAddress(CONTRACTS.benchSolidity) },
      { label: `Stylus ${CONTRACTS.benchStylus.slice(0, 6)}…`, href: testnetAddress(CONTRACTS.benchStylus) },
    ],
  },
  {
    id: 'kernel',
    text: 'The Novation risk kernel (Stylus) and its plain Solidity reference, deployed on Robinhood Chain testnet. Byte-identical return data at 4, 8 and 32 positions; gas from eth_estimateGas on margin(). The reference fails above the 50M call allowance at 64 positions and more.',
    links: [
      { label: `Kernel ${CONTRACTS.kernel.slice(0, 6)}…`, href: testnetAddress(CONTRACTS.kernel) },
      { label: `Reference ${CONTRACTS.kernelReference.slice(0, 6)}…`, href: testnetAddress(CONTRACTS.kernelReference) },
    ],
  },
  {
    id: 'demo',
    text: 'Demo account 7 and the hedge-bot ticket are computed by the Novation kernel reference with the default risk parameters (weekend shock multiplier 1.75). The Stylus kernel returns the same integers.',
    links: [],
  },
  {
    id: 'issuer',
    text: 'Stock tokens are issued by Robinhood Assets (Jersey) Ltd and are not available to US persons.',
    links: [
      {
        label: 'robinhood.com newsroom',
        href: 'https://robinhood.com/us/en/newsroom/robinhood-accelerates-global-expansion-robinhood-chain-mainnet-stock-tokens-agentic-trading/',
      },
    ],
  },
];

export function sourceNumber(id: SourceId): number {
  return SOURCES.findIndex((s) => s.id === id) + 1;
}
