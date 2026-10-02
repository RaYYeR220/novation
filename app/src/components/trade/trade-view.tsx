'use client';

import { useMemo, useRef, useState } from 'react';
import { useAccountId } from '@/components/app/account-context';
import { PayoffChart } from '@/components/charts/payoff-chart';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { DataTable, type Column } from '@/components/ui/data-table';
import { Panel } from '@/components/ui/panel';
import { Segment, SegmentedControl } from '@/components/ui/segmented-control';
import { Tab, TabList, TabPanel, Tabs } from '@/components/ui/tabs';
import {
  useAgents,
  useAsOf,
  useChain,
  useIsDemo,
  useScenarioGrid,
  useSubaccount,
  useUnderlyings,
  useVaults,
  useWhatIf,
  type WhatIfArgs,
} from '@/lib/client/hooks';
import type { Position, Series, Underlying } from '@/lib/client/types';
import { DEMO_TICKET } from '@/lib/demo';
import { fmtDays, fmtExpiry, fmtNumber, fmtPct, fmtSeriesShort, fmtShock, fmtSigned } from '@/lib/format';
import { shockRange } from '@/lib/kernel';
import type { PayoffBook, PayoffLeg } from '@/lib/payoff';
import { useDebounced } from '@/lib/use-media';
import { OptionsChain, type ChainSeries, type Side } from './options-chain';
import { OWNER, Ticket, type Venue } from './ticket';
import { TicketDock } from './ticket-dock';

type Held = Position & Series;

function MarketStrip({ u }: { u: Underlying }) {
  const items = [
    { k: 'Spot', v: fmtNumber(u.spot) },
    { k: 'Mark vol', v: fmtPct(u.markVol) },
    { k: 'Kernel shock', v: `±${fmtPct(shockRange(u.markVol, u.session))}` },
  ];
  return (
    <dl className="grid grid-cols-4 items-end gap-x-s3 gap-y-s3 sm:flex sm:flex-wrap sm:gap-x-s6">
      <div className="col-span-4 grid gap-0.5">
        <dt className="sr-only">Underlying</dt>
        <dd className="font-display text-[28px] leading-none text-navy-50">{u.name}</dd>
      </div>
      {items.map((i) => (
        <div key={i.k} className="grid gap-0.5">
          <dt className="text-t12 text-navy-200">{i.k}</dt>
          <dd className="text-t17 leading-tight font-semibold tabular-nums text-navy-50 max-sm:text-t15">{i.v}</dd>
        </div>
      ))}
      <div className="grid gap-1">
        <dt className="text-t12 text-navy-200">Session</dt>
        <dd>
          <Chip session={u.session} size="sm" />
        </dd>
      </div>
    </dl>
  );
}

const positionColumns = (asOf?: number): Column<Held>[] => [
  {
    key: 'series',
    header: 'Series',
    cell: (p) => (
      <span className="font-medium">
        {fmtSeriesShort(p)} <span className="font-normal text-navy-200">{fmtExpiry(p.expiry)}{asOf !== undefined ? `, ${fmtDays(p.expiry, asOf)}` : ''}</span>
      </span>
    ),
  },
  { key: 'qty', header: 'Qty', numeric: true, cell: (p) => fmtSigned(p.qty, 0) },
  { key: 'mark', header: 'Mark', numeric: true, cell: (p) => fmtNumber(p.mark) },
  { key: 'value', header: 'Value', numeric: true, cell: (p) => fmtSigned(p.qty * p.mark) },
];

function bookFor(u: Underlying, positions: Held[], collateral: Record<string, number>): PayoffBook {
  return {
    spot: u.spot,
    vol: u.markVol,
    tokenQty: collateral[u.symbol] ?? 0,
    legs: positions
      .filter((p) => p.underlying === u.symbol)
      .map((p) => ({ strike: p.strike, isCall: p.isCall, expiry: p.expiry, qty: p.qty, cost: p.mark })),
  };
}

