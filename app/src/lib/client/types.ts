export type Session = 'REGULAR' | 'EXTENDED' | 'WEEKEND' | 'HOLIDAY' | 'HALTED';
export interface Underlying { address: `0x${string}`; symbol: string; name: string; spot: number; session: Session; markVol: number; uiMultiplier: number; halted: boolean; haltReason?: string; }
export interface Series { id: number; underlying: string; expiry: number; strike: number; isCall: boolean; }
export interface Position { seriesId: number; qty: number; mark: number; }
/**
 * Clearinghouse.accountState. `settledValue`: expired positions not yet settled plus unpaid claims, at face.
 * `deficit`: USDG owed to the insurance fund after a settlement. equity = cash + mtm + settledValue − deficit.
 */
export interface AccountState { cash: number; mtm: number; settledValue: number; deficit: number; equity: number; im: number; mm: number; worstScenario: number; healthy: boolean; liquidatable: boolean; }
/** The kernel's 39 scenarios for a book under one session's shocks, and the initial margin those shocks give. */
export interface ScenarioGrid { session: Session; cells: number[] /* 39, index = v*13+j */; shockRange: Record<string, number>; im: number; }
export interface Refusal {
  code:
    | 'InsufficientMargin' | 'AgentRiskBudgetExceeded' | 'AgentPremiumExceeded' | 'AgentValueDrainExceeded' | 'AgentUnderlyingNotAllowed' | 'OpeningNotAllowed'
    | 'OpenInterestCap' | 'VaultNotLive' | 'InsufficientCash' | 'VolNotCurrent' | 'TooManyClaimExpiries' | 'StillLiquidatable' | 'FallbackApplies' | string;
  message: string;
  numbers?: Record<string, number>;
  /** The underlying the refusal names, by symbol (VolNotCurrent: the one whose vol is behind its feed). */
  underlying?: string;
}
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
  /** True when any figure here (margin, after-trade grid) is a float estimate rather than the kernel's own output. */
  approx?: boolean;
  /** Live RFQ tickets: the signed maker quote the premium comes from, and when it expires (unix seconds). */
  rfq?: { maker: string; makerId: number; expiresAt: number; hash: `0x${string}`; price: number };
}
export type Venue = 'vault' | 'rfq';
export interface WhatIfOptions { agent?: string; venue?: Venue; }
export interface Vault {
  address: string; kind: 'coveredCall' | 'putWrite'; underlying: string; tvl: number; nav: number; apy7d: number; utilization: number; epoch: number; live: boolean;
  /**
   * The underlying's session. A WEEKEND or HOLIDAY session closes the vault (`live` is false): no
   * quotes, sales, buy-backs, deposits, exits or roll payouts; queuing an exit still works.
   */
  session: Session;
  /** Feed rounds the underlying's vol has not folded in; null after a feed migration. Read from the chain; absent in the demo. */
  volBehind?: number | null;
}
export interface AgentGrant { agent: string; label: string; maxWorstLoss: number; maxPremiumPerTrade: number; allowed: string[]; expiresAt: number; used: number; lastRefusal?: Refusal & { txHash?: string }; }
export interface ProtocolStats { openInterestUsd: number; vaultTvlUsd: number; insuranceFundUsd: number; premium7dUsd: number; liquidations7d: number; socializedUsd: number; }
export interface GasRow { positions: number; solidityOptimized: number; solidityReference?: number; stylus: number; }

