import type { Metadata } from 'next';
import { TradeView } from '@/components/trade/trade-view';

export const metadata: Metadata = {
  title: 'Trade',
  description: 'Options chain, payoff and the margin this ticket needs, before you sign.',
};

export default function TradePage() {
  return <TradeView />;
}
