import type { Metadata } from 'next';
import { SectionPending } from '@/components/app/section-pending';

export const metadata: Metadata = { title: 'Agents' };

export default function AgentsPage() {
  return <SectionPending title="Agents" body="Risk budgets for agents, with grant and revoke, arrive with the next build." />;
}
