import { CONTRACTS, GAS_DOC_URL, shortAddress, testnetAddress } from './site';

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
    text: 'Robinhood Chain value locked about $1.00B on Sep 24, 2026 (DefiLlama). Tokenized assets, stock tokens among them, about $124.8M on DefiLlama’s broad count; about $32M on the narrower measure the same article cites.',
    links: [{ label: 'cryptoticker.io', href: 'https://cryptoticker.io/en/robinhood-chain-memecoins-explained/' }],
  },
  {
    id: 'feeds',
    text: 'Chainlink equity feeds on Robinhood Chain follow 24/5 US market hours and have no heartbeat off-hours. In 13 weeks of on-chain round history for NVDA, TSLA, AAPL and SPY there was no round on a Saturday or on a Sunday before 20:00 ET, and rounds after the Friday 16:00 ET close were rare.',
    links: [
      { label: 'data.chain.link', href: 'https://data.chain.link' },
      { label: 'docs.robinhood.com/chain/oracles-and-price-feeds', href: 'https://docs.robinhood.com/chain/oracles-and-price-feeds' },
    ],
  },
  {
    id: 'bench',
    text: 'Execution gas of one margin() call on Robinhood Chain testnet (chain 46630), measured with a gasleft() probe inside eth_call. Stylus: the Novation risk kernel, on a book spread over 8 underlyings. Solidity: a hand-optimized version of the same 39-scenario grid and integer math, on a one-underlying book, without the short-option minimum the kernel adds. Marginal cost about 5,000 gas per position on Stylus and 92,452 in Solidity. The 32,000,000 per-transaction limit is ArbGasInfo.getMaxTxGasLimit() on the same chain.',
    links: [
      { label: `Kernel ${shortAddress(CONTRACTS.kernel)}`, href: testnetAddress(CONTRACTS.kernel) },
      { label: `Solidity baseline ${shortAddress(CONTRACTS.benchSolidity)}`, href: testnetAddress(CONTRACTS.benchSolidity) },
      { label: 'docs/gas.md', href: GAS_DOC_URL },
    ].filter((l) => l.href),
  },
  {
    id: 'kernel',
    text: 'The Novation risk kernel (Stylus) and KernelReference, its plain Solidity twin, deployed on Robinhood Chain testnet. Byte-identical return data on margin() books of 4, 8 and 32 positions. Gas from eth_estimateGas on margin() on Sep 30, 2026, one-underlying books, including intrinsic, calldata and L1 costs. At 64 positions and more the reference needs more than the RPC’s 50M call allowance.',
    links: [
      { label: `Kernel ${shortAddress(CONTRACTS.kernel)}`, href: testnetAddress(CONTRACTS.kernel) },
      { label: `Reference ${shortAddress(CONTRACTS.kernelReference)}`, href: testnetAddress(CONTRACTS.kernelReference) },
      { label: 'docs/gas.md', href: GAS_DOC_URL },
    ].filter((l) => l.href),
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