/* ---------- vaults (OptionVaultBase) ---------- */
export interface VaultConfig {
  minOtm: number; maxTenorDays: number; skewSlope: number; utilSlope: number; spread: number;
  sessionVolAdd: Record<string, number>; maxTradeQty: number; maxOpenSeries: number; minDelta: number; maxDelta: number; minNewSeriesQty: number;
}
export interface VaultEpoch {
  epoch: number; expiry: number; strike: number; qty: number; premium: number; soldAt: number; spotAtSale: number; volQuoted: number;
  settlePrice: number; settleRound: number; payout: number; deficit: number; navBefore: number; navAfter: number;
}
export interface VaultDeficit { expiry: number; owed: number; paidCash: number; bridged: number; soldTokens: number; salePrice: number; settledAt: number }
export interface VaultDetail extends Vault {
  name: string; symbol: string;
  /** What deposits and exits pay in: the stock token (covered call) or USDG (put write). */
  asset: string;
  config: VaultConfig;
  launchedAt: number;
  /** Shares outstanding, and those escrowed in the redemption queue for the next roll. */
  shares: number; escrowedShares: number;
  /** Live MTM NAV per share, in the asset. */
  navPerShare: number; navWeekAgo: number;
  /** In asset units: what backs the shorts, what they lock, what the queue is owed, and what can leave now. */
  backing: number; locked: number; queued: number; free: number;
  cash: number; tokens: number;
  openSeries: (Series & { seriesId: number; qty: number; premium: number; soldAt: number; mark: number })[];
  /** The expiry whose settlement lets the next roll pay the queue. */
  nextRoll: number;
  /** Seconds shares must sit before they can leave (EXIT_COOLDOWN). */
  cooldown: number;
  navHistory: { t: number; nav: number; tvl: number; spot: number }[];
  epochs: VaultEpoch[];
  deficits: VaultDeficit[];
  markVol: number;
  /** Demo: share of capacity takers bought at each roll in the replay. */
  fillShare: number;
  /**
   * Present while the vault holds a series that expired and isn't settled into its account yet:
   * deposits, instant exits and the queue's payout wait for it (a roll settles it). Queuing a
   * redemption still works. `rollable`: the registry has the price, so anyone can roll the vault
   * now. `until`: while the price is still missing, when the wait ends at the latest.
   */
  settlementWait?: { expiries: number[]; awaitingPrice: boolean; rollable: boolean; until?: number };
}
export interface VaultHolding {
  vault: string; shares: number; lastReceive: number; pendingShares: number;
  /** Rolled redemptions claimable now: the asset part (claimRedeemed) and, for a covered call, the USDG part (claimRedeemedCash). */
  redeemable?: number; redeemableCash?: number;
  /** The most value (asset units at NAV) the holder can take out now, where the chain says; otherwise the vault's free assets bound it. */
  maxExit?: number;
}
/**
 * What an exit worth `value` (asset units at NAV) pays now: `tokens` of the vault's asset and `cash`
 * USDG on top, for `shares` shares. Covered-call exits are in kind (the holder's share of the vault's
 * USDG cash comes in USDG); a put-write vault's asset is USDG, so `cash` is 0.
 */
export interface ExitPreview { shares: number; tokens: number; cash: number }
export interface WalletHoldings { owner: string; tokens: Record<string, number>; vaults: VaultHolding[] }

/* ---------- settlement (pool per expiry) ---------- */
export interface SettlementPrice {
  symbol: string; method: 'last print' | 'fallback' | 'waiting'; round: number | null; price: number | null; updatedAt: number | null;
  /** Seconds between the print and the close. */
  lag?: number | null;
  proof?: { kind: 'latest' | 'next' | 'fallback'; round?: number; at?: number };
  settledAt?: number;
}
export interface ExpiryPool {
  expiry: number; status: 'open' | 'waiting' | 'ready' | 'closed'; prices: SettlementPrice[];
  paidIn: number; bridged: number; pending: number; claims: number; claimed: number;
  /** Short contracts of this expiry not yet settled. Claims open at zero, with nothing pending. */
  unsettledShortQty: number; readyAt: number | null; settledAt: number | null; accounts: number;
}
export interface ExpiryLeg { underlying: string; strike: number; isCall: boolean; qty: number; settlePrice: number; payoff: number }
export interface AccountExpiry {
  expiry: number;
  status: 'open' | 'claimable' | 'claimed' | 'paid' | 'deficit' | 'deficit-cleared';
  /** Net payoff: positive receives a claim, negative pays into the pool. For an open expiry, at today's spot. */
  net: number; legs: ExpiryLeg[];
  settledAt?: number; readyAt?: number; claimedAt?: number; claimable?: number;
  paidCash?: number; bridged?: number; shortfall?: number; cash?: number; clearedAt?: number;
  deficitSale?: { startedAt: number; bidAt: number; discount: number; spot: number; price: number; tokensSold: number; proceeds: number };
}

