import type { Metadata } from 'next';
import { SectionPending } from '@/components/app/section-pending';

export const metadata: Metadata = { title: 'Risk' };

export default function RiskPage() {
  return <SectionPending title="Risk" body="Session board, insurance fund, auctions and the refusal feed arrive with the next build." />;
}
