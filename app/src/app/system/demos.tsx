'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { DataTable, type Column } from '@/components/ui/data-table';
import { Dialog, DialogSurface } from '@/components/ui/dialog';
import { Segment, SegmentedControl } from '@/components/ui/segmented-control';
import { Toast, ToastProvider, useToast } from '@/components/ui/toast';
import { fmtNumber, fmtSigned, SESSION_LABEL } from '@/lib/format';
import type { Session } from '@/lib/client/types';
import account7 from '@/fixtures/account7.json';
import chains from '@/fixtures/chains.json';

/* ---------- segmented control, live ---------- */

export function LiveSessionSwitch() {
  const [session, setSession] = useState<Session>('REGULAR');
  const im = session === 'WEEKEND' ? account7.summary.im_weekend : account7.summary.im_regular;
  return (
    <div className="grid gap-s3">
      <SegmentedControl legend="Market session" value={session} onValueChange={(v) => setSession(v as Session)}>
        <Segment value="REGULAR">Regular</Segment>
        <Segment value="WEEKEND">Weekend</Segment>
      </SegmentedControl>
      <p className="text-t13 text-navy-200" aria-live="polite">
        {SESSION_LABEL[session]} initial margin, account 7:{' '}
        <span className="font-semibold tabular-nums text-navy-50">{fmtNumber(im)}</span> USDG
      </p>
    </div>
  );
}

/* ---------- data tables ---------- */

type Position = (typeof account7.account.positions)[number];
type ChainRow = (typeof chains.NVDA.series)[number];

const expiry = (t: number) =>
  new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

const positionColumns: Column<Position>[] = [
  {
    key: 'series',
    header: 'Series',
    cell: (p) => (
      <span className="font-medium">
        {p.underlying} {p.strike} {p.isCall ? 'call' : 'put'}
      </span>
    ),
  },
  { key: 'expiry', header: 'Expiry', cell: (p) => <span className="text-navy-200">{expiry(p.expiry)}</span> },
  { key: 'qty', header: 'Qty', numeric: true, cell: (p) => fmtSigned(p.qty, 0) },
  { key: 'mark', header: 'Mark', numeric: true, cell: (p) => fmtNumber(p.mark) },
];

const chainColumns: Column<ChainRow>[] = [
  { key: 'strike', header: 'Strike', cell: (r) => <span className="font-medium">{fmtNumber(r.strike, 0)}</span> },
  { key: 'type', header: 'Type', cell: (r) => <span className="text-navy-200">{r.isCall ? 'Call' : 'Put'}</span> },
  { key: 'expiry', header: 'Expiry', cell: (r) => <span className="text-navy-200">{expiry(r.expiry)}</span> },
  { key: 'bid', header: 'Bid', numeric: true, cell: (r) => fmtNumber(r.bid) },
  { key: 'ask', header: 'Ask', numeric: true, cell: (r) => fmtNumber(r.ask) },
  // Round first so a tiny negative delta reads 0.000, not −0.000.
  { key: 'delta', header: 'Delta', numeric: true, cell: (r) => fmtSigned(Number(r.delta.toFixed(3)), 3) },
  { key: 'iv', header: 'IV', numeric: true, cell: (r) => `${fmtNumber(r.iv * 100, 1)}%` },
];

const positions = account7.account.positions;
const nvdaChain = chains.NVDA.series.filter((s) => s.expiry === chains.NVDA.expiries[0]);

export function PositionsTable({
  current,
  forceRow,
  caption = 'Open positions, account 7',
}: {
  current?: string;
  forceRow?: { key: string; state: 'hover' | 'focus' };
  caption?: string;
}) {
  const [picked, setPicked] = useState<string | undefined>(current);
  return (
    <DataTable
      caption={caption}
      columns={positionColumns}
      rows={positions}
      rowKey={(p) => String(p.seriesId)}
      onRowActivate={(p) => setPicked(String(p.seriesId))}
      currentKey={picked}
      forceRow={forceRow}
    />
  );
}

export function ChainTable() {
  return (
    <DataTable
      caption={`NVDA chain, nearest expiry, ${nvdaChain.length} series`}
      showCaption
      columns={chainColumns}
      rows={nvdaChain}
      rowKey={(r) => String(r.id)}
      maxHeight={296}
    />
  );
}

