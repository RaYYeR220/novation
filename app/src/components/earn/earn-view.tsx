'use client';

import { useMemo, useState } from 'react';
import { useAccount } from 'wagmi';
import { useAccountId } from '@/components/app/account-context';
import { Page, SectionHead } from '@/components/app/section-head';
import { NavChart, NavSparkline, type NavMark } from '@/components/charts/nav-chart';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { DataTable, type Column } from '@/components/ui/data-table';
import { Lamp } from '@/components/ui/lamp';
import { Panel } from '@/components/ui/panel';
import { Skeleton } from '@/components/ui/skeleton';
import { useAsOf, useFeeds, useIsDemo, useSubaccount, useUnderlyings, useVault, useVaults, useWallet } from '@/lib/client/hooks';
import type { Vault, VaultDetail, VaultEpoch } from '@/lib/client/types';
import { cn } from '@/lib/cn';
import { fmtAddress, fmtDuration, fmtExpiry, fmtNumber, fmtPct, fmtQty, fmtSigned } from '@/lib/format';
import { fmtCloseEt, fmtEt } from '@/lib/nyse';
import { DepositDialog, WithdrawDialog } from './vault-dialogs';

const STRATEGY = { coveredCall: 'Covered call', putWrite: 'Put write' } as const;

function ruleLine(v: Pick<Vault, 'kind' | 'underlying'>) {
  return v.kind === 'coveredCall' ? `Sells ${v.underlying} calls 5% or more above spot` : `Sells ${v.underlying} puts 5% or more below spot`;
}

function VaultRow({ v, history, selected, onSelect }: { v: Vault; history?: VaultDetail['navHistory']; selected: boolean; onSelect: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        aria-controls="vault-detail"
        data-vault={v.address}
        className={cn(
          'grid w-full grid-cols-2 items-center gap-x-s4 gap-y-s3 border-b border-navy-800 px-s4 py-s4 text-left transition-colors duration-(--duration-fast)',
          'md:grid-cols-[minmax(220px,1.6fr)_minmax(100px,1fr)_minmax(80px,0.7fr)_minmax(140px,1.2fr)_minmax(64px,0.5fr)_minmax(96px,0.8fr)_128px]',
          selected ? 'bg-navy-800 shadow-[inset_2px_0_0_var(--color-cyan)]' : 'ui-hover:bg-navy-800/50',
        )}
      >
        <span className="col-span-2 grid gap-0.5 md:col-span-1">
          <span className="font-display text-[22px] leading-tight text-navy-50">
            {STRATEGY[v.kind]} <span className="text-navy-200">on</span> {v.underlying}
          </span>
          <span className="text-t13 text-navy-200">{ruleLine(v)}</span>
        </span>
        <span className="grid gap-0.5">
          <span className="text-t12 text-navy-200 md:sr-only">TVL</span>
          <span className="text-t17 font-semibold tabular-nums text-navy-50">{fmtNumber(v.tvl, 0)}</span>
          <span className="text-t12 text-navy-200">USDG</span>
        </span>
        <span className="grid gap-0.5">
          <span className="text-t12 text-navy-200 md:sr-only">7-day APY</span>
          <span className="text-t17 font-semibold tabular-nums text-navy-50">{Number.isFinite(v.apy7d) ? fmtPct(v.apy7d) : '—'}</span>
          <span className="text-t12 text-navy-200 max-md:hidden">{Number.isFinite(v.apy7d) ? '7 days' : 'needs 7 days of NAV'}</span>
        </span>
        <span className="grid gap-1.5">
          <span className="flex items-baseline justify-between text-t12 text-navy-200">
            <span>Locked</span>
            <span className="tabular-nums text-navy-50">{fmtPct(v.utilization, 0)}</span>
          </span>
          <span aria-hidden="true" className="relative h-1 rounded-full bg-navy-700">
            <span className="absolute inset-y-0 left-0 rounded-full bg-zero" style={{ width: `${Math.min(100, v.utilization * 100)}%` }} />
          </span>
        </span>
        <span className="grid gap-0.5">
          <span className="text-t12 text-navy-200 md:sr-only">Epoch</span>
          <span className="text-t15 font-medium tabular-nums text-navy-50">{v.epoch}</span>
        </span>
        <span>
          {v.live ? (
            <Chip size="sm" lamp="cyan">
              Live
            </Chip>
          ) : (
            <Chip size="sm" lamp="loss-3">
              Not live
            </Chip>
          )}
        </span>
        <span className="max-md:hidden">{history && <NavSparkline points={history} />}</span>
      </button>
    </li>
  );
}

