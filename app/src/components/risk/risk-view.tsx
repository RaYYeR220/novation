'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Page, SectionHead } from '@/components/app/section-head';
import { DiscountRamp, discountAt } from '@/components/charts/discount-ramp';
import { Chip } from '@/components/ui/chip';
import { Lamp } from '@/components/ui/lamp';
import { Panel } from '@/components/ui/panel';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useAgents,
  useAsOf,
  useAuctions,
  useFeeds,
  useInsurance,
  useIsDemo,
  useOpenInterest,
  usePools,
  useProtocol,
  useRefusals,
} from '@/lib/client/hooks';
import type { Auction, ExpiryPool, FeedStatus, HaltEpisode } from '@/lib/client/types';
import { cn } from '@/lib/cn';
import { fmtDuration, fmtExpiry, fmtNumber, fmtPct, fmtQty } from '@/lib/format';
import { fmtCloseEt, fmtEt } from '@/lib/nyse';
import { RefusalFeed } from './refusal-feed';
import { LIVE_CHAIN } from '@/lib/client/chain';

const d = (h: HaltEpisode) => h.detail as Record<string, number>;

function haltText(h: HaltEpisode, f: FeedStatus): ReactNode {
  if (h.reason === 'implausible')
    return (
      <>
        Implausible print: the feed answered up to <span className="tabular-nums text-navy-50">{fmtNumber(d(h).price ?? 0, 0)}</span>, outside its{' '}
        {fmtNumber(f.band[0], 0)} to {fmtNumber(f.band[1], 0)} band, across rounds {d(h).firstRound} to {d(h).lastRound}.
      </>
    );
  if (h.reason === 'multiplier')
    return (
      <>
        Corporate action: the token&apos;s multiplier changed at {fmtEt(d(h).effectiveAt ?? 0)} (dividend reinvested). The hub halts from 24 h before until 1 h
        after.
      </>
    );
  if (h.reason === 'stale')
    return (
      <>
        Stale feed: the last print ({fmtEt(d(h).lastAt ?? 0)}) was older than the {fmtDuration(d(h).limit ?? 0)} limit when the{' '}
        {String(h.detail.session).toLowerCase()} session opened; it cleared with the next round.
      </>
    );
  return h.reason;
}

