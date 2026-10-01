import type { Metadata } from 'next';
import { PortfolioView } from '@/components/portfolio/portfolio-view';

export const metadata: Metadata = {
  title: 'Portfolio',
  description: 'Equity against margin, the scenario crown by session, positions, and where each expiry stands.',
};

export default function PortfolioPage() {
  return <PortfolioView />;
}