function parseQty(raw: string): { value: number; error?: string } {
  const t = raw.replace(/,/g, '').trim();
  if (t === '') return { value: 0, error: 'Enter a quantity.' };
  const v = Number(t);
  if (!Number.isFinite(v)) return { value: 0, error: 'Numbers only.' };
  if (v <= 0) return { value: 0, error: 'Quantity must be above zero.' };
  if (v > 100000) return { value: 0, error: 'Up to 100,000 contracts per ticket.' };
  return { value: v };
}

/**
 * Trade: underlying tabs, an expiry switch, the chain, the payoff and the account's positions on the
 * left; the ticket on the right (a bottom sheet on phones). Every ticket runs the kernel's what-if
 * before anything can be signed.
 */
export function TradeView() {
  const { id: accountId, setId: setAccountId } = useAccountId();
  const demo = useIsDemo();
  const underlyings = useUnderlyings();
  const { data: asOf } = useAsOf();
  const account = useSubaccount(accountId);
  const grid = useScenarioGrid(accountId);
  const vaults = useVaults();
  const agents = useAgents(accountId);

  const [symbol, setSymbol] = useState('NVDA');
  const chain = useChain(symbol);
  const [expiryPick, setExpiry] = useState<number | undefined>(undefined);
  const [pick, setPick] = useState<number | null>(null);
  const [side, setSide] = useState<Side>('buy');
  const [qty, setQty] = useState('1');
  const [venuePick, setVenue] = useState<Venue>('vault');
  const [signerPick, setSigner] = useState<string>(OWNER);
  const [sheet, setSheet] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  const u = underlyings.data?.find((x) => x.symbol === symbol);
  const expiries = chain.data?.expiries ?? [];
  const expiry = expiryPick !== undefined && expiries.includes(expiryPick) ? expiryPick : expiries[0];
  const allSeries = chain.data?.series;
  const listed = useMemo(() => (allSeries ?? []).filter((s) => s.expiry === expiry), [allSeries, expiry]);
  const series = allSeries?.find((s) => s.id === pick);
  // Only a grant that hasn't expired can sign; an expired one reverts NotAuthorized.
  const grants = (agents.data ?? []).filter((g) => asOf === undefined || g.expiresAt > asOf);
  const grant = grants.find((g) => g.agent === signerPick);
  // An agent can only sign on the underlyings its grant allows; otherwise the owner signs.
  const signer = grant && series && !grant.allowed.includes(series.underlying) ? OWNER : grant ? signerPick : OWNER;
  const vault = series
    ? vaults.data?.find((v) => v.live && v.underlying === series.underlying && v.kind === (series.isCall ? 'coveredCall' : 'putWrite'))
    : undefined;
  // a side nobody quotes (live: the vault doesn't sell or buy back this series) falls back to RFQ
  const sideQuote = series ? (side === 'buy' ? series.ask : series.bid) : undefined;
  const venue: Venue = venuePick === 'vault' && (!vault || (sideQuote !== undefined && !Number.isFinite(sideQuote))) ? 'rfq' : venuePick;
  const mid = series ? (series.bid + series.ask) / 2 : undefined;
  const price = series ? (venue === 'vault' ? sideQuote : mid !== undefined && Number.isFinite(mid) ? mid : series.mark) : undefined;

  const parsed = parseQty(qty);
  const settledQty = useDebounced(parsed.value, 180);
  const args: WhatIfArgs | null =
    series && accountId > 0 && price !== undefined && Number.isFinite(price) && !parsed.error && settledQty > 0
      ? {
          id: accountId,
          seriesId: series.id,
          qtyDelta: side === 'buy' ? settledQty : -settledQty,
          premium: Math.round(price * settledQty * 1e6) / 1e6,
          venue,
          ...(signer !== OWNER ? { agent: signer } : {}),
        }
      : null;
  const whatIf = useWhatIf(args);
  const quote = args ? whatIf.data : undefined;
  const pending = Boolean(args) && (whatIf.isFetching || whatIf.isPlaceholderData || settledQty !== parsed.value);

  const held = useMemo(
    () => new Map((account.data?.positions ?? []).map((p) => [p.seriesId, p.qty] as const)),
    [account.data],
  );
  const heldHere = useMemo(
    () =>
      (account.data?.positions ?? [])
        .filter((p) => p.underlying === symbol)
        .sort((a, b) => a.expiry - b.expiry || a.strike - b.strike || Number(b.isCall) - Number(a.isCall)),
    [account.data, symbol],
  );

  const openTicket = (s: ChainSeries, nextSide?: Side) => {
    setPick(s.id);
    if (nextSide) setSide(nextSide);
    setSheet(true);
    // On phones the sheet takes focus so the ticket reads from its title.
    requestAnimationFrame(() => {
      if (window.matchMedia('(max-width: 899px)').matches) heading.current?.focus();
    });
  };
  const onStrike = (strike: number) => {
    const isCall = series ? series.isCall : true;
    const s = listed.find((x) => x.strike === strike && x.isCall === isCall);
    if (s) openTicket(s);
  };
  const onType = (isCall: boolean) => {
    if (!series) return;
    const s = allSeries?.find((x) => x.strike === series.strike && x.expiry === series.expiry && x.isCall === isCall);
    if (s) setPick(s.id);
  };
  const switchUnderlying = (next: string) => {
    setSymbol(next);
    setExpiry(undefined);
    setPick(null);
  };
  const loadDemo = () => {
    const s = DEMO_TICKET;
    setAccountId(s.accountId);
    setSymbol(s.underlying);
    setExpiry(undefined);
    setPick(s.seriesId);
    setSide(s.side);
    setQty(String(s.qty));
    setVenue('rfq');
    if (s.agent) setSigner(s.agent);
    setSheet(true);
  };

  const now = account.data?.state;
  const nowBook = u && account.data ? bookFor(u, account.data.positions, account.data.collateral) : undefined;
  const ticketBook: PayoffBook | undefined =
    u && series && quote && args
      ? {
          spot: u.spot,
          vol: u.markVol,
          tokenQty: 0,
          fee: quote.fee,
          legs: [
            {
              strike: series.strike,
              isCall: series.isCall,
              expiry: series.expiry,
              qty: args.qtyDelta,
              cost: quote.premium / Math.abs(args.qtyDelta),
            } satisfies PayoffLeg,
          ],
        }
      : undefined;
  const afterBook = nowBook && ticketBook ? { ...nowBook, fee: ticketBook.fee, legs: [...nowBook.legs, ...ticketBook.legs] } : undefined;
  const shock = u ? shockRange(u.markVol, u.session) : 0.1;

  const summary = series ? (
    <span className="grid gap-0.5">
      <span className="text-t15 font-medium text-navy-50">
        {side === 'buy' ? 'Buy' : 'Sell'} {qty} {series.underlying} {fmtSeriesShort(series)}
      </span>
      <span className="text-t12 tabular-nums text-navy-200">
        {quote?.refusal ? (
          <span className="text-loss-1">Refused: {quote.refusal.code}</span>
        ) : quote && now ? (
          <>
            Initial margin {fmtNumber(now.im)} to {fmtNumber(quote.after.im)}
          </>
        ) : (
          'Checking margin'
        )}
      </span>
    </span>
  ) : null;

  const tabs = underlyings.data ?? [];

  return (
    <div className={series ? 'max-[899px]:pb-24' : undefined}>
      <Tabs value={symbol} onValueChange={switchUnderlying}>
        <div className="border-b border-navy-700 px-s4 sm:px-s5 xl:px-s6">
          <TabList aria-label="Underlying" className="border-b-0">
            {tabs.map((t) => (
              <Tab key={t.symbol} value={t.symbol} className="gap-s2">
                {t.symbol}
                <span className="hidden text-t13 font-normal tabular-nums text-navy-200 sm:inline">{fmtNumber(t.spot)}</span>
              </Tab>
            ))}
          </TabList>
        </div>

        <div className="grid gap-s5 px-s4 py-s5 sm:px-s5 min-[900px]:grid-cols-[minmax(0,1fr)_minmax(348px,420px)] xl:px-s6">
          <div className="min-w-0">
            {tabs.map((t) => (
              <TabPanel key={t.symbol} value={t.symbol} className="grid gap-s5 pt-0">
                <div className="flex flex-wrap items-end justify-between gap-s4">
                  <MarketStrip u={t} />
                  {demo && DEMO_TICKET.agent && (
                    <Button size="sm" variant="secondary" onClick={loadDemo}>
                      Load the refused agent ticket
                    </Button>
                  )}
                </div>

                <Panel
                  title={`${t.symbol} options`}
                  padding="none"
                  meta={
                    expiries.length > 0 && (
                      <SegmentedControl
                        legend="Expiry"
                        size="sm"
                        value={expiry !== undefined ? String(expiry) : undefined}
                        onValueChange={(v) => {
                          setExpiry(Number(v));
                          setPick(null);
                        }}
                      >
                        {expiries.map((e) => (
                          <Segment key={e} value={String(e)}>
                            <span className="tabular-nums">
                              {fmtExpiry(e)}
                              {asOf !== undefined && (
                                <span className="font-normal text-navy-200 max-sm:sr-only"> {fmtDays(e, asOf)}</span>
                              )}
                            </span>
                          </Segment>
                        ))}
                      </SegmentedControl>
                    )
                  }
                >
                  <div className="p-s3 max-sm:px-0">
                    <OptionsChain
                      symbol={t.symbol}
                      spot={t.spot}
                      series={listed}
                      held={held}
                      selected={series ? { seriesId: series.id, side } : undefined}
                      onPick={openTicket}
                      onStrike={onStrike}
                      loading={chain.isPending}
                      error={chain.isError ? 'The chain could not be read. Retrying on the next block.' : undefined}
                    />
                  </div>
                </Panel>

                {nowBook && expiry !== undefined && (
                  <Panel
                    title="Payoff at expiry"
                    meta={
                      <span className="tabular-nums">
                        {t.symbol}, {fmtExpiry(expiry)}
                      </span>
                    }
                  >
                    <PayoffChart
                      symbol={t.symbol}
                      spot={t.spot}
                      horizon={expiry}
                      shock={shock}
                      now={nowBook}
                      after={series?.underlying === t.symbol ? afterBook : undefined}
                      ticket={series?.underlying === t.symbol ? ticketBook : undefined}
                      strike={series?.underlying === t.symbol ? series.strike : undefined}
                    />
                  </Panel>
                )}

                <Panel
                  title={`Account ${accountId} on ${t.symbol}`}
                  padding="none"
                  meta={
                    account.data && (
                      <span className="tabular-nums">
                        {fmtNumber(account.data.collateral[t.symbol] ?? 0, 0)} {t.symbol} tokens as collateral
                      </span>
                    )
                  }
                >
                  <DataTable
                    caption={`Account ${accountId} positions on ${t.symbol}`}
                    columns={positionColumns(asOf)}
                    rows={heldHere}
                    rowKey={(p) => String(p.seriesId)}
                    maxHeight={heldHere.length > 8 ? 360 : undefined}
                    loading={account.isPending && accountId > 0}
                    empty={
                      accountId > 0
                        ? `No ${t.symbol} options on account ${accountId}. A ticket here opens the first.`
                        : 'No subaccount selected. Create one or open one by number from the account menu in the top bar.'
                    }
                  />
                </Panel>
              </TabPanel>
            ))}
          </div>

          {u && (
            <TicketDock active={Boolean(series)} expanded={sheet} onExpandedChange={setSheet} summary={summary}>
              <Ticket
                demo={demo}
                accountId={accountId}
                underlying={u}
                asOf={asOf}
                series={series?.underlying === u.symbol ? series : undefined}
                side={side}
                qty={qty}
                qtyError={parsed.error}
                venue={venue}
                signer={signer}
                onSide={setSide}
                onQty={setQty}
                onVenue={setVenue}
                onSigner={setSigner}
                onType={onType}
                onClear={() => {
                  setPick(null);
                  setSheet(false);
                }}
                vault={vault}
                grants={grants}
                price={price}
                now={now}
                nowGrid={grid.data?.cells}
                quote={quote}
                args={args}
                pending={pending}
                quoteError={whatIf.isError ? `The what-if failed: ${(whatIf.error as Error).message}` : undefined}
                shock={shock}
                onDemoTicket={demo && DEMO_TICKET.agent ? loadDemo : undefined}
                headingRef={heading}
              />
            </TicketDock>
          )}
        </div>
      </Tabs>
    </div>
  );
}
