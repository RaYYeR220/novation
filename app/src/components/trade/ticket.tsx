'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode, type Ref } from 'react';
import { MarginMeter } from '@/components/charts/margin-meter';
import { ScenarioStrip } from '@/components/charts/scenario-strip';
import { RefusalNotice } from '@/components/app/refusal-card';
import { useNetworkStatus } from '@/components/app/network-guard';
import { useCanAct, useLiveTx } from '@/components/app/live-tx';
import { useChainClient } from '@/lib/client/context';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { NumberField } from '@/components/ui/number-field';
import { Segment, SegmentedControl } from '@/components/ui/segmented-control';
import { Tooltip } from '@/components/ui/tooltip';
import { useToast } from '@/components/ui/toast';
import { useClient } from '@/lib/client/context';
import type { WhatIfArgs } from '@/lib/client/hooks';
import type { AccountState, AgentGrant, Quote, Underlying, Vault, Venue } from '@/lib/client/types';
import { cn } from '@/lib/cn';
import { fmtDays, fmtFee, fmtNumber, fmtSeries, fmtSeriesShort, fmtSigned } from '@/lib/format';
import { fmtCloseEt, fmtEt } from '@/lib/nyse';
import { perContract } from '@/lib/margin';
import { VOL_SYNC_TXS, closedFor, closedSession, untilReopen, vaultVolText } from '@/lib/market-state';
import type { ChainSeries, Side } from './options-chain';

export type { Venue } from '@/lib/client/types';
export const OWNER = 'owner';

export interface TicketProps {
  demo: boolean;
  accountId: number;
  underlying: Underlying;
  asOf?: number;
  series?: ChainSeries;
  side: Side;
  qty: string;
  qtyError?: string;
  venue: Venue;
  signer: string;
  onSide: (s: Side) => void;
  onQty: (q: string) => void;
  onVenue: (v: Venue) => void;
  onSigner: (s: string) => void;
  onType: (isCall: boolean) => void;
  onClear: () => void;
  /** The live vault that writes this series' type, if any. */
  vault?: Vault;
  /** The vault that writes it while closed for the weekend or a holiday. */
  closedVault?: Vault;
  /** Live: the vault that writes it but can't quote until its vol catches up with the feed. */
  syncVault?: Vault;
  /** Agents with a grant on this account. */
  grants: AgentGrant[];
  /** Price per contract at the venue the ticket will use. */
  price?: number;
  now?: AccountState;
  nowGrid?: number[];
  quote?: Quote;
  args: WhatIfArgs | null;
  pending: boolean;
  quoteError?: string;
  shock: number;
  onDemoTicket?: () => void;
  headingRef?: Ref<HTMLHeadingElement>;
}

/** The largest whole size of a refused ticket that clears, searched with the same what-if. */
function useFit(args: WhatIfArgs | null, refused: boolean) {
  const client = useClient();
  return useQuery({
    queryKey: ['fit', args],
    enabled: refused && args !== null && Math.abs(args.qtyDelta) >= 2,
    queryFn: async () => {
      const a = args as WhatIfArgs;
      const size = Math.floor(Math.abs(a.qtyDelta));
      const per = perContract(a.premium, a.qtyDelta);
      const sign = Math.sign(a.qtyDelta);
      let lo = 0;
      let hi = size;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        const q = await client.whatIf(a.id, a.seriesId, sign * mid, per * mid, { agent: a.agent, venue: a.venue });
        if (q.refusal) hi = mid;
        else lo = mid;
      }
      return lo;
    },
  });
}

function Section({ title, meta, children, className }: { title: string; meta?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('grid gap-s3 border-t border-navy-700 px-s5 py-s4 max-sm:px-s4', className)}>
      <div className="flex items-baseline justify-between gap-s3">
        <h3 className="font-text text-t13 font-medium tracking-normal text-navy-50">{title}</h3>
        {meta}
      </div>
      {children}
    </section>
  );
}

