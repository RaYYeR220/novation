export type Session = 'REGULAR' | 'EXTENDED' | 'WEEKEND' | 'HOLIDAY' | 'HALTED';
export interface Underlying { address: `0x${string}`; symbol: string; name: string; spot: number; session: Session; markVol: number; uiMultiplier: number; halted: boolean; haltReason?: string; }
export interface Series { id: number; underlying: string; expiry: number; strike: number; isCall: boolean; }
export interface Position { seriesId: number; qty: number; mark: number; }
export interface AccountState { cash: number; mtm: number; settledValue: number; deficit: number; equity: number; im: number; mm: number; worstScenario: number; healthy: boolean; liquidatable: boolean; }
export interface ScenarioGrid { session: Session; cells: number[] /* 39, index = v*13+j */; shockRange: Record<string, number>; }
export interface Refusal { code: 'InsufficientMargin' | 'AgentRiskBudgetExceeded' | 'OpeningNotAllowed' | 'OpenInterestCap' | 'VaultNotLive' | 'InsufficientCash' | string; message: string; numbers?: Record<string, number>; }
/**
 * `premium` is always a positive magnitude; direction comes from the sign of `qtyDelta`.
 * Buy (qtyDelta > 0): the account pays premium + fee. Sell (qtyDelta < 0): it receives
 * premium and pays fee (cash changes by +premium - fee). Mirrors the contract TradeParams.
 */
export interface Quote {
  premium: number;
  fee: number;
  after: AccountState;
  refusal?: Refusal;
  /** The 39-cell scenario grid of the book after the trade (kernel `scenarioGrid` on the post-trade book). */
  afterGrid?: number[];
  /** True when the margin figures are an estimate rather than the kernel's own output. */
  approx?: boolean;
}
export interface Vault { address: string; kind: 'coveredCall' | 'putWrite'; underlying: string; tvl: number; nav: number; apy7d: number; utilization: number; epoch: number; live: boolean; }
export interface AgentGrant { agent: string; label: string; maxWorstLoss: number; maxPremiumPerTrade: number; allowed: string[]; expiresAt: number; used: number; lastRefusal?: Refusal & { txHash?: string }; }
export interface ProtocolStats { openInterestUsd: number; vaultTvlUsd: number; insuranceFundUsd: number; premium7dUsd: number; liquidations7d: number; socializedUsd: number; }
export interface GasRow { positions: number; solidityOptimized: number; solidityReference?: number; stylus: number; }
export interface NovationClient {
  /** Unix seconds the data reflects: the latest block for the chain, the snapshot for demo fixtures. */
  asOf(): Promise<number>;
  underlyings(): Promise<Underlying[]>;
  chain(underlying: string, expiry?: number): Promise<{ expiries: number[]; series: (Series & { bid: number; ask: number; delta: number; iv: number })[] }>;
  account(id: number): Promise<{ id: number; owner: string; state: AccountState; positions: (Position & Series)[]; collateral: Record<string, number> }>;
  scenarioGrid(id: number, session?: Session): Promise<ScenarioGrid>;
  /** `agent`: when an agent signs, the trade is also checked against that agent's policy on the account. */
  whatIf(id: number, seriesId: number, qtyDelta: number, premium: number, agent?: string): Promise<Quote>;
  vaults(): Promise<Vault[]>;
  agents(id: number): Promise<AgentGrant[]>;
  protocol(): Promise<ProtocolStats>;
  gasTable(): Promise<GasRow[]>;
  refusalsFeed(): Promise<(Refusal & { at: number; txHash?: string; account?: number })[]>;
}
