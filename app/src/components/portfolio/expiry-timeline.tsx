import type { ReactNode } from 'react';
import { Lamp } from '@/components/ui/lamp';
import { Skeleton } from '@/components/ui/skeleton';
import type { AccountExpiry, ExpiryPool, SettlementPrice } from '@/lib/client/types';
import { cn } from '@/lib/cn';
import { fmtNumber, fmtPct, fmtQty, fmtSeries, fmtSigned } from '@/lib/format';
import { fmtCloseEt, fmtEt } from '@/lib/nyse';

interface Step {
  key: string;
  label: string;
  at?: number;
  done: boolean;
  tone?: 'loss';
  body: ReactNode;
}

const STATUS: Record<AccountExpiry['status'], { text: string; tone: 'navy-200' | 'gain-2' | 'loss-1' | 'loss-3' | 'navy-400'; state: 'lit' | 'ring' }> = {
  open: { text: 'Open', tone: 'navy-400', state: 'ring' },
  claimable: { text: 'Claimable', tone: 'gain-2', state: 'lit' },
  claimed: { text: 'Claimed', tone: 'navy-200', state: 'lit' },
  paid: { text: 'Paid', tone: 'navy-200', state: 'lit' },
  deficit: { text: 'Deficit', tone: 'loss-3', state: 'lit' },
  'deficit-cleared': { text: 'Deficit cleared', tone: 'loss-1', state: 'lit' },
};

function u(v: number) {
  return <span className="tabular-nums text-navy-50">{fmtNumber(v)}</span>;
}

function steps(e: AccountExpiry, pool?: ExpiryPool): Step[] {
  if (e.status === 'open') {
    const pays = e.net < 0;
    return [
      {
        key: 'settle',
        label: 'Settles',
        done: false,
        body: <>{fmtCloseEt(e.expiry)}, on the last print at or before the close.</>,
      },
      {
        key: 'pool',
        label: pays ? 'Would pay' : 'Would claim',
        done: false,
        tone: e.shortfall ? 'loss' : undefined,
        body: pays ? (
          e.shortfall ? (
            <>
              At today&apos;s spot it owes {u(-e.net)}; cash {u(e.cash ?? 0)} leaves {u(e.shortfall)} short. The insurance fund would
              bridge that and the account would carry a deficit until its collateral is sold.
            </>
          ) : (
            <>
              At today&apos;s spot it pays {u(-e.net)} into the pool from cash {u(e.cash ?? 0)}. No deficit.
            </>
          )
        ) : e.net > 0 ? (
          <>At today&apos;s spot it receives a claim of {u(e.net)}, counted in equity until paid.</>
        ) : (
          <>At today&apos;s spot every leg expires worthless.</>
        ),
      },
      {
        key: 'pool-ready',
        label: 'Pool opens',
        done: false,
        body: pool ? (
          <>
            When all <span className="tabular-nums text-navy-50">{fmtQty(pool.unsettledShortQty, 2)}</span> short contracts of this expiry have
            settled and nothing is pending.
          </>
        ) : (
          'When every short of this expiry has settled and nothing is pending.'
        ),
      },
    ];
  }
  const settled: Step = {
    key: 'settle',
    label: 'Settled',
    at: e.settledAt,
    done: true,
    body:
      e.net >= 0 ? (
        <>Net {u(e.net)}: a claim on the pool, counted in equity until paid.</>
      ) : (
        <>Net {u(e.net)}: owed to the pool.</>
      ),
  };
  if (e.net >= 0) {
    return [
      settled,
      {
        key: 'claimable',
        label: 'Claimable',
        at: e.readyAt,
        done: e.readyAt !== undefined,
        body: pool ? (
          <>
            Pool ready: <span className="tabular-nums text-navy-50">{fmtQty(pool.unsettledShortQty, 0)}</span> short contracts unsettled, {u(pool.pending)} pending.
          </>
        ) : (
          'Pool ready.'
        ),
      },
      {
        key: 'claimed',
        label: 'Claimed',
        at: e.claimedAt,
        done: e.claimedAt !== undefined,
        body: e.claimedAt !== undefined ? <>{u(e.claimable ?? e.net)} moved into cash.</> : 'Anyone can call claim; the keeper does right after the pool opens.',
      },
    ];
  }
  if (e.status === 'paid') {
    return [
      settled,
      { key: 'paid', label: 'Paid', at: e.settledAt, done: true, body: <>{u(e.paidCash ?? -e.net)} from cash into the pool.</> },
      { key: 'closed', label: 'Done', at: e.settledAt, done: true, body: 'Nothing owed.' },
    ];
  }
  const sale = e.deficitSale;
  return [
    settled,
    {
      key: 'bridged',
      label: 'Bridged',
      at: e.settledAt,
      done: true,
      tone: 'loss',
      body: (
        <>
          {u(e.paidCash ?? 0)} from cash; the insurance fund bridged {u(e.bridged ?? 0)} (the {fmtNumber(e.shortfall ?? 0)} shortfall rounded up to a
          whole USDG). The deficit blocked withdrawals and opening trades.
        </>
      ),
    },
    {
      key: 'cleared',
      label: e.status === 'deficit' ? 'Deficit sale' : 'Cleared',
      at: e.clearedAt,
      done: e.status === 'deficit-cleared',
      body: sale ? (
        <>
          Deficit sale: <span className="tabular-nums text-navy-50">{fmtQty(sale.tokensSold)}</span> NVDA at {u(sale.price)},{' '}
          {fmtPct(sale.discount, 2)} under spot {fmtNumber(sale.spot)}, {Math.round((sale.bidAt - sale.startedAt) / 60)} min in. The proceeds repaid the
          insurance fund.
        </>
      ) : (
        'Collateral goes to a Dutch auction; proceeds repay what is pending first, then the insurance fund.'
      ),
    },
  ];
}

