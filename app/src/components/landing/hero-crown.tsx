'use client';

import { useMemo, useState } from 'react';
import { Crown } from '@/components/crown/Crown';
import { crownScale } from '@/components/crown/crownMath';
import type { ScenarioGrid, Session } from '@/lib/client/types';

type HeroSession = 'REGULAR' | 'WEEKEND';

export interface HeroCrownProps {
  grids: Record<HeroSession, ScenarioGrid>;
  ims: Record<HeroSession, number>;
  className?: string;
}

/** The scenario crown of demo account 7, switchable between a regular session and a weekend. */
export function HeroCrown({ grids, ims, className }: HeroCrownProps) {
  const [session, setSession] = useState<HeroSession>('REGULAR');
  const scale = useMemo(() => crownScale([grids.REGULAR.cells, grids.WEEKEND.cells], [ims.REGULAR, ims.WEEKEND]), [grids, ims]);
  const onSessionChange = (s: Session) => setSession(s === 'WEEKEND' ? 'WEEKEND' : 'REGULAR');
  return (
    <Crown
      variant="hero"
      grid={grids[session]}
      im={ims[session]}
      session={session}
      onSessionChange={onSessionChange}
      scale={scale}
      load="intent"
      className={className}
      labels={{
        name: 'Scenario crown of demo account 7: the book re-priced across 39 price and volatility scenarios',
        im: 'Initial margin, demo account 7',
      }}
    />
  );
}
