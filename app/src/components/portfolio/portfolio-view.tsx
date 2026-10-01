'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { accountLabel, useAccountId } from '@/components/app/account-context';
import { Page, SectionHead } from '@/components/app/section-head';
import { discountAt } from '@/components/charts/discount-ramp';
import { Crown, crownScale } from '@/components/crown';
import { DataTable, type Column } from '@/components/ui/data-table';
import { Lamp } from '@/components/ui/lamp';
import { Meter } from '@/components/ui/meter';
import { Panel } from '@/components/ui/panel';
import { Skeleton } from '@/components/ui/skeleton';
import { useAsOf, useAuctions, useExpiries, usePools, useScenarioGrid, useSubaccount, useUnderlyings } from '@/lib/client/hooks';
import type { AccountState, Position, ScenarioGrid, Series, Session } from '@/lib/client/types';
import { cn } from '@/lib/cn';
import { SESSION_LABEL, fmtDays, fmtExpiry, fmtNumber, fmtPct, fmtQty, fmtSeries, fmtSigned } from '@/lib/format';
import { describeNode } from '@/components/crown/crownMath';
import { worstCell } from '@/lib/scenario';
import { SESSION_MULT } from '@/lib/kernel';
import { fmtEt } from '@/lib/nyse';
import { ScenarioStrip } from '@/components/charts/scenario-strip';
import { ExpiryTimeline } from './expiry-timeline';

type Held = Position & Series;
const SESSIONS: readonly Session[] = ['REGULAR', 'WEEKEND'];

/** Liquidation risk: inside 20% of initial margin, or below maintenance. */
function riskLevel(s: AccountState): 'none' | 'near' | 'restricted' | 'liquidatable' {
  if (s.liquidatable) return 'liquidatable';
  if (!s.healthy) return 'restricted';
  if (s.equity < s.im * 1.2) return 'near';
  return 'none';
}

function RiskCallout({ id, state, asOf }: { id: number; state: AccountState; asOf?: number }) {
  const auctions = useAuctions();
  const level = riskLevel(state);
  if (level === 'none') return null;
  const auction = auctions.data?.find((a) => a.account === id && a.status === 'active');
  const elapsed = auction && asOf !== undefined ? asOf - auction.startedAt : undefined;
  const title =
    level === 'liquidatable'
      ? 'Below maintenance margin: this account can be liquidated.'
      : level === 'restricted'
        ? 'Below initial margin: opening trades are refused.'
        : 'Within 20% of initial margin.';
  return (
    <section
      aria-labelledby="risk-callout"
      data-level={level}
      className={cn('grid gap-s3 rounded-control border px-s5 py-s4 max-sm:px-s4', level === 'near' ? 'border-loss-1/50 bg-loss-1/5' : 'border-loss-3/50 bg-loss-3/8')}
    >
      <h2 id="risk-callout" className="flex items-center gap-s3 text-[22px] leading-tight font-normal text-navy-50">
        <Lamp tone={level === 'near' ? 'loss-1' : 'loss-3'} size={10} />
        {title}
      </h2>
      <p className="max-w-[80ch] text-t15 text-pretty text-navy-200">
        Equity <span className="tabular-nums text-navy-50">{fmtNumber(state.equity)}</span> against initial margin{' '}
        <span className="tabular-nums text-navy-50">{fmtNumber(state.im)}</span> and maintenance{' '}
        <span className="tabular-nums text-navy-50">{fmtNumber(state.mm)}</span> USDG.{' '}
        {level === 'liquidatable'
          ? `It is ${fmtNumber(state.mm - state.equity)} short of maintenance and ${fmtNumber(state.im - state.equity)} short of initial margin.`
          : level === 'restricted'
            ? `Deposit ${fmtNumber(state.im - state.equity)} USDG or close risk to trade again.`
            : `A ${fmtPct(1 - state.im / state.equity, 0)} fall in equity puts it under initial margin.`}
      </p>
      {auction && elapsed !== undefined && (
        <p className="text-t15 text-pretty text-navy-50">
          A Dutch auction started {fmtEt(auction.startedAt)}. Bidders now take it at{' '}
          <span className="tabular-nums">{fmtPct(discountAt(elapsed, auction), 2)}</span> off, rising to{' '}
          {fmtPct(auction.maxDiscount, 0)} at {fmtEt(auction.startedAt + auction.duration)}; it pauses while{' '}
          {auction.underlyings.join(' or ')} is halted or in a weekend session.{' '}
          <Link href="/app/risk#auctions" className="rounded-[2px] underline decoration-navy-400 underline-offset-4 ui-hover:decoration-cyan">
            See the auction
          </Link>
        </p>
      )}
      {level !== 'near' && (
        <p className="text-t13 text-navy-200">Deposits and trades that reduce risk still clear. The auction ends once equity is back above initial margin.</p>
      )}
    </section>
  );
}