function SessionRow({ f, demo }: { f: FeedStatus; demo: boolean }) {
  const stale = f.halts.filter((h) => h.reason === 'stale');
  const other = f.halts.filter((h) => h.reason !== 'stale');
  const checks = [
    { ok: f.spot >= f.band[0] && f.spot <= f.band[1], text: `Price ${fmtNumber(f.spot)} inside its ${fmtNumber(f.band[0], 0)} to ${fmtNumber(f.band[1], 0)} band` },
    {
      ok: true,
      text: `Fresh: at most ${fmtDuration(f.staleLimits.REGULAR)} old in the regular and extended sessions, ${fmtDuration(f.staleLimits.CLOSED)} when closed`,
    },
    { ok: !f.oraclePaused && !f.paused, text: `Token not paused; oraclePaused false (read ${fmtExpiry(f.historyTo)})` },
    {
      ok: demo || f.session !== 'HALTED',
      text: !demo
        ? `Multiplier ${fmtNumber(f.uiMultiplier, 6)}, read from the token${f.session === 'HALTED' ? '' : '; no change inside the halt window'}`
        : f.lastMultiplierChange
          ? `Multiplier ${fmtNumber(f.uiMultiplier, 6)}, last changed ${fmtEt(f.lastMultiplierChange)}; none scheduled`
          : `Multiplier ${fmtNumber(f.uiMultiplier, 6)}, never changed; none scheduled`,
    },
  ];
  return (
    <li data-symbol={f.symbol} className="grid gap-s4 border-b border-navy-800 py-s5 lg:grid-cols-[180px_minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-s6">
      <div className="grid content-start gap-s2">
        <h3 className="flex items-baseline gap-s2 text-[24px] leading-none font-normal text-navy-50">
          {f.symbol}
          <span className="font-text text-t15 tracking-normal tabular-nums text-navy-200">{fmtNumber(f.spot)}</span>
        </h3>
        <Chip session={f.session} size="sm" className="justify-self-start" />
        <p className="text-t12 text-navy-200">
          {f.description}, {f.rounds.toLocaleString('en-US')} rounds
        </p>
      </div>
      <ul className="grid content-start gap-s2 text-t13">
        {checks.map((c) => (
          <li key={c.text} className="flex items-start gap-s2 text-navy-200">
            <Lamp tone={c.ok ? 'navy-200' : 'loss-3'} size={6} className="mt-[6px]" />
            <span>
              <span className="sr-only">{c.ok ? 'Passes: ' : 'Fails: '}</span>
              {c.text}
            </span>
          </li>
        ))}
        {f.corporateAction && (
          <li className="flex items-start gap-s2 text-navy-50">
            <Lamp tone="loss-1" size={6} className="mt-[6px]" />
            <span>
              Coming: {f.corporateAction.kind.toLowerCase()} of ${fmtNumber(f.corporateAction.amount)}, process date{' '}
              {fmtExpiry(Date.parse(f.corporateAction.processDate) / 1000)} ({f.corporateAction.status.toLowerCase()}). Once the issuer schedules the multiplier
              change, {f.symbol} halts from 24 h before it takes effect until 1 h after: no opening trades, no vault exits, auctions paused.
            </span>
          </li>
        )}
      </ul>
      <div className="grid content-start gap-s3">
        <p className="text-t12 text-navy-200">
          {demo ? `Halts in the replay, ${fmtExpiry(f.historyFrom)} to ${fmtExpiry(f.historyTo)}` : `Round ${f.lastRound} on the feed, ${f.description}`}
        </p>
        {!demo && (
          <p className="text-t13 text-pretty text-navy-200">
            No halt history: the hub decides halts on every read and keeps no log of them. The status on the left is read from the chain now;
            past episodes need an indexer.
          </p>
        )}
        <ul className="grid gap-s3 text-t13">
          {other.map((h) => (
            <li key={`${h.reason}-${h.from}`} data-halt={h.reason} className="grid gap-0.5">
              <span className="flex flex-wrap items-baseline gap-x-s2 font-medium text-navy-50">
                <Lamp tone="loss-3" size={6} />
                {fmtEt(h.from)} for {fmtDuration(h.to - h.from)}
              </span>
              <span className="text-pretty text-navy-200">{haltText(h, f)}</span>
            </li>
          ))}
          {stale.length > 0 && (
            <li data-halt="stale" className="grid gap-0.5">
              <span className="flex flex-wrap items-baseline gap-x-s2 font-medium text-navy-50">
                <Lamp tone="loss-1" size={6} />
                {stale.length} reopen halts, {fmtDuration(Math.min(...stale.map((h) => h.to - h.from)))} to{' '}
                {fmtDuration(Math.max(...stale.map((h) => h.to - h.from)))} each
              </span>
              <span className="text-pretty text-navy-200">
                The feed prints nothing from Friday afternoon to Sunday 20:00 ET. When the extended session opens, its {fmtDuration(f.staleLimits.EXTENDED)}{' '}
                limit sees a print over 50 h old, so {f.symbol} halts until the forced reopen round seconds later.
              </span>
            </li>
          )}
        </ul>
      </div>
    </li>
  );
}

function Figure({ k, v, unit, note }: { k: string; v: string; unit?: string; note?: ReactNode }) {
  return (
    <div className="grid content-start gap-1 border-t border-navy-700 pt-s3">
      <dt className="text-t13 text-navy-200">{k}</dt>
      <dd className="flex items-baseline gap-1.5">
        <span className="text-[28px] leading-8 font-medium tabular-nums tracking-[-0.01em] text-navy-50">{v}</span>
        {unit && <span className="text-t13 text-navy-200">{unit}</span>}
      </dd>
      {note && <dd className="text-t12 text-pretty text-navy-200">{note}</dd>}
    </div>
  );
}

const WATERFALL = [
  { k: 'Payer’s cash', t: 'A net payer’s cash is debited into the expiry’s pool first. There is no cash borrowing.' },
  { k: 'Insurance bridge', t: 'The insurance fund covers the shortfall at once, rounded up to a whole USDG, so receivers aren’t kept waiting.' },
  { k: 'Pending', t: 'Whatever the fund can’t cover stays pending on the expiry; claims for that expiry wait until it clears.' },
  { k: 'Collateral auction', t: 'The account owes the bridge as a deficit and its stock goes to a Dutch auction: proceeds repay pending first, then the fund.' },
  { k: 'Socialized', t: 'True bad debt left after the collateral is gone is spread over all cash through the cash index. Any residual stays on the account as debt.' },
];

