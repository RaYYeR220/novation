import type { Metadata } from 'next';
import { SectionPending } from '@/components/app/section-pending';

export const metadata: Metadata = { title: 'Earn' };

export default function EarnPage() {
  return <SectionPending title="Earn" body="Covered-call and put-write vaults, their NAV and deposits, arrive with the next build." />;
}
