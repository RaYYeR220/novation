import chains from '@/fixtures/chains.json';
import { MockClient } from '@/lib/client/mock';
import type { GasRow, NovationClient, ProtocolStats, ScenarioGrid } from '@/lib/client/types';

/** One side of the demo trade in the novation diagram: the book before and after, from the client's what-if. */
export interface DiagramSide {
  account: number;
  label: string;
  cells: number[];
  imBefore: number;
  imAfter: number;
  equity: number;
}

export interface DiagramTrade {
  series: string;
  qty: number;
  premium: number;
  buyer: DiagramSide;
  seller: DiagramSide;
}

/**
 * The demo agent and its refused ticket, read the way /app/agents and /app/risk read them: the grant's
 * budget and current use, and the refusal's worst case after the trade (the account's lossIM).
 */
export interface LandingAgent {
  label: string;
  budget: number;
  imNow: number;
  worstAfter: number;
  /** What the agent tried, in words: "sell 60 NVDA 200 calls". */
  ticket: string;
}

export interface LandingData {
  asOf: number;
  demo: boolean;
  grids: { REGULAR: ScenarioGrid; WEEKEND: ScenarioGrid };
  ims: { REGULAR: number; WEEKEND: number };
  gas: GasRow[];
  protocol: ProtocolStats;
  trade: DiagramTrade;
  agent: LandingAgent;
}

const BUYER = 7;
const SELLER = 1;
/** NVDA 225 call, the nearest weekly expiry: account 7 buys one from the demo maker at the ask. */
const SERIES_ID = 15;
const QTY = 1;

/** The landing always shows the demo snapshot, whatever NEXT_PUBLIC_CLIENT says (that only sets the app's default source). */
function client(): NovationClient {
  return new MockClient();
}

export async function landingData(): Promise<LandingData> {
  const c = client();
  const series = Object.values(chains as Record<string, { series: { id: number; strike: number; isCall: boolean; underlying: string; ask: number }[] }>)
    .flatMap((x) => x.series)
    .find((s) => s.id === SERIES_ID);
  if (!series) throw new Error(`series ${SERIES_ID} missing from fixtures`);
  const premium = series.ask * QTY;

  const [asOf, regular, weekend, gas, protocol, buyer, seller, buyerGrid, sellerGrid, buyQuote, sellQuote, grants, feed] = await Promise.all([
    c.asOf(),
    c.scenarioGrid(BUYER, 'REGULAR'),
    c.scenarioGrid(BUYER, 'WEEKEND'),
    c.gasTable(),
    c.protocol(),
    c.account(BUYER),
    c.account(SELLER),
    c.scenarioGrid(BUYER),
    c.scenarioGrid(SELLER),
    c.whatIf(BUYER, SERIES_ID, QTY, premium),
    c.whatIf(SELLER, SERIES_ID, -QTY, premium),
    c.agents(BUYER),
    c.refusalsFeed(),
  ]);

  const grant = grants.find((g) => g.lastRefusal?.code === 'AgentRiskBudgetExceeded');
  const refused = feed.find((r) => r.code === 'AgentRiskBudgetExceeded' && r.account === BUYER && r.agent === grant?.agent);
  const worstAfter = refused?.numbers?.worstLoss;
  if (!grant || !refused?.detail || worstAfter === undefined) throw new Error('the over-budget agent refusal is missing from the demo data');
  const action = refused.detail.split(' through ')[0]!;

  return {
    asOf,
    demo: c instanceof MockClient,
    grids: { REGULAR: regular, WEEKEND: weekend },
    ims: { REGULAR: regular.im, WEEKEND: weekend.im },
    gas,
    protocol,
    trade: {
      series: `${series.underlying} ${series.strike}${series.isCall ? 'C' : 'P'}`,
      qty: QTY,
      premium,
      buyer: {
        account: BUYER,
        label: 'Account 7',
        cells: buyQuote.afterGrid ?? buyerGrid.cells,
        imBefore: buyer.state.im,
        imAfter: buyQuote.after.im,
        equity: buyQuote.after.equity,
      },
      seller: {
        account: SELLER,
        label: 'Market maker',
        cells: sellQuote.afterGrid ?? sellerGrid.cells,
        imBefore: seller.state.im,
        imAfter: sellQuote.after.im,
        equity: sellQuote.after.equity,
      },
    },
    agent: {
      label: grant.label,
      budget: grant.maxWorstLoss,
      imNow: grant.used,
      worstAfter,
      ticket: action.charAt(0).toLowerCase() + action.slice(1),
    },
  };
}