function priceNote(p?: SettlementPrice) {
  if (!p || p.price === null || p.round === null || p.updatedAt === null) return null;
  return `round ${p.round}, ${fmtEt(p.updatedAt)}`;
}

/** One row per expiry: where it stands (settled, claimable, claimed), its pool, and the legs at their settlement prices. */
export function ExpiryTimeline({ items, pools, loading }: { items?: AccountExpiry[]; pools?: ExpiryPool[]; loading?: boolean }) {
  if (loading || !items) return <Skeleton className="h-48 w-full" />;
  if (items.length === 0) return <p className="text-t15 text-navy-200">No expiries on this account yet.</p>;
  return (
    <ol className="grid" aria-label="Expiries, newest first">
      {items.map((e) => {
        const pool = pools?.find((p) => p.expiry === e.expiry);
        const st = STATUS[e.status];
        const ss = steps(e, pool);
        const open = e.status === 'open';
        return (
          <li key={e.expiry} data-expiry={e.expiry} data-status={e.status} className="grid gap-s4 border-b border-navy-800 py-s5 first:pt-0 lg:grid-cols-[200px_minmax(0,1fr)_160px] lg:gap-s6">
            <div className="grid content-start gap-s2">
              <h3 className="text-[24px] leading-none font-normal text-navy-50">{fmtCloseEt(e.expiry).replace(/, \d\d:\d\d ET$/, '')}</h3>
              <p className="flex items-center gap-s2 text-t13 text-navy-200">
                <Lamp tone={st.tone} state={st.state} size={8} />
                {st.text}
              </p>
            </div>

            <div className="grid gap-s4">
              <ol className="grid gap-s3 sm:grid-cols-3 sm:gap-s4">
                {ss.map((s) => (
                  <li key={s.key} data-step={s.key} data-done={s.done} className="relative grid content-start gap-1 sm:border-t sm:border-navy-700 sm:pt-s3">
                    <span
                      aria-hidden="true"
                      className={cn(
                        'absolute -top-[5px] left-0 hidden size-2.5 rounded-full sm:block',
                        s.done ? (s.tone === 'loss' ? 'bg-loss-1' : 'bg-navy-50') : 'border-[1.5px] border-navy-400 bg-navy-900',
                      )}
                    />
                    <p className="flex flex-wrap items-baseline gap-x-s2 text-t13 font-medium text-navy-50">
                      <span className="sm:hidden">
                        <Lamp tone={s.done ? (s.tone === 'loss' ? 'loss-1' : 'navy-50') : 'navy-400'} state={s.done ? 'lit' : 'ring'} size={6} />
                      </span>
                      {s.label}
                      {s.at !== undefined && <span className="text-t12 font-normal tabular-nums text-navy-200">{fmtEt(s.at)}</span>}
                      <span className="sr-only">{s.done ? ', done' : ', not yet'}</span>
                    </p>
                    <p className="text-t13 text-pretty text-navy-200">{s.body}</p>
                  </li>
                ))}
              </ol>
              {e.legs.length > 0 && (
                <table className="w-full max-w-[640px] border-separate border-spacing-0 text-t12 tabular-nums">
                  <caption className="sr-only">Legs of the {fmtCloseEt(e.expiry)} expiry</caption>
                  <thead>
                    <tr className="text-navy-200">
                      <th scope="col" className="pb-1 text-left font-normal">
                        Leg
                      </th>
                      <th scope="col" className="pb-1 text-right font-normal">
                        {open ? 'Spot today' : 'Settled at'}
                      </th>
                      <th scope="col" className="pb-1 text-right font-normal">
                        Payoff
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {e.legs.map((l, i) => {
                      const note = open ? null : priceNote(pool?.prices.find((p) => p.symbol === l.underlying));
                      return (
                        <tr key={i}>
                          <td className="border-t border-navy-800 py-1 pr-s3 text-navy-50">
                            {fmtSigned(l.qty, 0)} {fmtSeries(l)}
                          </td>
                          <td className="border-t border-navy-800 py-1 pl-s3 text-right text-navy-200">
                            <span className="text-navy-50">{fmtNumber(l.settlePrice, open ? 2 : 4)}</span>
                            {note && <span className="block text-navy-200 max-sm:hidden">{note}</span>}
                          </td>
                          <td className="border-t border-navy-800 py-1 pl-s3 text-right text-navy-50">{fmtSigned(l.payoff)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            <div className="grid content-start gap-0.5 lg:text-right">
              <p className="text-t12 text-navy-200">{open ? "At today's spot" : e.net >= 0 ? 'Received' : 'Paid'}</p>
              <p className={cn('text-[22px] leading-7 font-semibold tabular-nums', e.net > 0 ? 'text-gain-2' : e.net < 0 ? 'text-loss-1' : 'text-navy-50')}>
                {fmtSigned(e.net)}
              </p>
              <p className="text-t12 text-navy-200">USDG</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