export function Ticket({ headingRef, ...p }: TicketProps) {
  const { toast } = useToast();
  const net = useNetworkStatus();
  const live = useLiveTx();
  const act = useCanAct(p.accountId);
  const chain = useChainClient();
  const qc = useQueryClient();
  // live mode: a connected wallet signs only for accounts it owns or holds a grant on
  const viewOnly = !p.demo && act.connected && !act.checking && !act.canAct;
  const { series, quote, now } = p;
  const refusal = quote?.refusal;
  // live: signing syncs a vol that is behind its feed first. A vault trade is then sent; an RFQ
  // quote was checked at the old mark, so it is checked again and signed with another click.
  const volSync = refusal?.code === 'VolNotCurrent' && !p.demo;
  const volSyncNote = `Signing syncs the vol of ${refusal?.underlying ?? 'this underlying'} first (${VOL_SYNC_TXS}, which anyone may send), ${
    p.venue === 'rfq' ? 'then checks the quote again at the new mark: sign the fill once it shows.' : 'then sends this trade.'
  }`;
  const fit = useFit(p.args, Boolean(refusal) && refusal?.code !== 'VolNotCurrent');
  // an RFQ fill held back by a vol sync: say so until the ticket changes
  const ticketKey = p.args ? `${p.args.id}:${p.args.seriesId}:${p.args.qtyDelta}:${p.args.venue}:${p.args.agent ?? ''}` : '';
  const [resynced, setResynced] = useState<{ key: string; text: string } | undefined>();
  const resyncNote = resynced?.key === ticketKey ? resynced.text : undefined;
  const grant = p.grants.find((g) => g.agent === p.signer);
  const qtyNum = Number(p.qty);
  const qtyOk = !p.qtyError && Number.isFinite(qtyNum) && qtyNum > 0;
  const verb = p.side === 'buy' ? 'Buy' : 'Sell';
  const label = series ? `${verb} ${p.qty || '0'} ${series.underlying} ${fmtSeriesShort(series)}` : 'Pick a strike';
  const who = `Account ${p.accountId}, signed by ${grant ? grant.label : 'the owner wallet'}`;

  if (!series) {
    return (
      <div className="grid">
        <header className="grid gap-s2 px-s5 py-s4 max-sm:px-s4">
          <h2 ref={headingRef} tabIndex={-1} className="text-[24px] leading-tight font-normal text-navy-50 outline-none">
            No ticket open
          </h2>
          <p className="text-t13 text-pretty text-navy-200">
            Pick a bid or an ask in the chain. Before anything is signed, the kernel re-prices account {p.accountId}’s whole book
            across 39 scenarios and shows the margin after the trade.
          </p>
          {p.onDemoTicket && (
            <div className="pt-s2">
              <Button size="sm" variant="secondary" onClick={p.onDemoTicket}>
                Load the refused agent ticket
              </Button>
            </div>
          )}
        </header>
        {now && (
          <Section title={`Account ${p.accountId} margin`}>
            <MarginMeter now={now} />
          </Section>
        )}
      </div>
    );
  }

  const premium = quote?.premium;
  const per = premium !== undefined && qtyNum > 0 ? premium / qtyNum : p.price;
  const cashChange = quote ? quote.after.cash - (now?.cash ?? quote.after.cash) : undefined;
  const venueNote =
    p.venue === 'vault' && p.vault
      ? `The ${p.vault.kind === 'coveredCall' ? 'covered-call' : 'put-write'} vault fills now at the ${p.side === 'buy' ? 'ask' : 'bid'}, ${fmtNumber(p.price ?? 0)}.`
      : p.demo
        ? `Best RFQ quote: the demo maker at mid, ${fmtNumber(p.price ?? 0)}.`
        : quote?.rfq
          ? `Signed quote from maker account ${quote.rfq.makerId}: ${fmtNumber(quote.rfq.price)} per contract, checked against the kernel mark, valid until ${fmtEt(quote.rfq.expiresAt, { seconds: true })}.`
          : `No RFQ maker relay is answering: the what-if prices at the kernel mark, ${fmtNumber(p.price ?? 0)}, and the ticket can't be sent.`;
  const noVault = !p.vault;
  const closed = closedSession(p.closedVault?.session);
  const syncVault = p.demo || closed ? undefined : p.syncVault;
  const signerNote = grant
    ? `${grant.label} may leave at most ${fmtNumber(grant.maxWorstLoss)} of worst-case loss (now ${fmtNumber(now?.im ?? grant.used)}) and pay at most ${fmtNumber(grant.maxPremiumPerTrade)} premium per trade.`
    : p.grants.some((g) => !g.allowed.includes(series.underlying))
      ? `${p.grants.map((g) => `${g.label} may trade ${g.allowed.join(' and ')} only`).join('; ')}.`
      : '';
  const mult = p.underlying.uiMultiplier;
  const showMult = Math.abs(mult - 1) > 1e-9;

  const sign = () => {
    if (p.demo) {
      toast({
        tone: 'neutral',
        title: 'Checked, not sent',
        description: quote
          ? `Demo mode. ${label} clears with ${fmtNumber(quote.after.im)} USDG initial margin. On chain your wallet would sign it next.`
          : 'Demo mode. Nothing is sent.',
      });
      return;
    }
    if (net.status === 'wrong') {
      net.switchToTarget();
      return;
    }
    if (net.status === 'disconnected') {
      toast({ tone: 'neutral', title: 'Connect a wallet to sign', description: 'Use Connect wallet in the top bar.' });
      return;
    }
    if (p.venue === 'rfq' && quote?.rfq && !grant) {
      // exactly the quote shown above; if it lapsed, the ticket shows a new one before any signing
      const hash = quote.rfq.hash;
      setResynced(undefined);
      void live.run(label, (c) => c.fillRfq(p.accountId, hash)).then((r) => {
        if (!r.ok && !r.refusal) {
          chain?.dropQuote(hash);
          void qc.invalidateQueries({ queryKey: ['whatIf'] });
          if (r.volSynced) setResynced({ key: ticketKey, text: r.error });
        }
      });
      return;
    }
    if (p.venue === 'rfq') {
      toast({
        tone: 'neutral',
        title: 'No RFQ relay connected',
        description: "An RFQ fill needs a maker's signed quote. The what-if above ran on chain; buy from the vault to trade here.",
      });
      return;
    }
    if (grant) {
      toast({ tone: 'neutral', title: `${grant.label} signs with its own key`, description: 'Agents trade through the SDK or the MCP server. The owner wallet signs here.' });
      return;
    }
    if (!quote) return;
    const qty = Number(p.qty);
    // a 1% band: the vault re-prices at the block the transaction lands in
    void live.run(label, (c) =>
      p.side === 'buy' ? c.buyFromVault(p.accountId, series.id, qty, quote.premium * 1.01) : c.sellToVault(p.accountId, series.id, qty, quote.premium * 0.99),
    );
  };

  return (
    <div className="grid">
      <header className="grid gap-s1 px-s5 pb-s4 pt-s4 max-sm:px-s4">
        <div className="flex items-start justify-between gap-s3">
          <h2 ref={headingRef} tabIndex={-1} className="text-[26px] leading-tight font-normal text-navy-50 outline-none">
            {fmtSeries(series)}
          </h2>
          <div className="flex items-center gap-s2 pt-1">
            {quote && (
              <Tooltip
                side="bottom"
                align="end"
                content={
                  quote.approx
                    ? 'Estimated with a float twin of the kernel. The chain re-checks the exact figures when you sign.'
                    : p.demo
                      ? 'Exact: computed by the bit-exact kernel reference.'
                      : 'Exact: Clearinghouse.marginAfter and the risk kernel on chain, plus a simulation of the transaction.'
                }
              >
                <button type="button" className="rounded-control" aria-label={quote.approx ? 'Estimate: how it is computed' : 'Exact: how it is computed'}>
                  <Chip size="sm" lamp={quote.approx ? 'navy-400' : 'navy-200'} lampState={quote.approx ? 'ring' : 'lit'}>
                    {quote.approx ? 'Estimate' : 'Exact'}
                  </Chip>
                </button>
              </Tooltip>
            )}
            <Button size="sm" variant="ghost" onClick={p.onClear} aria-label="Close ticket">
              Close
            </Button>
          </div>
        </div>
        <p className="text-t13 tabular-nums text-navy-200">
          Expires {fmtCloseEt(series.expiry)}
          {p.asOf !== undefined && `, ${fmtDays(series.expiry, p.asOf)}`}. Delta {fmtNumber(Math.round(series.delta * 100) / 100 + 0)}.{' '}
          {showMult && (
            <Tooltip
              side="bottom"
              align="end"
              content={`Contracts are on the raw token. ERC-8056 multiplier ${mult.toFixed(6)}: one token is that many shares.`}
            >
              <button type="button" className="rounded-[2px] underline decoration-navy-400 decoration-dotted underline-offset-4">
                Share-equivalent strike {fmtNumber(series.strike / mult)}
              </button>
            </Tooltip>
          )}
        </p>
      </header>

      <div className="grid gap-s4 border-t border-navy-700 px-s5 py-s4 max-sm:px-s4">
        <div className="flex flex-wrap gap-x-s4 gap-y-s3">
          <SegmentedControl legend="Option type" size="sm" value={series.isCall ? 'call' : 'put'} onValueChange={(v) => p.onType(v === 'call')}>
            <Segment value="call">Call</Segment>
            <Segment value="put">Put</Segment>
          </SegmentedControl>
          <SegmentedControl legend="Side" size="sm" value={p.side} onValueChange={(v) => p.onSide(v as Side)}>
            <Segment value="buy">Buy</Segment>
            <Segment value="sell">Sell</Segment>
          </SegmentedControl>
        </div>
        <NumberField
          label="Quantity"
          unit="contracts"
          value={p.qty}
          onValueChange={p.onQty}
          step={1}
          min={1}
          max={100000}
          busy={p.pending}
          error={p.qtyError}
        />
        <div className="grid gap-s2">
          <div className="flex flex-wrap gap-x-s5 gap-y-s3">
            <SegmentedControl legend="Venue" showLegend size="sm" value={p.venue} onValueChange={(v) => p.onVenue(v as Venue)}>
              <Segment value="vault" disabled={noVault}>
                Vault
              </Segment>
              <Segment value="rfq">RFQ</Segment>
            </SegmentedControl>
            {p.grants.length > 0 && (
              <SegmentedControl legend="Sign as" showLegend size="sm" value={p.signer} onValueChange={p.onSigner}>
                <Segment value={OWNER}>Owner</Segment>
                {p.grants.map((g) => (
                  <Segment key={g.agent} value={g.agent} disabled={!g.allowed.includes(series.underlying)}>
                    {g.label}
                  </Segment>
                ))}
              </SegmentedControl>
            )}
          </div>
          <p className="text-t12 text-pretty text-navy-200">
            {noVault
              ? closed
                ? `The ${series.underlying} ${series.isCall ? 'covered-call' : 'put-write'} vault is closed for ${closedFor(closed)}: no vault quotes ${untilReopen(p.asOf)}. `
                : syncVault
                  ? `The ${series.underlying} ${series.isCall ? 'covered-call' : 'put-write'} vault can't quote until its vol catches up. ${vaultVolText(series.underlying, syncVault.volBehind)} `
                  : `No vault writes ${series.underlying} ${series.isCall ? 'calls' : 'puts'}. `
              : ''}
            {venueNote} {signerNote}
          </p>
          {noVault && syncVault && (
            <div>
              <Button
                size="sm"
                variant="secondary"
                loading={live.busy}
                loadingLabel="Syncing"
                onClick={() => void live.run(`Sync the vol of ${series.underlying}`, (c) => c.syncVol(series.underlying))}
              >
                Sync {series.underlying} vol
              </Button>
            </div>
          )}
        </div>
      </div>

      <dl className={cn('grid grid-cols-3 border-t border-navy-700 px-s5 py-s3 max-sm:px-s4', p.pending && 'opacity-80')}>
        {p.quoteError ? (
          <p role="alert" className="col-span-3 text-t13 text-loss-1">
            {p.quoteError}
          </p>
        ) : (
          [
            {
              k: p.side === 'buy' ? 'You pay' : 'You receive',
              v: premium !== undefined ? fmtNumber(premium) : '—',
              sub: per !== undefined && qtyOk ? `${fmtNumber(per)} each` : undefined,
            },
            { k: 'Fee', v: quote ? fmtFee(quote.fee) : '—', sub: undefined },
            {
              k: 'Cash after',
              v: quote ? fmtNumber(quote.after.cash) : '—',
              sub: cashChange !== undefined ? fmtSigned(cashChange) : undefined,
            },
          ].map((c, i) => (
            <div key={c.k} className={cn('grid content-start gap-0.5', i > 0 && 'border-l border-navy-800 pl-s3', i < 2 && 'pr-s3')}>
              <dt className="text-t12 text-navy-200">{c.k}</dt>
              <dd className="text-t15 font-semibold tabular-nums text-navy-50">{c.v}</dd>
              {c.sub && <dd className="text-t12 tabular-nums text-navy-200">{c.sub}</dd>}
            </div>
          ))
        )}
      </dl>

      {refusal && (
        <div className="border-t border-navy-700 p-s3">
          <RefusalNotice
            unit=""
            refusal={refusal}
            who={who}
            agentLabel={grant?.label}
            hint={
              volSync
                ? volSyncNote
                : fit.data !== undefined && fit.data > 0
                  ? `Up to ${fmtNumber(fit.data, 0)} contracts clear the same checks. Cut the size${refusal.code.startsWith('Agent') ? ', or sign from the owner wallet' : ', or deposit USDG'}.`
                  : undefined
            }
            action={
              fit.data !== undefined && fit.data > 0 ? (
                <Button size="sm" variant="secondary" onClick={() => p.onQty(String(fit.data))}>
                  Cut to {fmtNumber(fit.data, 0)}
                </Button>
              ) : undefined
            }
          />
        </div>
      )}
      {now && (
        <Section
          title="Margin"
          meta={<span className="text-t12 text-navy-200">now and after this ticket</span>}
        >
          <MarginMeter now={now} after={quote?.after} pending={p.pending} estimate={quote?.approx} />
        </Section>
      )}

      {p.nowGrid && (
        <Section title="Scenarios" meta={<span className="text-t12 text-navy-200">39 kernel shocks, whole book</span>}>
          <ScenarioStrip
            grids={[
              { name: 'Now', cells: p.nowGrid, worst: now?.worstScenario },
              ...(quote?.afterGrid
                ? [{ name: 'After', cells: quote.afterGrid, worst: quote.after.worstScenario, estimate: Boolean(quote.approx) }]
                : []),
            ]}
            range={{ symbol: series.underlying, value: p.shock }}
          />
        </Section>
      )}

      <div className="grid gap-s4 border-t border-navy-700 px-s5 py-s4 max-sm:px-s4">
        <div className="grid gap-s2">
          <Button
            variant="primary"
            size="lg"
            lamp
            disabled={!qtyOk || !quote || (Boolean(refusal) && !volSync) || p.pending || viewOnly}
            loading={live.busy}
            loadingLabel="Signing"
            onClick={sign}
            className="w-full"
          >
            {label}
          </Button>
          {resyncNote && (
            <p role="status" data-state="vol-synced" className="text-t13 text-pretty text-navy-50">
              {resyncNote}
            </p>
          )}
          <p className="text-t12 text-navy-200">
            {p.pending
              ? 'Checking the ticket again before it can be signed.'
              : refusal
                ? volSync
                  ? volSyncNote
                  : 'Refused before signing. Change the ticket and the check runs again.'
                : p.demo
                ? 'Demo mode: the ticket is checked, nothing is sent.'
                : viewOnly
                  ? `View only: this wallet neither owns account ${p.accountId} nor holds an agent grant on it.`
                  : p.venue === 'rfq' && !quote?.rfq
                  ? 'Checked on chain. An RFQ fill needs a signed maker quote, and no relay is answering.'
                  : 'Your wallet signs; the Clearinghouse re-runs the same margin check on chain.'}
          </p>
          <p className="text-t12 text-navy-200">Stock tokens are not available to US persons.</p>
        </div>
      </div>
    </div>
  );
}