export function TableStates() {
  return (
    <div className="grid gap-s5 md:grid-cols-3">
      <DataTable caption="Positions, loading" columns={positionColumns} rows={[]} rowKey={() => ''} loading loadingRows={3} />
      <DataTable
        caption="Positions, empty"
        columns={positionColumns}
        rows={[]}
        rowKey={() => ''}
        empty="No open positions. Trades you place show up here."
      />
      <DataTable
        caption="Positions, error"
        columns={positionColumns}
        rows={positions}
        rowKey={(p) => String(p.seriesId)}
        error="Positions could not be read from the clearinghouse. Retrying on the next block."
      />
    </div>
  );
}

/* ---------- toasts ---------- */

function ToastButtons() {
  const { toast } = useToast();
  return (
    <div className="flex flex-wrap gap-s3">
      <Button
        onClick={() =>
          toast({ tone: 'done', title: 'Deposit cleared', description: '2,400.00 USDG added to account 7.' })
        }
      >
        Show cleared
      </Button>
      <Button
        onClick={() =>
          toast({
            tone: 'refused',
            title: 'Trade refused',
            description: 'AgentRiskBudgetExceeded: worst case 1,612.40, budget 1,500.00.',
          })
        }
      >
        Show refused
      </Button>
      <Button onClick={() => toast({ tone: 'pending', title: 'Submitting trade', duration: 4000 })}>Show pending</Button>
    </div>
  );
}

export function ToastDemo() {
  return (
    <ToastProvider>
      <div className="grid gap-s5 lg:grid-cols-[minmax(0,380px)_1fr] lg:items-start">
        <div className="grid gap-s2">
          <Toast tone="done" title="Deposit cleared" description="2,400.00 USDG added to account 7." onDismiss={() => {}} />
          <Toast
            tone="refused"
            title="Trade refused"
            description="AgentRiskBudgetExceeded: worst case 1,612.40, budget 1,500.00."
            onDismiss={() => {}}
          />
          <Toast tone="pending" title="Submitting trade" description="Waiting for the sequencer." />
          <Toast tone="neutral" title="Session changed" description="NVDA moved to Weekend. Shocks widen." onDismiss={() => {}} />
        </div>
        <div className="grid gap-s3">
          <p className="text-t13 text-navy-200">
            Live: toasts stack bottom right, pause while hovered or focused, and leave after six seconds. Escape closes a
            focused one.
          </p>
          <ToastButtons />
        </div>
      </div>
    </ToastProvider>
  );
}

/* ---------- dialog ---------- */

const revokeCopy = {
  title: 'Revoke hedge-bot?',
  description:
    'hedge-bot stops trading for account 7 as soon as this clears. Its open positions stay where they are; nothing is closed for you.',
};

export function DialogPreview() {
  return (
    <div
      role="group"
      aria-label="Static preview of the confirm dialog"
      className="max-w-[560px] rounded-control border border-navy-600 bg-navy-900"
    >
      <DialogSurface
        title={revokeCopy.title}
        titleId="system-dialog-preview-title"
        description={revokeCopy.description}
        onClose={() => {}}
        footer={
          <>
            <Button data-force="focus">Keep grant</Button>
            <Button variant="primary">Revoke grant</Button>
          </>
        }
      />
    </div>
  );
}

export function DialogDemo() {
  const [open, setOpen] = useState(false);
  const [revoked, setRevoked] = useState(false);
  return (
    <div className="grid content-start gap-s3">
      <p className="text-t13 text-navy-200">
        Live: opens on the native dialog, keeps focus inside, Escape or the close button returns focus here. The safe
        action gets focus first.
      </p>
      <div className="flex flex-wrap items-center gap-s4">
        <Button onClick={() => setOpen(true)} disabled={revoked}>
          Revoke hedge-bot
        </Button>
        {revoked && (
          <Button variant="ghost" size="sm" onClick={() => setRevoked(false)}>
            Reset demo
          </Button>
        )}
      </div>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        dismissible={false}
        title={revokeCopy.title}
        description={revokeCopy.description}
        footer={
          <>
            <Button data-autofocus onClick={() => setOpen(false)}>
              Keep grant
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setRevoked(true);
                setOpen(false);
              }}
            >
              Revoke grant
            </Button>
          </>
        }
      />
    </div>
  );
}
