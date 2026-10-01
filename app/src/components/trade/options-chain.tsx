'use client';

import { useMemo } from 'react';
import { DataTable, type Column } from '@/components/ui/data-table';
import { useWidth } from '@/components/charts/use-width';
import type { Series } from '@/lib/client/types';
import { cn } from '@/lib/cn';
import { fmtNumber, fmtSeries, fmtStrike } from '@/lib/format';

export type ChainSeries = Series & { bid: number; ask: number; delta: number; iv: number };
export type Side = 'buy' | 'sell';

interface Row {
  strike: number;
  call?: ChainSeries;
  put?: ChainSeries;
}

export interface OptionsChainProps {
  symbol: string;
  spot: number;
  series: ChainSeries[];
  /** Series id → quantity the account holds. */
  held: ReadonlyMap<number, number>;
  selected?: { seriesId: number; side: Side };
  /** A bid sells, an ask buys. */
  onPick: (s: ChainSeries, side: Side) => void;
  /** Enter on a row, or a click outside the quotes: open the strike on the current type. */
  onStrike: (strike: number) => void;
  loading?: boolean;
  error?: string;
}

/** Zero stays zero: a tiny negative delta prints 0.00, not −0.00. */
const delta = (d: number) => fmtNumber(Math.round(d * 100) / 100 + 0, 2);

function Quote({
  s,
  side,
  itm,
  selected,
  onPick,
}: {
  s: ChainSeries;
  side: Side;
  itm: boolean;
  selected: boolean;
  onPick: OptionsChainProps['onPick'];
}) {
  const price = side === 'sell' ? s.bid : s.ask;
  return (
    <button
      type="button"
      tabIndex={-1}
      onClick={() => onPick(s, side)}
      aria-label={`${side === 'buy' ? 'Buy' : 'Sell'} ${fmtSeries(s)} at ${side === 'buy' ? 'ask' : 'bid'} ${fmtNumber(price)}`}
      aria-pressed={selected}
      data-quote={side}
      className={cn(
        '-mx-1.5 inline-flex h-7 min-w-14 items-center justify-end rounded-[3px] px-1.5 tabular-nums',
        'transition-colors duration-(--duration-fast) ui-hover:bg-navy-600 ui-hover:text-navy-50',
        selected ? 'bg-navy-700 text-navy-50 shadow-[inset_0_0_0_1px_var(--color-cyan)]' : itm ? 'text-navy-50' : 'text-navy-200',
      )}
    >
      {fmtNumber(price)}
    </button>
  );
}

/**
 * The chain for one expiry: strikes down the middle, calls to the left, puts to the right. A bid
 * opens a sale and an ask a purchase; Enter on a row opens that strike. In-the-money quotes are
 * brighter. Narrow tables drop IV, then delta.
 */