/* ---------- risk ---------- */
export type HaltReason = 'implausible' | 'stale' | 'multiplier' | 'oraclePaused' | 'answer';
export interface HaltEpisode { symbol: string; reason: HaltReason; from: number; to: number; detail: Record<string, unknown> }
export interface FeedStatus {
  symbol: string; proxy: string; description: string; session: Session; spot: number; lastRound: number;
  band: [number, number]; staleLimits: { REGULAR: number; EXTENDED: number; CLOSED: number }; haltWindow: number;
  uiMultiplier: number; lastMultiplierChange: number | null; oraclePaused: boolean; paused: boolean;
  corporateAction?: { kind: string; amount: number; status: string; processDate: string } | null;
  halts: HaltEpisode[]; historyFrom: number; historyTo: number; rounds: number;
  /**
   * Feed rounds the vol estimate has not folded in yet; null when the feed moved to a new aggregator
   * phase (the vol waits for syncAndRebaseVol). Read from the chain; absent in the demo.
   */
  volBehind?: number | null;
}
export interface Auction {
  id: number; kind: 'liquidation' | 'deficit'; account: number; startedAt: number;
  startDiscount: number; maxDiscount: number; duration: number; maxFractionPerBid: number; penaltyBps: number;
  equity: number; im: number; mm: number;
  /** What a bid prices against: equity + deficit − pending claims. */
  transferable: number;
  underlyings: string[]; status: 'active' | 'paused' | 'ended';
}
export interface InsuranceFund {
  balance: number; outstanding: number; socialized: number; cashIndex: number;
  events: { at: number; kind: 'seed' | 'cover' | 'recover' | 'penalty'; amount: number; who: string; expiry?: number }[];
}
export interface OpenInterestRow { underlying: string; shortContracts: number; notionalUsd: number }
export type FeedRefusal = Refusal & { at: number; txHash?: string; account?: number; agent?: string; detail?: string; vault?: string };
export type NewGrant = Omit<AgentGrant, 'used' | 'lastRefusal'>;

export interface NovationClient {
  /** Unix seconds the data reflects: the latest block for the chain, the snapshot for demo fixtures. */
  asOf(): Promise<number>;
  underlyings(): Promise<Underlying[]>;
  /** `bid`/`ask` are NaN where nobody quotes that side; `mark` is the kernel's price at mark vol, where known. */
  chain(underlying: string, expiry?: number): Promise<{ expiries: number[]; series: (Series & { bid: number; ask: number; delta: number; iv: number; mark?: number })[] }>;
  account(id: number): Promise<{ id: number; owner: string; state: AccountState; positions: (Position & Series)[]; collateral: Record<string, number> }>;
  scenarioGrid(id: number, session?: Session): Promise<ScenarioGrid>;
  /**
   * The margin the ticket would leave, before anything is signed. `agent`: an agent signs, so its policy
   * on the account applies too. `venue`: where the premium was quoted (vault or RFQ).
   */
  whatIf(id: number, seriesId: number, qtyDelta: number, premium: number, opts?: WhatIfOptions): Promise<Quote>;
  vaults(): Promise<Vault[]>;
  agents(id: number): Promise<AgentGrant[]>;
  protocol(): Promise<ProtocolStats>;
  gasTable(): Promise<GasRow[]>;
  refusalsFeed(): Promise<FeedRefusal[]>;
  /** Vault detail: NAV history (indexer), the free/locked split and the queue (vault views). */
  vault(address: string): Promise<VaultDetail>;
  /** A wallet's tokens and vault shares. */
  wallet(owner: string): Promise<WalletHoldings>;
  /** Both parts of an exit worth `value` (asset units at NAV) from `vault`; `owner` caps the shares at what it holds. */
  previewExit(vault: string, value: number, owner?: string): Promise<ExitPreview>;
  /** The account's expiries: the open one at today's spot, then each settled one with its pool state. */
  expiries(id: number): Promise<AccountExpiry[]>;
  pools(): Promise<ExpiryPool[]>;
  feeds(): Promise<FeedStatus[]>;
  auctions(): Promise<Auction[]>;
  insurance(): Promise<InsuranceFund>;
  openInterest(): Promise<OpenInterestRow[]>;
  /** Owner only. Returns the transaction hash. */
  grantAgent(id: number, grant: NewGrant): Promise<string>;
  revokeAgent(id: number, agent: string): Promise<string>;
}
