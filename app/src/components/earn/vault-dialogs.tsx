'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { NumberField } from '@/components/ui/number-field';
import { Segment, SegmentedControl } from '@/components/ui/segmented-control';
import { useToast } from '@/components/ui/toast';
import type { VaultDetail, VaultHolding } from '@/lib/client/types';
import { fmtDuration, fmtNumber, fmtQty } from '@/lib/format';
import { fmtCloseEt, fmtEt } from '@/lib/nyse';

/** Parses an amount typed into a field; the error says what to fix. */
export function parseAmount(raw: string, max: number, unit: string, maxLabel: string): { value: number; error?: string } {
  const t = raw.replace(/,/g, '').trim();
  if (t === '') return { value: 0, error: 'Enter an amount.' };
  if (!/^\d*\.?\d*$/.test(t)) return { value: 0, error: 'Numbers only.' };
  const v = Number(t);
  if (!Number.isFinite(v) || v <= 0) return { value: 0, error: 'The amount must be above zero.' };
  if (v > max + 1e-9) return { value: v, error: `That is more than ${maxLabel}: ${fmtQty(max)} ${unit}.` };
  return { value: v };
}

interface Common {
  vault: VaultDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  asOf: number;
  demo: boolean;
}

/** Deposit at live NAV. ERC-4626 deposit: shares = assets / NAV per share, then a one-hour exit cooldown. */
export function DepositDialog({ vault, open, onOpenChange, asOf, demo, balance }: Common & { balance: number }) {
  const [raw, setRaw] = useState('');
  const [touched, setTouched] = useState(false);
  const { toast } = useToast();
  const unit = vault.asset;
  const parsed = parseAmount(raw, balance, unit, 'your wallet holds');
  const notLive = !vault.live;
  const error = notLive ? 'The vault is not live: deposits are closed until its underlying trades normally again.' : touched ? parsed.error : undefined;
  const shares = parsed.error ? 0 : parsed.value / vault.navPerShare;
  const submit = () => {
    setTouched(true);
    if (parsed.error || notLive) return;
    toast({
      tone: 'neutral',
      title: demo ? 'Checked, not sent' : 'Deposit sent',
      description: demo
        ? `Depositing ${fmtQty(parsed.value)} ${unit} would mint ${fmtNumber(shares, 4)} ${vault.symbol} at ${fmtNumber(vault.navPerShare, 6)}. Nothing is sent in the demo.`
        : `${fmtQty(parsed.value)} ${unit} into ${vault.symbol}.`,
    });
    onOpenChange(false);
    setRaw('');
    setTouched(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setTouched(false);
      }}
      title={`Deposit into ${vault.symbol}`}
      description={`Priced at the vault's live NAV: ${fmtNumber(vault.navPerShare, 6)} ${unit} per share, from the kernel's marks right now.`}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" lamp onClick={submit} disabled={notLive}>
            {parsed.error ? 'Deposit' : `Deposit ${fmtQty(parsed.value)} ${unit}`}
          </Button>
        </>
      }
    >
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="grid gap-s4"
      >
        <NumberField
          label="Amount"
          unit={unit}
          value={raw}
          onValueChange={(v) => {
            setRaw(v);
            setTouched(true);
          }}
          step={1}
          min={0}
          max={balance}
          hint={`Your wallet: ${fmtQty(balance)} ${unit}.`}
          error={error}
          data-autofocus=""
        />
        <dl className="grid grid-cols-2 gap-s3 text-t13 tabular-nums">
          <div className="grid gap-0.5">
            <dt className="text-t12 text-navy-200">You receive</dt>
            <dd className="text-t17 font-semibold text-navy-50">
              {fmtNumber(shares, 4)} <span className="text-t13 font-normal text-navy-200">shares</span>
            </dd>
          </div>
          <div className="grid gap-0.5">
            <dt className="text-t12 text-navy-200">Exits open</dt>
            <dd className="text-t15 text-navy-50">{fmtEt(asOf + vault.cooldown)}</dd>
          </div>
        </dl>
        <p className="text-t13 text-pretty text-navy-200">
          Shares can&apos;t leave for {fmtDuration(vault.cooldown)} after they arrive, so a deposit can&apos;t be timed against the next mark.
          {vault.kind === 'coveredCall'
            ? ` Your ${unit} backs calls the vault sells; at most ${fmtNumber(vault.utilization * 100, 0)}% of the vault is locked behind open shorts now.`
            : ' Your USDG secures puts the vault sells: strike times contracts never exceeds the cash it holds.'}
        </p>
      </form>
    </Dialog>
  );
}