function PoolRow({ p }: { p: ExpiryPool }) {
  const open = p.status === 'open';
  return (
    <li data-expiry={p.expiry} data-status={p.status} className="grid gap-s4 border-b border-navy-800 py-s5 lg:grid-cols-[200px_minmax(0,1fr)_minmax(0,1.2fr)] lg:gap-s6">
      <div className="grid content-start gap-s2">
        <h3 className="text-[24px] leading-none font-normal text-navy-50">{fmtCloseEt(p.expiry).replace(/, \d\d:\d\d ET$/, '')}</h3>
        <p className="flex items-center gap-s2 text-t13 text-navy-200">
          <Lamp tone={open ? 'navy-400' : 'navy-200'} state={open ? 'ring' : 'lit'} size={8} />
          {open ? 'Open' : p.pending > 0 || p.unsettledShortQty > 0 ? 'Waiting' : 'Ready, all claims paid'}
        </p>
      </div>
      <dl className="grid grid-cols-2 content-start gap-x-s5 gap-y-s2 text-t13 tabular-nums">
        {(open
          ? [
              { k: 'Short contracts open', v: fmtQty(p.unsettledShortQty, 0) },
              { k: 'Accounts holding it', v: String(p.accounts) },
              { k: 'Settles', v: fmtCloseEt(p.expiry) },
            ]
          : [
              { k: 'Paid in', v: fmtNumber(p.paidIn) },
              { k: 'of which insurance', v: fmtNumber(p.bridged) },
              { k: 'Claims', v: fmtNumber(p.claims) },
              { k: 'Claimed', v: fmtNumber(p.claimed) },
              { k: 'Unsettled shorts', v: fmtQty(p.unsettledShortQty, 0) },
              { k: 'Pending', v: fmtNumber(p.pending) },
            ]
        ).map((x) => (
          <div key={x.k} className="grid gap-0.5">
            <dt className="text-t12 text-navy-200">{x.k}</dt>
            <dd className="text-navy-50">{x.v}</dd>
          </div>
        ))}
      </dl>
      <div className="grid content-start gap-s2 text-t13">
        {open ? (
          <p className="text-pretty text-navy-200">
            Settles on each underlying&apos;s last Chainlink print at or before the close. Claims open once every short has settled and nothing is pending;
            the keeper settles payers first, minutes after the close.
          </p>
        ) : (
          <>
            <p className="text-pretty text-navy-200">
              Ready {p.readyAt ? fmtEt(p.readyAt) : ''}. Paid in less claims: {fmtNumber(p.paidIn - p.claimed)}
              {p.bridged > 0 ? ', the insurance bridge rounded up to a whole USDG' : ''}, kept by the pool.
            </p>
            <table className="w-full border-separate border-spacing-0 text-t12 tabular-nums">
              <caption className="sr-only">Settlement prices for {fmtCloseEt(p.expiry)}</caption>
              <tbody>
                {p.prices.map((x) => (
                  <tr key={x.symbol}>
                    <th scope="row" className="border-t border-navy-800 py-1 pr-s3 text-left font-medium text-navy-50">
                      {x.symbol}
                    </th>
                    <td className="border-t border-navy-800 py-1 pr-s3 text-right text-navy-50">{x.price !== null ? fmtNumber(x.price, 4) : '—'}</td>
                    <td className="border-t border-navy-800 py-1 text-right text-navy-200">
                      round {x.round}, {x.updatedAt ? fmtEt(x.updatedAt) : ''}
                      {x.lag ? `, ${fmtDuration(x.lag)} before the close` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </li>
  );
}

function AuctionRow({ a, asOf }: { a: Auction; asOf: number }) {
  const elapsed = asOf - a.startedAt;
  const now = discountAt(elapsed, a);
  return (
    <li data-auction={a.id} className="grid gap-s5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,1.1fr)]">
      <div className="grid content-start gap-s3">
        <p className="flex flex-wrap items-center gap-s3 text-t13 text-navy-200">
          <Chip size="sm" lamp="loss-3">
            {a.status === 'active' ? 'Running' : a.status === 'paused' ? 'Paused' : 'Ended'}
          </Chip>
          Liquidation of account {a.account}, started {fmtEt(a.startedAt)}
        </p>
        <h3 className="font-display text-[24px] leading-tight font-normal text-balance text-navy-50">
          Account {a.account} is {fmtNumber(a.mm - a.equity)} USDG under maintenance; bidders take it at {fmtPct(now, 2)} off.
        </h3>
        <dl className="grid grid-cols-3 gap-s3 text-t13 tabular-nums max-sm:grid-cols-2">
          {[
            { k: 'Equity', v: fmtNumber(a.equity) },
            { k: 'Maintenance', v: fmtNumber(a.mm) },
            { k: 'Initial margin', v: fmtNumber(a.im) },
            { k: 'Discount now', v: fmtPct(now, 2) },
            { k: 'Max per bid', v: fmtPct(a.maxFractionPerBid, 0) },
            { k: 'Penalty to insurance', v: fmtPct(a.penaltyBps / 1e4, 0) },
          ].map((x) => (
            <div key={x.k} className="grid gap-0.5 border-l border-navy-700 pl-s3">
              <dt className="text-t12 text-navy-200">{x.k}</dt>
              <dd className="text-t17 font-semibold text-navy-50">{x.v}</dd>
            </div>
          ))}
        </dl>
        <p className="text-t13 text-pretty text-navy-200">
          A bid takes up to half of the account&apos;s positions, collateral and cash and pays its share of equity less the discount. It must leave the bidder
          above initial margin. The auction ends once the account is back above initial margin, and pauses while {a.underlyings.join(' or ')} is halted or in a
          weekend session.{' '}
          <Link href="/app/portfolio" className="rounded-[2px] text-navy-50 underline decoration-navy-400 underline-offset-4 ui-hover:decoration-cyan">
            Open the account in Portfolio
          </Link>
          .
        </p>
      </div>
      <Panel title="Discount ramp" level={4} meta={<span className="tabular-nums">{fmtDuration(elapsed)} in</span>}>
        <DiscountRamp
          startDiscount={a.startDiscount}
          maxDiscount={a.maxDiscount}
          duration={a.duration}
          elapsed={elapsed}
          value={a.transferable}
          fraction={a.maxFractionPerBid}
        />
      </Panel>
    </li>
  );
}

export function RiskView() {
  const feeds = useFeeds();
  const protocol = useProtocol();
  const insurance = useInsurance();
  const oi = useOpenInterest();
  const pools = usePools();
  const auctions = useAuctions();
  const refusals = useRefusals();
  const agents = useAgents(7);
  const { data: asOf } = useAsOf();
  const demo = useIsDemo();
  const sortedPools = [...(pools.data ?? [])].sort((a, b) => b.expiry - a.expiry);
  const f0 = feeds.data?.[0];

  return (
    <Page>
      <section aria-labelledby="sessions" className="grid gap-s5">
        <SectionHead
          id="sessions"
          title="Sessions and halts"
          dek="Each underlying trades in the NYSE session it is in, unless a check fails and the hub reports it halted. Halted means risk-reducing trades only, no vault exits, no auctions."
          aside={
            f0 &&
            (demo ? (
              <span className="tabular-nums">
                Halts replayed over the real feeds, {fmtExpiry(f0.historyFrom)} to {fmtExpiry(f0.historyTo)}
              </span>
            ) : (
              <span>Read from MarketDataHub at the latest block</span>
            ))
          }
        />
        {feeds.isPending ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <ul aria-label="Underlyings">
            {feeds.data?.map((f) => (
              <SessionRow key={f.symbol} f={f} demo={demo} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="backstops" className="grid gap-s5">
        <SectionHead
          id="backstops"
          title="Backstops"
          dek="What stands behind a payer that can't pay, in the order it is used."
        />
        <dl className="grid grid-cols-2 gap-x-s6 gap-y-s5 lg:grid-cols-4">
          <Figure k="Insurance fund" v={insurance.data ? fmtNumber(insurance.data.balance) : '—'} unit="USDG" note="Seeded at launch; takes fee share and liquidation penalties." />
          <Figure
            k="Bridged, not yet repaid"
            v={insurance.data ? fmtNumber(insurance.data.outstanding) : '—'}
            unit="USDG"
            note={
              demo
                ? `${insurance.data?.events.filter((e) => e.kind === 'cover').length ?? 0} covers so far, all repaid by collateral sales.`
                : `${insurance.data?.events.filter((e) => e.kind === 'cover').length ?? 0} covers so far.`
            }
          />
          <Figure
            k="Socialized loss"
            v={insurance.data ? fmtNumber(insurance.data.socialized) : '—'}
            unit="USDG"
            note={
              insurance.data
                ? insurance.data.cashIndex >= 1
                  ? `Cash index ${insurance.data.cashIndex.toFixed(6)}: no bad debt has reached depositors.`
                  : `Cash index ${insurance.data.cashIndex.toFixed(6)}: socialized losses have scaled every account's cash by that factor.`
                : undefined
            }
          />
          <Figure
            k="Short open interest"
            v={protocol.data ? fmtNumber(protocol.data.openInterestUsd, 0) : '—'}
            unit="USDG"
            note={oi.data?.map((o) => `${o.underlying} ${fmtQty(o.shortContracts, 0)}`).join(', ') + ' contracts, at spot.'}
          />
        </dl>
        <div className="grid gap-s5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Panel title="Default waterfall">
            <ol className="grid gap-s3">
              {WATERFALL.map((w, i) => (
                <li key={w.k} className="grid grid-cols-[28px_minmax(0,1fr)] gap-s3">
                  <span aria-hidden="true" className="flex size-7 items-center justify-center rounded-full border border-navy-600 text-t12 tabular-nums text-navy-200">
                    {i + 1}
                  </span>
                  <span className="grid gap-0.5">
                    <span className="text-t15 font-medium text-navy-50">{w.k}</span>
                    <span className="text-t13 text-pretty text-navy-200">{w.t}</span>
                  </span>
                </li>
              ))}
            </ol>
          </Panel>
          <Panel title="Insurance fund ledger" padding="none">
            <table className="w-full border-separate border-spacing-0 text-t13 tabular-nums">
              <caption className="sr-only">Insurance fund events, in USDG</caption>
              <thead>
                <tr className="text-t12 text-navy-200">
                  {['When', 'What', 'Amount'].map((h, i) => (
                    <th key={h} scope="col" className={cn('h-9 border-b border-navy-700 px-s4 font-medium', i === 2 ? 'text-right' : 'text-left')}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...(insurance.data?.events ?? [])].reverse().map((e) => (
                  <tr key={`${e.at}-${e.kind}`}>
                    <td className="border-b border-navy-800 px-s4 py-s2 align-top whitespace-nowrap text-navy-200">{fmtEt(e.at, { weekday: false })}</td>
                    <td className="border-b border-navy-800 px-s4 py-s2 text-navy-50">
                      {e.kind === 'seed'
                        ? 'Seeded'
                        : e.kind === 'cover'
                          ? `Bridged ${e.who}'s shortfall on the ${e.expiry ? fmtExpiry(e.expiry) : ''} expiry`
                          : e.kind === 'recover'
                            ? `Repaid by ${e.who}'s collateral sale`
                            : `Liquidation penalty, ${e.who}`}
                    </td>
                    <td className={cn('border-b border-navy-800 px-s4 py-s2 text-right', e.kind === 'cover' ? 'text-loss-1' : 'text-navy-50')}>
                      {e.kind === 'cover' ? '−' : '+'}
                      {fmtNumber(e.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>
      </section>

      <section aria-labelledby="pools" className="grid gap-s5">
        <SectionHead
          id="pools"
          title="Settlement pools"
          dek="One pool per weekly expiry. Payers pay in, receivers claim out, and nobody is paid with someone else's cash."
        />
        {pools.isPending ? <Skeleton className="h-48 w-full" /> : <ul aria-label="Pools by expiry">{sortedPools.map((p) => <PoolRow key={p.expiry} p={p} />)}</ul>}
      </section>

      <section aria-labelledby="auctions-head" id="auctions" className="grid scroll-mt-28 gap-s5">
        <SectionHead
          id="auctions-head"
          title="Auctions"
          dek="Liquidations and deficit sales are Dutch auctions: the discount rises from 2% to 12% over 30 minutes until someone bids."
          aside={<span className="tabular-nums">{auctions.data?.filter((a) => a.status === 'active').length ?? 0} running</span>}
        />
        {auctions.isPending || asOf === undefined ? (
          <Skeleton className="h-48 w-full" />
        ) : auctions.data && auctions.data.length > 0 ? (
          <ul aria-label="Auctions">{auctions.data.map((a) => <AuctionRow key={a.id} a={a} asOf={asOf} />)}</ul>
        ) : (
          <p className="text-t15 text-navy-200">No auction is running. Every account is above maintenance margin.</p>
        )}
      </section>

      <section aria-labelledby="refusals" className="grid gap-s5">
        <SectionHead
          id="refusals"
          title="Refusals"
          dek={
            demo
              ? 'Every trade the clearinghouse turned down, with the rule it broke and the numbers that crossed.'
              : 'Refused transactions from the end-to-end proof on this deployment, decoded from the chain. Reverts emit no events, so a feed of every refusal needs an indexer.'
          }
          aside={<span className="tabular-nums">{refusals.data?.length ?? 0} recent</span>}
        />
        {refusals.isPending || asOf === undefined ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <RefusalFeed items={refusals.data ?? []} agents={agents.data ?? []} asOf={asOf} demo={demo} chainId={demo ? undefined : LIVE_CHAIN.id} />
        )}
      </section>
    </Page>
  );
}
