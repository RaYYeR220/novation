'use client';

import dynamic from 'next/dynamic';
import { useMemo, useRef, useState } from 'react';
import { Crown } from '@/components/crown/Crown';
import { crownBounds, crownScale, describeNode, naturalAspect, worstNode, type CrownScale } from '@/components/crown/crownMath';
import { CrownRig } from '@/components/crown/rig';
import type { ScenarioGrid } from '@/lib/client/types';
import { SESSION_LABEL, fmtNumber } from '@/lib/format';

const CrownScene = dynamic(() => import('@/components/crown/CrownScene'), { ssr: false });

export type LabView = 'all' | 'hero' | 'panel' | 'poster';
type LabSession = 'REGULAR' | 'WEEKEND';

interface LabProps {
  view: LabView;
  grids: Record<LabSession, ScenarioGrid>;
  ims: Record<LabSession, number>;
  equity: number;
  initialSession: LabSession;
  measure: boolean;
  quality: 'auto' | 'low';
}

export function CrownLab({ view, grids, ims, equity, initialSession, measure, quality }: LabProps) {
  const [session, setSession] = useState<LabSession>(initialSession);
  const scale = useMemo(
    () => crownScale([grids.REGULAR.cells, grids.WEEKEND.cells], [ims.REGULAR, ims.WEEKEND]),
    [grids, ims],
  );
  const onSessionChange = (s: string) => setSession(s === 'WEEKEND' ? 'WEEKEND' : 'REGULAR');
  const shared = {
    grid: grids[session],
    im: ims[session],
    session,
    onSessionChange,
    scale,
    measure,
    quality,
  };

  if (view === 'poster') return <PosterFrame grid={grids[session]} im={ims[session]} scale={scale} />;

  return (
    <main className="min-h-svh bg-navy-900">
      {view !== 'panel' ? <HeroMock>{<Crown variant="hero" labels={{ im: 'Initial margin, account 7' }} {...shared} />}</HeroMock> : null}
      {view !== 'hero' ? (
        <PanelMock equity={equity} im={ims[session]} session={session} grid={grids[session]}>
          <Crown variant="panel" {...shared} />
        </PanelMock>
      ) : null}
    </main>
  );
}

function PageGrid() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex justify-center">
      <div className="grid h-full w-[min(1280px,calc(100%-32px))] grid-cols-2 border-l border-navy-50/[0.06] md:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className={`border-r border-navy-50/[0.06] ${i > 1 ? 'hidden md:block' : ''}`} />
        ))}
      </div>
    </div>
  );
}

function HeroMock({ children }: { children: React.ReactNode }) {
  return (
    <section className="relative isolate flex h-svh min-h-[620px] flex-col overflow-hidden">
      <PageGrid />
      <header className="relative z-10 mx-auto flex h-16 w-[min(1280px,calc(100%-32px))] items-center justify-between border-b border-navy-50/[0.06]">
        <span className="font-display text-[22px] font-bold">Novation</span>
        <span className="text-t13 text-navy-200">Crown lab</span>
      </header>
      <div className="relative z-10 mx-auto w-[min(980px,calc(100%-32px))] pt-[clamp(20px,4vh,48px)] text-center">
        <h1 className="text-[clamp(34px,4.4vw,64px)] leading-[1.03]">The other side of every trade, stress-tested first.</h1>
        <p className="mx-auto mt-s4 max-w-[62ch] text-t15 text-navy-200 md:text-t17">
          Portfolio margin for Robinhood Chain stock-token options, computed on-chain. Every trade re-prices the whole book across 39 scenarios
          before it settles in USDG.
        </p>
        <div className="mt-s5 flex flex-col items-center gap-s3">
          <a
            href="#panel"
            className="inline-flex h-12 items-center rounded-control bg-navy-50 px-s5 text-t15 font-semibold text-navy-900 hover:bg-white"
          >
            Open the app
          </a>
          <p className="text-t13 text-navy-200">Stock tokens are not available to US persons.</p>
        </div>
      </div>
      <div className="relative z-0 mx-auto mt-s4 w-[min(1280px,calc(100%-32px))] flex-1 pb-s4">{children}</div>
    </section>
  );
}

function PanelMock({
  children,
  equity,
  im,
  session,
  grid,
}: {
  children: React.ReactNode;
  equity: number;
  im: number;
  session: LabSession;
  grid: ScenarioGrid;
}) {
  const w = worstNode(grid.cells);
  return (
    <section id="panel" className="mx-auto w-[min(1280px,calc(100%-32px))] py-s8">
      <h2 className="text-display-4">Portfolio</h2>
      <div className="mt-s5 grid gap-s5 lg:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)]">
        <div className="flex h-[560px] flex-col rounded-control border border-navy-700 bg-navy-950/60 p-s5">
          <div className="mb-s3 flex items-baseline justify-between">
            <h3 className="font-text text-t17 font-semibold tracking-normal">Scenario crown</h3>
            <span className="text-t13 text-navy-200">Account 7, {SESSION_LABEL[session]}</span>
          </div>
          <div className="min-h-0 flex-1">{children}</div>
        </div>
        <dl className="grid content-start gap-s5 rounded-control border border-navy-700 p-s5">
          <div>
            <dt className="text-t13 text-navy-200">Equity</dt>
            <dd className="text-[28px] font-semibold">{fmtNumber(equity)} USDG</dd>
          </div>
          <div>
            <dt className="text-t13 text-navy-200">Initial margin</dt>
            <dd className="text-[28px] font-semibold">{fmtNumber(im)} USDG</dd>
          </div>
          <div>
            <dt className="text-t13 text-navy-200">Worst scenario</dt>
            <dd className="text-t15">{describeNode(w.index, w.pnl)}</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

/** A tight, transparent frame at the rest pose. scripts/render-poster.ts screenshots it. */
function PosterFrame({ grid, im, scale }: { grid: ScenarioGrid; im: number; scale: CrownScale }) {
  const width = 800;
  const height = Math.round(width / naturalAspect(crownBounds(scale)));
  const rigRef = useRef<CrownRig | null>(null);
  if (rigRef.current === null) rigRef.current = CrownRig.seeded(grid.cells, im, scale);
  const [ready, setReady] = useState(false);
  return (
    <>
      <style>{'html,body{background:transparent!important}'}</style>
      <div data-poster-frame="" data-crown-ready={ready} data-width={width} data-height={height} style={{ position: 'relative', width, height }}>
        <CrownScene rigRef={rigRef} still onReady={() => window.setTimeout(() => setReady(true), 400)} />
      </div>
    </>
  );
}
