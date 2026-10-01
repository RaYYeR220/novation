import agents from '@/fixtures/agents.json';
import whatifs from '@/fixtures/whatifs.json';
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
/** The hedge-bot's refused ticket: the clearinghouse compares the account's initial margin after the trade with the agent's budget. */
const overBudget = whatifs.find((w) => w.id === 7 && w.quote.refusal?.code === 'AgentRiskBudgetExceeded')!;

export default async function Landing() {
  const d = await landingData();
  return (
    <>
      <main>
        <Hero grids={d.grids} ims={d.ims} />
        <Problem />
        <HowItWorks trade={d.trade} />
        <Gas rows={d.gas} />
        <WaysIn agent={{ label: grant.label, budget: grant.maxWorstLoss, im: d.ims.REGULAR }} />
        <Breaks ims={d.ims} agent={{ label: grant.label, imAfter: overBudget.quote.after.im, budget: grant.maxWorstLoss }} />
        <Checked />
        <ProtocolStrip stats={d.protocol} asOf={d.asOf} demo={d.demo} />
        <Sources />
      </main>
      <Footer />
    </>
  );
}
