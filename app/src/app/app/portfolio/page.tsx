import type { Metadata } from 'next';
import { SectionPending } from '@/components/app/section-pending';

export const metadata: Metadata = { title: 'Portfolio' };

export default function PortfolioPage() {
  return <SectionPending title="Portfolio" body="The full margin view, the scenario crown and settlement status arrive with the next build." />;
}
