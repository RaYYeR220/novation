import account7 from '@/fixtures/account7.json';
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

export interface LandingData {
  asOf: number;
  demo: boolean;
  grids: { REGULAR: ScenarioGrid; WEEKEND: ScenarioGrid };
  ims: { REGULAR: number; WEEKEND: number };
  gas: GasRow[];
  protocol: ProtocolStats;
  trade: DiagramTrade;
}

const BUYER = 7;
const SELLER = 1;
/** NVDA 225 call, the nearest weekly expiry: account 7 buys one from the demo maker at the ask. */
const SERIES_ID = 15;
const QTY = 1;

function client(): NovationClient {
  if (process.env.NEXT_PUBLIC_CLIENT === 'chain') throw new Error('NEXT_PUBLIC_CLIENT=chain: the chain client is not implemented yet');
  return new MockClient();
}

export async function landingData(): Promise<LandingData> {
  const c = client();
  const series = Object.values(chains as Record<string, { series: { id: number; strike: number; isCall: boolean; underlying: string; ask: number }[] }>)
    .flatMap((x) => x.series)
    .find((s) => s.id === SERIES_ID);
  if (!series) throw new Error(`series ${SERIES_ID} missing from fixtures`);
  const premium = series.ask * QTY;

  const [asOf, regular, weekend, gas, protocol, buyer, seller, buyerGrid, sellerGrid, buyQuote, sellQuote] = await Promise.all([
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
  ]);

  return {
    asOf,
    demo: c instanceof MockClient,
    grids: { REGULAR: regular, WEEKEND: weekend },
    ims: { REGULAR: account7.summary.im_regular, WEEKEND: account7.summary.im_weekend },
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
  };
}
