import { Breaks } from '@/components/landing/breaks';
import { Checked } from '@/components/landing/checked';
import { Footer, ProtocolStrip, Sources } from '@/components/landing/closing';
import { landingData } from '@/components/landing/data';
import { Gas } from '@/components/landing/gas';
import { Hero } from '@/components/landing/hero';
import { HowItWorks } from '@/components/landing/how-it-works';
import { Problem } from '@/components/landing/problem';
import { WaysIn } from '@/components/landing/ways-in';

export default async function Landing() {
  const d = await landingData();
  return (
    <>
      <main>
        <Hero grids={d.grids} ims={d.ims} />
        <Problem />
        <HowItWorks trade={d.trade} />
        <Gas rows={d.gas} />
        <WaysIn agent={{ label: d.agent.label, budget: d.agent.budget, im: d.agent.imNow }} />
        <Breaks ims={d.ims} agent={d.agent} />
        <Checked />
        <ProtocolStrip stats={d.protocol} asOf={d.asOf} demo={d.demo} />
        <Sources />
      </main>
      <Footer />
    </>
  );
}
