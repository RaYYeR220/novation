import { Suspense } from 'react';
import { NovationDiagram } from '@/components/charts/NovationDiagram';
import { cn } from '@/lib/cn';
import type { DiagramTrade } from './data';
import { Ref, SectionHead, WRAP, srcAttr } from './parts';

export function HowItWorks({ trade }: { trade: DiagramTrade }) {
  return (
    <section aria-labelledby="how-it-works">
      <SectionHead id="how-it-works" title="How a trade clears">
        <p>
          Buyer and seller agree a price. Novation steps between them: each side ends up holding its position against the clearinghouse, and
          neither position exists until both whole books pass the same stress test.
          <Ref id="demo" />
        </p>
      </SectionHead>
      <div className={cn(WRAP, 'mt-s8 md:mt-s9')} data-source={srcAttr('demo')}>
        {/* its own boundary, so it hydrates after the hero instead of in the same task */}
        <Suspense>
          <NovationDiagram
            series={trade.series}
            qty={trade.qty}
            premium={trade.premium}
            buyer={{ role: 'Buyer', name: trade.buyer.label, cells: trade.buyer.cells, imAfter: trade.buyer.imAfter, equity: trade.buyer.equity }}
            seller={{ role: 'Seller', name: trade.seller.label, cells: trade.seller.cells, imAfter: trade.seller.imAfter, equity: trade.seller.equity }}
          />
        </Suspense>
      </div>
    </section>
  );
}
