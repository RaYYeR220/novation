/**
 * Links and deployment facts for the landing. Empty strings stay hidden: the repository, docs and
 * proof transactions are filled in when the protocol is submitted.
 */
export const LINKS = {
  github: process.env.NEXT_PUBLIC_GITHUB_URL ?? '',
  docs: process.env.NEXT_PUBLIC_DOCS_URL ?? '',
  riskModel: process.env.NEXT_PUBLIC_RISK_MODEL_URL ?? '',
  x: 'https://x.com/rayyer_220',
} as const;

/** Repository documents behind "Built to be checked". Each link shows once its URL is set. */
export const CHECK_LINKS = {
  immutableCore: process.env.NEXT_PUBLIC_DOC_CORE_URL ?? '',
  timelock: process.env.NEXT_PUBLIC_DOC_PARAMS_URL ?? '',
  invariants: process.env.NEXT_PUBLIC_DOC_INVARIANTS_URL ?? '',
  parity: process.env.NEXT_PUBLIC_DOC_PARITY_URL ?? '',
  selfReview: process.env.NEXT_PUBLIC_DOC_REVIEW_URL ?? '',
} as const;

/** Mainnet transactions that show each refusal firing. */
export const PROOF_TX = {
  weekend: process.env.NEXT_PUBLIC_PROOF_WEEKEND_TX ?? '',
  corporateAction: process.env.NEXT_PUBLIC_PROOF_CORPORATE_TX ?? '',
  staleFeed: process.env.NEXT_PUBLIC_PROOF_STALE_TX ?? '',
  agentBudget: process.env.NEXT_PUBLIC_PROOF_AGENT_TX ?? '',
} as const;

export type Deployment = 'testnet' | 'mainnet';
export const DEPLOYMENT: Deployment = process.env.NEXT_PUBLIC_DEPLOYMENT === 'mainnet' ? 'mainnet' : 'testnet';

export const EXPLORER = {
  mainnet: 'https://robinhoodchain.blockscout.com',
  testnet: 'https://explorer.testnet.chain.robinhood.com',
} as const;

export const txUrl = (hash: string) => `${EXPLORER[DEPLOYMENT]}/tx/${hash}`;
export const testnetAddress = (a: string) => `${EXPLORER.testnet}/address/${a}`;

/** Contracts the gas figures were measured against, all on Robinhood Chain testnet (chain 46630). */
export const CONTRACTS = {
  kernel: '0x6d07e246eb757A1F97E3cdB7d1881ee5De27ceaA',
  kernelReference: '0xB7d9232c8ff46b4950d85ed639908c86C08750C6',
  /** The hand-optimized Solidity baseline the gas chart compares the kernel with. */
  benchSolidity: '0x9F5a98A1E678b124998328cfa0056c90720ceCEe',
} as const;

/** The repository's gas page, once the repository URL is set. */
export const GAS_DOC_URL = LINKS.github ? `${LINKS.github.replace(/\/$/, '')}/blob/main/docs/gas.md` : '';

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