const positionColumns = (asOf?: number): Column<Held>[] => [
  {
    key: 'series',
    header: 'Series',
    cell: (p) => <span className="font-medium">{fmtSeries(p)}</span>,
  },
  {
    key: 'expiry',
    header: 'Expires',
    cell: (p) => (
      <span className="text-navy-200">
        {fmtExpiry(p.expiry)}
        {asOf !== undefined ? `, ${fmtDays(p.expiry, asOf)}` : ''}
      </span>
    ),
  },
  { key: 'qty', header: 'Qty', numeric: true, cell: (p) => fmtSigned(p.qty, 0) },
  { key: 'mark', header: 'Kernel mark', numeric: true, cell: (p) => fmtNumber(p.mark) },
  { key: 'value', header: 'Value', numeric: true, cell: (p) => fmtSigned(p.qty * p.mark) },
];

export function PortfolioView() {
  const { id } = useAccountId();
  const account = useSubaccount(id);
  const { data: asOf } = useAsOf();
  const underlyings = useUnderlyings();
  const regular = useScenarioGrid(id, 'REGULAR');
  const weekend = useScenarioGrid(id, 'WEEKEND');
  const expiries = useExpiries(id);
  const pools = usePools();
  const [session, setSession] = useState<Session>('REGULAR');

  const grids: Partial<Record<Session, ScenarioGrid>> = { REGULAR: regular.data, WEEKEND: weekend.data };
  const grid = session === 'WEEKEND' ? grids.WEEKEND : grids.REGULAR;
  const scale = useMemo(
    () => (regular.data && weekend.data ? crownScale([regular.data.cells, weekend.data.cells], [regular.data.im, weekend.data.im]) : undefined),
    [regular.data, weekend.data],
  );

  const s = account.data?.state;
  const positions = useMemo(
    () => [...(account.data?.positions ?? [])].sort((a, b) => a.expiry - b.expiry || a.underlying.localeCompare(b.underlying) || a.strike - b.strike),
    [account.data],
  );
  const spot = (sym: string) => underlyings.data?.find((u) => u.symbol === sym)?.spot ?? 0;
  const collateral = Object.entries(account.data?.collateral ?? {});
  const tokenValue = collateral.reduce((a, [sym, q]) => a + q * spot(sym), 0);
  const optionValue = positions.reduce((a, p) => a + p.qty * p.mark, 0);

  const sessionIm = grid?.im;
  const imNow = regular.data?.im ?? s?.im;
  const worst = grid ? worstCell(grid.cells) : undefined;

  return (
    <Page>
      {/* hero: the account and its scenario crown */}
      <section aria-labelledby="portfolio-hero" className="grid gap-s5">
        <div className="flex flex-wrap items-end justify-between gap-x-s6 gap-y-s3">
          <div className="grid gap-s1">
            <p className="text-t13 text-navy-200">
              Account #{id}, {accountLabel(id)}
            </p>
            <h2 id="portfolio-hero" className="flex items-baseline gap-s3 text-[48px] leading-none font-normal text-navy-50 max-sm:text-[36px]">
              {s ? <span className="tabular-nums">{fmtNumber(s.equity)}</span> : <Skeleton className="h-11 w-64" />}
              <span className="font-text text-t17 tracking-normal text-navy-200">USDG equity</span>
            </h2>
          </div>
          {s && (
            <dl className="flex flex-wrap gap-x-s6 gap-y-s2 text-t13">
              {[
                { k: 'Initial margin', v: fmtNumber(s.im) },
                { k: 'Maintenance', v: fmtNumber(s.mm) },
                { k: 'Free to trade', v: fmtNumber(Math.max(0, s.equity - s.im)) },
                { k: 'Margin used', v: fmtPct(s.equity > 0 ? s.im / s.equity : 1) },
              ].map((x) => (
                <div key={x.k} className="grid gap-0.5">
                  <dt className="text-t12 text-navy-200">{x.k}</dt>
                  <dd className="text-t17 font-semibold tabular-nums text-navy-50">{x.v}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>

        {s && <RiskCallout id={id} state={s} asOf={asOf} />}

        <div className="grid gap-s5 lg:grid-cols-[minmax(0,1.75fr)_minmax(300px,1fr)]">
          <Panel
            title="Scenario crown"
            meta={<span className="tabular-nums">39 kernel scenarios, {SESSION_LABEL[session].toLowerCase()} shocks</span>}
            className="min-w-0"
          >
            <div className="relative overflow-hidden sm:h-[460px] lg:h-[520px]" data-testid="portfolio-crown">
              {grid && scale && sessionIm !== undefined ? (
                <Crown
                  variant="panel"
                  grid={grid}
                  im={sessionIm}
                  session={session}
                  sessions={SESSIONS}
                  onSessionChange={setSession}
                  scale={scale}
                  poster={id === 7}
                  labels={{ im: `Initial margin, ${SESSION_LABEL[session].toLowerCase()}` }}
                />
              ) : (
                <Skeleton className="h-full w-full" />
              )}
            </div>
          </Panel>

          <Panel title="Margin" meta={<span>{SESSION_LABEL[session]} shocks</span>}>
            {s && sessionIm !== undefined && imNow !== undefined ? (
              <div className="grid gap-s5">
                <Meter
                  label={`Equity against margin under ${SESSION_LABEL[session].toLowerCase()} shocks`}
                  value={s.equity}
                  im={sessionIm}
                  mm={sessionIm * (s.im > 0 ? s.mm / s.im : 0.75)}
                />
                <table className="w-full border-separate border-spacing-0 text-t13 tabular-nums">
                  <caption className="sr-only">Initial margin by session, in USDG</caption>
                  <tbody>
                    {SESSIONS.map((x) => {
                      const g = grids[x];
                      if (!g) return null;
                      const on = x === session;
                      return (
                        <tr key={x} data-row={`im-${x.toLowerCase()}`} aria-current={on || undefined}>
                          <th scope="row" className={cn('h-8 border-t border-navy-800 pr-s3 text-left font-normal', on ? 'text-navy-50' : 'text-navy-200')}>
                            <span className="inline-flex items-center gap-s2">
                              <span aria-hidden="true" className={cn('inline-block h-3 w-0.5 rounded-full', on ? 'bg-cyan' : 'bg-navy-600')} />
                              Initial margin, {SESSION_LABEL[x].toLowerCase()} shocks ({SESSION_MULT[x]}×)
                            </span>
                          </th>
                          <td className={cn('border-t border-navy-800 text-right', on ? 'font-semibold text-navy-50' : 'text-navy-200')}>{fmtNumber(g.im)}</td>
                        </tr>
                      );
                    })}
                    {regular.data && weekend.data && (
                      <tr data-row="weekend-adds">
                        <th scope="row" className="h-8 border-t border-navy-800 pr-s3 text-left font-normal text-navy-200">
                          The weekend gap adds
                        </th>
                        <td className="border-t border-navy-800 text-right text-loss-1">{fmtSigned(weekend.data.im - regular.data.im)}</td>
                      </tr>
                    )}
                    <tr data-row="free">
                      <th scope="row" className="h-8 border-t border-navy-800 pr-s3 text-left font-normal text-navy-200">
                        Free to trade at {SESSION_LABEL[session].toLowerCase()} shocks
                      </th>
                      <td className="border-t border-navy-800 text-right font-medium text-navy-50">{fmtNumber(Math.max(0, s.equity - sessionIm))}</td>
                    </tr>
                  </tbody>
                </table>
                {/* its screen-reader table is absolutely placed; keep it inside the panel */}
                <div className="relative min-w-0 overflow-hidden">
                  <ScenarioStrip
                    grids={[{ name: SESSION_LABEL[session], cells: grid!.cells }]}
                    range={(() => {
                      const k = Object.keys(grid!.shockRange)[0];
                      return k ? { symbol: k, value: grid!.shockRange[k]! } : undefined;
                    })()}
                  />
                </div>
                {worst && (
                  <p className="text-t13 text-pretty text-navy-200">
                    Worst of the 39: <span className="tabular-nums text-navy-50">{describeNode(worst.index, worst.pnl)}</span>.{' '}
                    {session === 'WEEKEND'
                      ? 'Weekend shocks are 1.75× wider: no Chainlink round prints from Friday afternoon to the Sunday 20:00 ET reopen, so the margin has to cover the gap.'
                      : 'Initial margin is that loss plus 1% of spot on every short option.'}
                  </p>
                )}
              </div>
            ) : (
              <Skeleton className="h-48 w-full" />
            )}
          </Panel>
        </div>
      </section>

      <section aria-labelledby="positions" className="grid gap-s5">
        <SectionHead
          id="positions"
          title="Positions and collateral"
          dek="Every option at the kernel's mark, and what backs it. Equity is cash plus these marks."
        />
        <div className="grid gap-s5 lg:grid-cols-[minmax(0,1.75fr)_minmax(300px,1fr)]">
          <Panel title="Options" padding="none" meta={<span className="tabular-nums">{positions.length} series</span>}>
            <DataTable
              caption={`Account ${id} positions`}
              columns={positionColumns(asOf)}
              rows={positions}
              rowKey={(p) => String(p.seriesId)}
              maxHeight={positions.length > 10 ? 420 : undefined}
              loading={account.isPending}
              empty={`No open options on account ${id}.`}
            />
          </Panel>
          <Panel title="Collateral and equity">
            {s ? (
              <dl className="grid text-t13 tabular-nums">
                {collateral.map(([sym, q]) => (
                  <div key={sym} className="flex items-baseline justify-between gap-s3 border-b border-navy-800 py-s2">
                    <dt className="text-navy-200">
                      {fmtQty(q)} {sym} tokens at {fmtNumber(spot(sym))}
                    </dt>
                    <dd className="text-navy-50">{fmtNumber(q * spot(sym))}</dd>
                  </div>
                ))}
                {[
                  { k: 'Option marks', v: fmtSigned(optionValue) },
                  { k: 'Cash', v: fmtNumber(s.cash) },
                  { k: 'Unsettled value and unpaid claims', v: fmtNumber(s.settledValue) },
                  { k: 'Deficit owed to insurance', v: s.deficit > 0 ? `−${fmtNumber(s.deficit)}` : '0.00' },
                ].map((r) => (
                  <div key={r.k} className="flex items-baseline justify-between gap-s3 border-b border-navy-800 py-s2">
                    <dt className="text-navy-200">{r.k}</dt>
                    <dd className="text-navy-50">{r.v}</dd>
                  </div>
                ))}
                <div className="flex items-baseline justify-between gap-s3 pt-s3">
                  <dt className="font-medium text-navy-50">Equity</dt>
                  <dd className="text-t17 font-semibold text-navy-50">{fmtNumber(s.equity)}</dd>
                </div>
                {Math.abs(tokenValue + optionValue - s.mtm) > 0.05 && (
                  <p className="pt-s2 text-t12 text-navy-200">Marks shown at today&apos;s spot; equity uses the kernel&apos;s.</p>
                )}
              </dl>
            ) : (
              <Skeleton className="h-40 w-full" />
            )}
          </Panel>
        </div>
      </section>

      <section aria-labelledby="expiries" className="grid gap-s5">
        <SectionHead
          id="expiries"
          title="Expiries"
          dek="Each weekly expiry settles on the last Chainlink print at or before Friday 16:00 ET. Payers pay into the expiry's pool; receivers get a claim that counts in equity, paid once every short of that expiry has settled and nothing is pending."
        />
        <ExpiryTimeline items={expiries.data} pools={pools.data} loading={expiries.isPending} />
      </section>
    </Page>
  );
}
