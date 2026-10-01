import type { Metadata } from 'next';
import { EarnView } from '@/components/earn/earn-view';

export const metadata: Metadata = {
  title: 'Earn',
  description: 'Covered-call and put-write vaults: NAV, strategy rules, deposits and redemptions at the live NAV.',
};

export default function EarnPage() {
  return <EarnView />;
}