export function OptionsChain({ symbol, spot, series, held, selected, onPick, onStrike, loading, error }: OptionsChainProps) {
  const [ref, width] = useWidth<HTMLDivElement>(820);
  const rows = useMemo(() => {
    const by = new Map<number, Row>();
    for (const s of series) {
      const r = by.get(s.strike) ?? { strike: s.strike };
      if (s.isCall) r.call = s;
      else r.put = s;
      by.set(s.strike, r);
    }
    return [...by.values()].sort((a, b) => a.strike - b.strike);
  }, [series]);
  const atm = rows.reduce<number | undefined>(
    (best, r) => (best === undefined || Math.abs(r.strike - spot) < Math.abs(best - spot) ? r.strike : best),
    undefined,
  );
  const currentStrike = series.find((s) => s.id === selected?.seriesId)?.strike;
  const level = width >= 620 ? 'full' : width >= 440 ? 'mid' : 'compact';

  const side = (isCall: boolean): Column<Row>[] => {
    const get = (r: Row) => (isCall ? r.call : r.put);
    const itm = (r: Row) => (isCall ? r.strike < spot : r.strike > spot);
    const tone = (r: Row) => (itm(r) ? 'text-navy-50' : 'text-navy-200');
    const quote = (q: Side): Column<Row> => ({
      key: `${isCall ? 'c' : 'p'}-${q}`,
      header: q === 'sell' ? 'Bid' : 'Ask',
      numeric: true,
      cell: (r) => {
        const s = get(r);
        if (!s) return null;
        return (
          <Quote s={s} side={q} itm={itm(r)} selected={selected?.seriesId === s.id && selected.side === q} onPick={onPick} />
        );
      },
    });
    const greeks: Column<Row>[] = [];
    if (level !== 'compact')
      greeks.push({
        key: `${isCall ? 'c' : 'p'}-delta`,
        header: 'Delta',
        numeric: true,
        cell: (r) => <span className={tone(r)}>{get(r) ? delta(get(r)!.delta) : ''}</span>,
      });
    if (level === 'full')
      greeks.push({
        key: `${isCall ? 'c' : 'p'}-iv`,
        header: 'IV',
        numeric: true,
        cell: (r) => <span className={tone(r)}>{get(r) ? `${fmtNumber(get(r)!.iv * 100, 1)}%` : ''}</span>,
      });
    const quotes = [quote('sell'), quote('buy')];
    // Calls read outward-in (greeks, then quotes next to the strike); puts mirror them.
    return isCall ? [...greeks, ...quotes] : [...quotes, ...greeks.reverse()];
  };

  const strikeCol: Column<Row> = {
    key: 'strike',
    header: <span className="block text-center">Strike</span>,
    width: '6.5rem',
    cell: (r) => {
      const c = r.call ? held.get(r.call.id) : undefined;
      const p = r.put ? held.get(r.put.id) : undefined;
      return (
        <span className="relative flex items-center justify-center gap-s2 font-semibold text-navy-50">
          <span
            aria-hidden="true"
            className={cn('size-1.5 rounded-full', c ? 'bg-navy-50' : 'bg-transparent')}
          />
          <span className={cn('tabular-nums', r.strike === atm && 'underline decoration-navy-400 decoration-2 underline-offset-4')}>
            {fmtStrike(r.strike)}
          </span>
          <span
            aria-hidden="true"
            className={cn('size-1.5 rounded-full', p ? 'bg-navy-50' : 'bg-transparent')}
          />
          {r.strike === atm && <span className="sr-only"> (closest to spot)</span>}
          {c ? <span className="sr-only">, you hold {fmtNumber(c, 0)} calls</span> : null}
          {p ? <span className="sr-only">, you hold {fmtNumber(p, 0)} puts</span> : null}
        </span>
      );
    },
  };

  const columns = [...side(true), strikeCol, ...side(false)];
  const heldHere = series.some((s) => held.has(s.id));

  return (
    <div ref={ref} className="grid min-w-0 gap-s2">
      <div aria-hidden="true" className="grid grid-cols-[1fr_6.5rem_1fr] px-s4 text-t12 text-navy-200">
        <span>Calls</span>
        <span className="text-center tabular-nums">Spot {fmtNumber(spot)}</span>
        <span className="text-right">Puts</span>
      </div>
      <DataTable
        caption={`${symbol} options chain: calls left of the strike, puts right. Bids sell, asks buy.`}
        columns={columns}
        rows={rows}
        rowKey={(r) => String(r.strike)}
        onRowActivate={(r) => onStrike(r.strike)}
        currentKey={currentStrike !== undefined ? String(currentStrike) : undefined}
        loading={loading}
        loadingRows={8}
        error={error}
        empty="No series listed for this expiry."
      />
      <p className="flex flex-wrap items-center gap-x-s4 gap-y-s1 px-s1 text-t12 text-navy-200">
        <span>Bid opens a sale, ask a purchase. Enter on a row opens that strike.</span>
        <span className="inline-flex items-center gap-s2">
          <span aria-hidden="true" className="h-0.5 w-3 bg-navy-400" /> closest to spot
        </span>
        {heldHere && (
          <span className="inline-flex items-center gap-s2">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-navy-50" /> you hold this series
          </span>
        )}
      </p>
    </div>
  );
}