const epochColumns = (v: VaultDetail): Column<VaultEpoch>[] => [
  { key: 'epoch', header: 'Epoch', cell: (e) => <span className="font-medium">{e.epoch}</span> },
  { key: 'expiry', header: 'Expiry', cell: (e) => fmtExpiry(e.expiry) },
  { key: 'strike', header: 'Strike', numeric: true, cell: (e) => fmtNumber(e.strike, 0) },
  { key: 'qty', header: 'Sold', numeric: true, cell: (e) => fmtNumber(e.qty, 0) },
  { key: 'premium', header: 'Premium', numeric: true, cell: (e) => fmtNumber(e.premium) },
  { key: 'settle', header: 'Settled at', numeric: true, cell: (e) => fmtNumber(e.settlePrice, 4) },
  {
    key: 'payout',
    header: 'Paid out',
    numeric: true,
    cell: (e) => (e.payout > 0 ? <span className={e.deficit > 0 ? 'text-loss-1' : undefined}>{fmtNumber(e.payout)}</span> : <span className="text-navy-200">0.00</span>),
  },
  { key: 'nav', header: `NAV after, ${v.asset}`, numeric: true, cell: (e) => fmtNumber(e.navAfter, 4) },
];

function SplitBar({ v }: { v: VaultDetail }) {
  const total = v.locked + v.queued + v.free || 1;
  const parts = [
    { k: 'Locked behind open shorts', v: v.locked, cls: 'bg-navy-400' },
    { k: 'Owed to the redemption queue', v: v.queued, cls: 'bg-[repeating-linear-gradient(135deg,var(--color-loss-1)_0_2px,transparent_2px_5px)]' },
    { k: 'Free: can leave now', v: v.free, cls: 'bg-zero' },
  ];
  return (
    <div className="grid gap-s3">
      <div aria-hidden="true" className="flex h-2.5 gap-0.5 overflow-hidden rounded-[2px]">
        {parts.map((p) => (
          <span key={p.k} className={cn('h-full', p.cls)} style={{ width: `${(p.v / total) * 100}%` }} />
        ))}
      </div>
      <dl className="grid text-t13 tabular-nums">
        {parts.map((p) => (
          <div key={p.k} className="flex items-center justify-between gap-s3 border-b border-navy-800 py-1.5">
            <dt className="flex items-center gap-s2 text-navy-200">
              <span aria-hidden="true" className={cn('inline-block size-2.5 rounded-[2px]', p.cls)} />
              {p.k}
            </dt>
            <dd className="text-navy-50">
              {fmtQty(p.v, 2)} <span className="text-navy-200">{v.asset}</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Rules({ v }: { v: VaultDetail }) {
  const c = v.config;
  const call = v.kind === 'coveredCall';
  const rules = [
    call
      ? `Sells ${v.underlying} calls only, at strikes at least ${fmtPct(c.minOtm, 0)} above spot.`
      : `Sells ${v.underlying} puts only, at strikes at least ${fmtPct(c.minOtm, 0)} below spot.`,
    call
      ? `Fully covered: open short calls never exceed the ${v.underlying} it holds, one token per call.`
      : 'Cash-secured: strike times contracts never exceeds the USDG it holds.',
    `Offers only strikes with a delta between ${fmtNumber(c.minDelta)} and ${fmtNumber(c.maxDelta)} at mark vol, expiring within ${c.maxTenorDays} days, at most ${c.maxOpenSeries} series at once.`,
    `Quotes the kernel's Black-Scholes at mark vol × (1 + ${c.skewSlope} × distance from spot + ${c.utilSlope} × utilization after the trade), plus a ${fmtPct(c.spread, 0)} spread.`,
    `Buys back at its bid, which never goes above its own mark less ${fmtPct(c.spread, 0)}, and only up to its short in that series.`,
    call
      ? `Premium sits as USDG in the vault's account and counts in NAV; exits pay ${v.underlying} up to the unlocked tokens.`
      : 'Premium and cash stay in the vault’s account; exits pay USDG up to the unlocked cash.',
  ];
  return (
    <ul className="grid gap-s2 text-t15 text-pretty text-navy-200">
      {rules.map((r) => (
        <li key={r} className="flex gap-s3">
          <span aria-hidden="true" className="mt-[9px] size-1.5 shrink-0 rounded-full bg-navy-400" />
          <span>{r}</span>
        </li>
      ))}
    </ul>
  );
}

function VaultDetailView({ address }: { address: string }) {
  const { data: v, isPending, isError } = useVault(address);
  const { id, label } = useAccountId();
  const account = useSubaccount(id);
  const demo = useIsDemo();
  const { address: connected } = useAccount();
  // the demo reads the selected account owner's wallet; live mode the connected one
  const wallet = useWallet(demo ? account.data?.owner : connected);
  const underlyings = useUnderlyings();
  const feeds = useFeeds();
  const { data: asOf } = useAsOf();
  const [deposit, setDeposit] = useState(false);
  const [withdraw, setWithdraw] = useState(false);
  const marks: NavMark[] = useMemo(
    () =>
      (v?.epochs ?? [])
        .filter((e) => e.payout > 0)
        .map((e) => ({
          t: e.expiry,
          tone: e.deficit > 0 ? ('deficit' as const) : ('paid' as const),
          text:
            e.deficit > 0
              ? `Expiry ${fmtExpiry(e.expiry)}: paid ${fmtNumber(e.payout)}, ${fmtNumber(e.deficit)} past its cash; insurance bridged it and tokens were sold.`
              : `Expiry ${fmtExpiry(e.expiry)}: settled at ${fmtNumber(e.settlePrice, 2)}, paid ${fmtNumber(e.payout)}.`,
        })),
    [v],
  );
  if (isError) return <p className="text-t15 text-loss-1">The vault could not be read. It retries on the next block.</p>;
  if (isPending || !v || asOf === undefined) return <Skeleton className="h-96 w-full" />;
  const feed = feeds.data?.find((f) => f.symbol === v.underlying);
  const lastHalt = feed?.halts.filter((h) => h.reason !== 'stale').at(-1);
  const holding = wallet.data?.vaults.find((h) => h.vault.toLowerCase() === v.address.toLowerCase());
  const balance = wallet.data?.tokens[v.asset] ?? 0;
  const cooling = holding ? asOf < holding.lastReceive + v.cooldown : false;
  const spot = v.navHistory.at(-1)?.spot ?? underlyings.data?.find((u) => u.symbol === v.underlying)?.spot ?? 0;
  const value = holding ? holding.shares * v.navPerShare : 0;
  const checks = [
    { ok: v.live, text: `${v.underlying} price readable, inside its band and fresh for the session` },
    { ok: v.live, text: `${v.underlying} not halted` },
    { ok: true, text: 'Mark vol updated within 2 days' },
    { ok: true, text: 'No deficit owed by the vault' },
  ];

  return (
    <section id="vault-detail" aria-labelledby="vault-title" className="grid gap-s5">
      <div className="flex flex-wrap items-end justify-between gap-x-s6 gap-y-s3 border-b border-navy-700 pb-s4">
        <div className="grid gap-s1">
          <p className="text-t13 text-navy-200">
            {v.symbol}, {fmtAddress(v.address)}. Launched {fmtExpiry(v.launchedAt)}.
          </p>
          <h2 id="vault-title" className="text-[36px] leading-[1.08] font-normal text-navy-50 max-sm:text-[28px]">
            {v.name}
          </h2>
          <p className="text-t15 text-navy-200">
            Epoch {v.epoch}: sells the {fmtCloseEt(v.nextRoll)} expiry. The roll after it pays the redemption queue.
          </p>
        </div>
        <div className="flex flex-wrap gap-s3">
          <Button variant="secondary" onClick={() => setWithdraw(true)}>
            Withdraw
          </Button>
          <Button variant="primary" lamp onClick={() => setDeposit(true)} disabled={!v.live}>
            Deposit {v.asset}
          </Button>
        </div>
      </div>

      <div className="grid gap-s5 lg:grid-cols-[minmax(0,1.75fr)_minmax(300px,1fr)]">
        <div className="grid min-w-0 content-start gap-s5">
          <Panel
            title="NAV per share"
            meta={
              <span className="tabular-nums">
                {fmtNumber(v.navPerShare, 6)} {v.asset}, {fmtSigned((v.navPerShare - 1) * 100, 2)}% since launch
              </span>
            }
          >
            <NavChart points={v.navHistory} unit={v.asset} marks={marks} label={`${v.symbol} NAV per share`} />
            {demo ? (
              <p className="mt-s3 text-t12 text-pretty text-navy-200">
                Demo replay: the vault&apos;s rules run week by week over the real {v.underlying}/USD Chainlink rounds, settling each expiry on the last print at
                or before the close. Takers are assumed to buy {fmtPct(v.fillShare, 0)} of capacity at each roll; marks use a {fmtPct(v.markVol, 0)} vol.
              </p>
            ) : (
              <p className="text-t13 text-pretty text-navy-200">
                No NAV history yet. The vault launched {fmtEt(v.launchedAt)} and the chain keeps only today&apos;s NAV, read live above from the
                kernel&apos;s marks at a {fmtPct(v.markVol, 0)} mark vol. A history needs an indexer recording it block by block.
              </p>
            )}
          </Panel>

          <Panel title="Strategy rules">
            <Rules v={v} />
          </Panel>

          <Panel title="Epochs" padding="none" meta={<span>{v.epochs.length} rolls, newest first</span>}>
            <DataTable
              caption={`${v.symbol} epochs`}
              columns={epochColumns(v)}
              rows={[...v.epochs].reverse()}
              rowKey={(e) => String(e.epoch)}
              maxHeight={340}
              empty={`No roll yet. The first follows the ${fmtCloseEt(v.nextRoll)} expiry, once it settles.`}
            />
          </Panel>
        </div>

        <div className="grid content-start gap-s5">
          <Panel title="Free and locked" meta={<span className="tabular-nums">{fmtQty(v.backing, 2)} {v.asset} backing</span>}>
            <SplitBar v={v} />
            <p className="mt-s3 text-t13 text-pretty text-navy-200">
              Instant withdrawals take only the free part. {fmtNumber(v.escrowedShares, 2)} queued shares are owed{' '}
              {fmtQty(v.queued, 2)} {v.asset} at today&apos;s NAV and are paid by the roll after the {fmtCloseEt(v.nextRoll)} expiry.
            </p>
          </Panel>

          <Panel title="Your position" meta={<span>{demo ? `${label(id)} owner` : 'Connected wallet'}</span>}>
            {holding ? (
              <dl className="grid text-t13 tabular-nums">
                {[
                  { k: 'Shares', v: fmtNumber(holding.shares, 4) },
                  { k: `Worth, ${v.asset}`, v: fmtQty(value) },
                  { k: 'Worth, USDG', v: fmtNumber(v.asset === 'USDG' ? value : value * spot) },
                  { k: 'Queued for the next roll', v: fmtNumber(holding.pendingShares, 2) },
                ].map((r) => (
                  <div key={r.k} className="flex justify-between gap-s3 border-b border-navy-800 py-1.5">
                    <dt className="text-navy-200">{r.k}</dt>
                    <dd className="text-navy-50">{r.v}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {holding ? (
              <p className="flex items-start gap-s2 pt-s3 text-t13 text-pretty text-navy-200">
                <Lamp tone={cooling ? 'loss-1' : 'navy-200'} size={6} className="mt-[6px]" />
                {cooling
                  ? `Exit cooldown: your shares arrived ${fmtEt(holding.lastReceive)}; withdrawals and redemption requests open ${fmtEt(holding.lastReceive + v.cooldown)}, ${fmtDuration(holding.lastReceive + v.cooldown - asOf)} from now.`
                  : 'Past the one-hour exit cooldown: you can withdraw or queue a redemption.'}
              </p>
            ) : (
              <p className="text-t13 text-navy-200">
                {!demo && !connected
                  ? 'Connect a wallet to see your shares.'
                  : `No shares in this vault. Your wallet holds ${fmtQty(balance)} ${v.asset}.`}
              </p>
            )}
          </Panel>

          <Panel title="Priced at live NAV">
            <p className="text-t15 text-pretty text-navy-200">
              Deposits and withdrawals price at the vault&apos;s equity right now: the kernel marks every open short at the current spot and mark vol. A
              stale NAV can&apos;t be traded against, and new shares wait {fmtDuration(v.cooldown)} before they can leave.
            </p>
            <ul className="mt-s4 grid gap-s2 text-t13">
              {checks.map((c) => (
                <li key={c.text} className="flex items-start gap-s2 text-navy-200">
                  <Lamp tone={c.ok ? 'navy-200' : 'loss-3'} size={6} className="mt-[6px]" />
                  <span>
                    <span className="sr-only">{c.ok ? 'Passes: ' : 'Fails: '}</span>
                    {c.text}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-s4 text-t13 text-pretty text-navy-200">
              Any failure stops deposits, exits, quotes and roll payouts until it clears.
              {lastHalt &&
                ` Last time: ${fmtEt(lastHalt.from)} to ${fmtEt(lastHalt.to)}, ${
                  lastHalt.reason === 'multiplier' ? `${v.underlying}'s multiplier change` : lastHalt.reason === 'implausible' ? 'implausible prints from the feed' : 'a stale feed'
                }.`}
            </p>
          </Panel>
        </div>
      </div>

      <DepositDialog vault={v} open={deposit} onOpenChange={setDeposit} asOf={asOf} demo={demo} balance={balance} />
      <WithdrawDialog vault={v} open={withdraw} onOpenChange={setWithdraw} asOf={asOf} demo={demo} holding={holding} />
    </section>
  );
}

function useHistories(vaults: Vault[] | undefined) {
  const a = useVault(vaults?.[0]?.address);
  const b = useVault(vaults?.[1]?.address);
  const c = useVault(vaults?.[2]?.address);
  return new Map([a.data, b.data, c.data].filter((x): x is VaultDetail => Boolean(x)).map((d) => [d.address, d.navHistory]));
}

export function EarnView() {
  const vaults = useVaults();
  const [pick, setPick] = useState<string | undefined>(undefined);
  const selected = pick ?? vaults.data?.[0]?.address;
  const histories = useHistories(vaults.data);
  return (
    <Page>
      <section aria-labelledby="vaults" className="grid gap-s5">
        <SectionHead
          id="vaults"
          title="Vaults"
          dek="Deposit stock or USDG; the vault sells weekly options against it on the clearinghouse and keeps the premium. Shares price at the live NAV."
          aside={<span className="tabular-nums">7-day APY from NAV per share, annualised</span>}
        />
        {vaults.isPending ? (
          <Skeleton className="h-48 w-full" />
        ) : vaults.isError ? (
          <p className="text-t15 text-loss-1">The vaults could not be read. They retry on the next block.</p>
        ) : (
          <div>
            <div
              aria-hidden="true"
              className="hidden grid-cols-[minmax(220px,1.6fr)_minmax(100px,1fr)_minmax(80px,0.7fr)_minmax(140px,1.2fr)_minmax(64px,0.5fr)_minmax(96px,0.8fr)_128px] gap-x-s4 border-b border-navy-700 px-s4 pb-s2 text-t12 text-navy-200 md:grid"
            >
              <span>Strategy</span>
              <span>TVL</span>
              <span>7-day APY</span>
              <span>Utilization</span>
              <span>Epoch</span>
              <span>Status</span>
              <span>NAV since launch</span>
            </div>
            <ul aria-label="Vaults">
              {(vaults.data ?? []).map((v) => (
                <VaultRow key={v.address} v={v} history={histories.get(v.address)} selected={v.address === selected} onSelect={() => setPick(v.address)} />
              ))}
            </ul>
          </div>
        )}
      </section>
      {selected && <VaultDetailView address={selected} />}
    </Page>
  );
}
