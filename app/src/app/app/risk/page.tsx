import type { Metadata } from 'next';
import { RiskView } from '@/components/risk/risk-view';

export const metadata: Metadata = {
  title: 'Risk',
  description: 'Sessions and halt reasons per underlying, the insurance fund, settlement pools, auctions and every refusal.',
};

export default function RiskPage() {
  return <RiskView />;
}