/**
 * Withdraw now (up to the free assets, net of the redemption queue) or request a redemption paid
 * at the next roll. Both wait out the exit cooldown.
 */
export function WithdrawDialog({ vault, open, onOpenChange, asOf, demo, holding }: Common & { holding?: VaultHolding }) {
  const [mode, setMode] = useState<'now' | 'queue'>('now');
  const [raw, setRaw] = useState('');
  const [touched, setTouched] = useState(false);
  const { toast } = useToast();
  const unit = vault.asset;
  const shares = holding?.shares ?? 0;
  const own = shares * vault.navPerShare;
  const coolUntil = (holding?.lastReceive ?? 0) + vault.cooldown;
  const cooling = holding !== undefined && asOf < coolUntil;
  const instantMax = Math.min(own, vault.free);
  const max = mode === 'now' ? instantMax : own;
  const parsed = parseAmount(raw, max, unit, mode === 'now' ? 'can leave now' : 'your shares are worth');
  const gate = !holding || shares <= 0
    ? 'This wallet holds no shares of this vault.'
    : cooling
      ? `Your shares arrived ${fmtEt(holding.lastReceive)}. Exits open ${fmtEt(coolUntil)}, ${fmtDuration(coolUntil - asOf)} from now.`
      : !vault.live
        ? 'The vault is not live; instant withdrawals wait. A redemption request still queues.'
        : undefined;
  const blocked = Boolean(gate) && !(mode === 'queue' && !vault.live && !cooling && shares > 0);
  const error = gate ?? (touched ? parsed.error : undefined);
  const burn = parsed.error ? 0 : parsed.value / vault.navPerShare;
  const submit = () => {
    setTouched(true);
    if (blocked || parsed.error) return;
    toast({
      tone: 'neutral',
      title: demo ? 'Checked, not sent' : mode === 'now' ? 'Withdrawal sent' : 'Redemption requested',
      description:
        mode === 'now'
          ? `${fmtQty(parsed.value)} ${unit} now for ${fmtNumber(burn, 4)} shares at ${fmtNumber(vault.navPerShare, 6)}.${demo ? ' Nothing is sent in the demo.' : ''}`
          : `${fmtNumber(burn, 4)} shares queued for the roll after ${fmtCloseEt(vault.nextRoll)}, paid at the NAV then.${demo ? ' Nothing is sent in the demo.' : ''}`,
    });
    onOpenChange(false);
    setRaw('');
    setTouched(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setTouched(false);
      }}
      title={`Withdraw from ${vault.symbol}`}
      description={`Your ${fmtNumber(shares, 4)} shares are worth ${fmtQty(own)} ${unit} at the live NAV.`}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" lamp onClick={submit} disabled={blocked}>
            {mode === 'now' ? 'Withdraw' : 'Request redemption'}
          </Button>
        </>
      }
    >
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="grid gap-s4"
      >
        <SegmentedControl legend="How" showLegend size="sm" value={mode} onValueChange={(v) => setMode(v as 'now' | 'queue')}>
          <Segment value="now">Withdraw now</Segment>
          <Segment value="queue">Request redemption</Segment>
        </SegmentedControl>
        <NumberField
          label="Amount"
          unit={unit}
          value={raw}
          onValueChange={(v) => {
            setRaw(v);
            setTouched(true);
          }}
          step={1}
          min={0}
          max={max}
          hint={
            mode === 'now'
              ? `Up to ${fmtQty(instantMax)} ${unit} now: the vault's free assets after open shorts and the queue are ${fmtQty(vault.free)} ${unit}.`
              : `Queued shares are paid by the roll after the ${fmtCloseEt(vault.nextRoll)} expiry settles, at the NAV then.`
          }
          error={error}
          disabled={blocked}
        />
        <p className="text-t13 text-pretty text-navy-200">
          {mode === 'now'
            ? 'Instant withdrawals take only what open shorts and the redemption queue leave free. The rest waits for a roll.'
            : 'The roll pays the queue from assets the settled expiry frees. Once requested, the queue’s claim is reserved: new sales and instant withdrawals can’t use it.'}
          {holding && holding.pendingShares > 0 && (
            <>
              {' '}
              You already have <span className="tabular-nums text-navy-50">{fmtNumber(holding.pendingShares, 2)}</span> shares queued.
            </>
          )}
        </p>
      </form>
    </Dialog>
  );
}
