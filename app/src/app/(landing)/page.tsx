import agents from '@/fixtures/agents.json';
import refusals from '@/fixtures/refusals.json';
import { Breaks } from '@/components/landing/breaks';
import { Checked } from '@/components/landing/checked';
import { Footer, ProtocolStrip, Sources } from '@/components/landing/closing';
import { landingData } from '@/components/landing/data';
import { Gas } from '@/components/landing/gas';
import { Hero } from '@/components/landing/hero';
import { HowItWorks } from '@/components/landing/how-it-works';
import { Problem } from '@/components/landing/problem';
import { WaysIn } from '@/components/landing/ways-in';

const grant = agents['7'][0]!;
const refused = refusals.find((r) => r.code === 'AgentRiskBudgetExceeded')!;

export default async function Landing() {
  const d = await landingData();
  return (
    <>
      <main>
        <Hero grids={d.grids} ims={d.ims} />
        <Problem />
        <HowItWorks trade={d.trade} />
        <Gas rows={d.gas} />
        <WaysIn agent={{ label: grant.label, budget: grant.maxWorstLoss, used: grant.used }} />
        <Breaks ims={d.ims} agent={{ label: grant.label, worstLoss: refused.numbers?.worstLoss ?? 0, budget: refused.numbers?.budget ?? 0 }} />
        <Checked />
        <ProtocolStrip stats={d.protocol} asOf={d.asOf} demo={d.demo} />
        <Sources />
      </main>
      <Footer />
    </>
  );
}
