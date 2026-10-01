import agents from '@/fixtures/agents.json';
import chains from '@/fixtures/chains.json';
import whatifs from '@/fixtures/whatifs.json';

const canned = whatifs[0]!;
const listed = Object.values(chains as Record<string, { series: { id: number; underlying: string }[] }>).flatMap((c) => c.series);
const bot = (agents as Record<string, { agent: string; label: string }[]>)[String(canned.id)]?.[0];

/**
 * The refused agent ticket the demo ships with: hedge-bot, acting for account 7, sells 60 NVDA 200
 * calls. The kernel reference computed it, so every number on the refusal is exact.
 */
export const DEMO_TICKET = {
  accountId: canned.id,
  seriesId: canned.seriesId,
  underlying: listed.find((x) => x.id === canned.seriesId)?.underlying ?? 'NVDA',
  qty: Math.abs(canned.qtyDelta),
  side: canned.qtyDelta < 0 ? ('sell' as const) : ('buy' as const),
  agent: bot?.agent,
  agentLabel: bot?.label ?? 'the agent',
};
