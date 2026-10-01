import type { Metadata } from 'next';
import { AgentsView } from '@/components/agents/agents-view';

export const metadata: Metadata = {
  title: 'Agents',
  description: 'Risk budgets for agents: grant, inspect and revoke, with the last refusal and an MCP connection.',
};

export default function AgentsPage() {
  return <AgentsView />;
}
