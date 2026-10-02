'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { NumberField } from '@/components/ui/number-field';
import { Segment, SegmentedControl } from '@/components/ui/segmented-control';
import { useToast } from '@/components/ui/toast';
import { useLiveTx } from '@/components/app/live-tx';
import { EXIT_SLIPPAGE_BPS } from '@/lib/client/chain';
import { useExitPreview } from '@/lib/client/hooks';
import type { ExitPreview, VaultDetail, VaultHolding } from '@/lib/client/types';
import { fmtDuration, fmtNumber, fmtQty } from '@/lib/format';
import { fmtCloseEt, fmtEt } from '@/lib/nyse';

/** Why a vault's deposits and instant exits wait for an expired series to settle, in a sentence or two. */
export function settlementWaitText(vault: Pick<VaultDetail, 'settlementWait'>): string | undefined {
  const w = vault.settlementWait;
  if (!w) return undefined;
  const which = w.expiries.length ? `the ${w.expiries.map(fmtCloseEt).join(' and ')} expiry` : 'an earlier expiry';
  if (w.rollable) {
    return `The vault still holds options from ${which}. They have a settlement price but are not settled into the vault yet, so deposits and instant exits wait until a roll settles them; anyone can send the roll now.`;
  }
  return `The vault still holds options from ${which}, which has no settlement price yet. Deposits and instant exits wait for it${
    w.until !== undefined ? `, at the latest until ${fmtEt(w.until)}` : ''
  }.`;
}

/** "1.94 NVDA + 13.80 USDG": both parts of an exit; the USDG part only when there is one. */
export function fmtExit(p: Pick<ExitPreview, 'tokens' | 'cash'>, asset: string): string {
  if (asset === 'USDG') return `${fmtNumber(p.tokens + p.cash)} USDG`;
  return p.cash > 0 ? `${fmtQty(p.tokens)} ${asset} + ${fmtNumber(p.cash)} USDG` : `${fmtQty(p.tokens)} ${asset}`;
}

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
  const waiting = Boolean(vault.settlementWait);
  const notLive = !vault.live || waiting;
  const error = !vault.live
    ? 'The vault is not live: deposits are closed until its underlying trades normally again.'
    : waiting
      ? 'Deposits wait for settlement: the vault holds an expired series not yet settled into it, so its NAV is not final.'
      : touched
        ? parsed.error
        : undefined;
  const shares = parsed.error ? 0 : parsed.value / vault.navPerShare;
  const live = useLiveTx();
  const submit = async () => {
    setTouched(true);
    if (parsed.error || notLive) return;
    if (!demo) {
      const r = await live.run(`Deposit ${fmtQty(parsed.value)} ${unit} into ${vault.symbol}`, (c) => c.vaultDeposit(vault.address, parsed.value));
      if (!r.ok) return;
      onOpenChange(false);
      setRaw('');
      setTouched(false);
      return;
    }
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
      description={`Priced at the vault's live NAV: ${fmtNumber(vault.navPerShare, 6)} ${unit} per share, from the kernel's marks ${demo ? 'at the demo snapshot' : 'right now'}.`}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" lamp onClick={() => void submit()} disabled={notLive} loading={live.busy} loadingLabel="Depositing">
            {parsed.error ? 'Deposit' : `Deposit ${fmtQty(parsed.value)} ${unit}`}
          </Button>
        </>
      }
    >
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
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
 * at the next roll. Both wait out the exit cooldown. A covered-call vault pays exits in kind: the
 * holder's share of its USDG premium cash in USDG, the rest in the stock token. Both parts come from
 * the vault's own previewRedeemInKind, and a live exit is sent as redeemInKind with a floor on each.
 */
export function WithdrawDialog({ vault, open, onOpenChange, asOf, demo, holding, owner }: Common & { holding?: VaultHolding; owner?: string }) {
  const [mode, setMode] = useState<'now' | 'queue'>('now');
  const [raw, setRaw] = useState('');
  const [touched, setTouched] = useState(false);
  const { toast } = useToast();
  const unit = vault.asset;
  const shares = holding?.shares ?? 0;
  const own = shares * vault.navPerShare;
  const coolUntil = (holding?.lastReceive ?? 0) + vault.cooldown;
  const cooling = holding !== undefined && asOf < coolUntil;
  const waiting = Boolean(vault.settlementWait);
  const instantMax = Math.min(own, holding?.maxExit ?? vault.free);
  const max = mode === 'now' ? instantMax : own;
  const parsed = parseAmount(raw, max, unit, mode === 'now' ? 'can leave now' : 'your shares are worth');
  const noShares = !holding || shares <= 0;
  // queuing reads no price: it waits only for the cooldown
  const queueGate = noShares
    ? 'This wallet holds no shares of this vault.'
    : cooling
      ? `Your shares arrived ${fmtEt(holding.lastReceive)}. Exits open ${fmtEt(coolUntil)}, ${fmtDuration(coolUntil - asOf)} from now.`
      : undefined;
  const nowGate =
    queueGate ??
    (!vault.live
      ? 'The vault is not live; instant withdrawals wait. A redemption request still queues.'
      : waiting
        ? 'Instant exits wait for the expired series to settle. A redemption request still queues.'
        : undefined);
  const gate = mode === 'now' ? nowGate : (queueGate ?? (!vault.live ? 'The vault is not live; instant withdrawals wait. A redemption request still queues.' : undefined));
  const blocked = mode === 'now' ? Boolean(nowGate) : Boolean(queueGate);
  const error = gate ?? (touched ? parsed.error : undefined);
  const value = parsed.error ? undefined : parsed.value;
  const preview = useExitPreview(vault.address, value, owner);
  const legs = value !== undefined ? preview.data : undefined;
  const burn = legs?.shares ?? (value !== undefined ? value / vault.navPerShare : 0);
  const floor = (x: number) => x * (1 - EXIT_SLIPPAGE_BPS / 10_000);
  const live = useLiveTx();
  const close = () => {
    onOpenChange(false);
    setRaw('');
    setTouched(false);
  };
  const submit = async () => {
    setTouched(true);
    if (blocked || parsed.error) return;
    const amount = parsed.value;
    if (!demo) {
      const r = await live.run(
        mode === 'now' ? `Withdraw ${fmtQty(amount)} ${unit} of value from ${vault.symbol}` : `Queue ${fmtNumber(burn, 4)} ${vault.symbol} for the next roll`,
        (c) => (mode === 'now' ? c.vaultRedeemInKind(vault.address, amount) : c.requestRedeem(vault.address, amount)),
      );
      if (r.ok) close();
      return;
    }
    toast({
      tone: 'neutral',
      title: 'Checked, not sent',
      description:
        mode === 'now'
          ? `${legs ? fmtExit(legs, unit) : `${fmtQty(amount)} ${unit}`} now for ${fmtNumber(burn, 4)} shares at ${fmtNumber(vault.navPerShare, 6)}. Nothing is sent in the demo.`
          : `${fmtNumber(burn, 4)} shares queued for the roll after ${fmtCloseEt(vault.nextRoll)}, paid at the NAV then. Nothing is sent in the demo.`,
    });
    close();
  };
  const inKind = vault.kind === 'coveredCall';
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
          <Button variant="primary" lamp onClick={() => void submit()} disabled={blocked} loading={live.busy} loadingLabel="Sending">
            {mode === 'now' ? 'Withdraw' : 'Request redemption'}
          </Button>
        </>
      }
    >
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="grid gap-s4"
      >
        <SegmentedControl legend="How" showLegend size="sm" value={mode} onValueChange={(v) => setMode(v as 'now' | 'queue')}>
          <Segment value="now">Withdraw now</Segment>
          <Segment value="queue">Request redemption</Segment>
        </SegmentedControl>
        {waiting && (
          <div role="status" data-state="settlement-wait" className="grid gap-s1 rounded-[4px] border border-navy-700 bg-navy-800 px-s3 py-s2 text-t13">
            <p className="font-semibold text-navy-50">Waiting for settlement</p>
            <p className="text-pretty text-navy-200">{settlementWaitText(vault)}</p>
          </div>
        )}
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
              ? `Value at NAV, up to ${fmtQty(instantMax)} ${unit} now: the vault's free assets after open shorts and the queue are ${fmtQty(vault.free)} ${unit}.`
              : `Queued shares are paid by the roll after the ${fmtCloseEt(vault.nextRoll)} expiry settles, at the NAV then.`
          }
          error={error}
          disabled={blocked}
        />
        {legs && !blocked && (
          <dl className="grid grid-cols-2 gap-s3 text-t13 tabular-nums" data-exit-preview="">
            <div className="grid gap-0.5">
              <dt className="text-t12 text-navy-200">{mode === 'now' ? 'You receive' : 'Worth now'}</dt>
              <dd className="text-t17 font-semibold text-navy-50">{fmtExit(legs, unit)}</dd>
            </div>
            <div className="grid gap-0.5">
              <dt className="text-t12 text-navy-200">Shares</dt>
              <dd className="text-t15 text-navy-50">{fmtNumber(legs.shares, 4)}</dd>
            </div>
          </dl>
        )}
        <p className="text-t13 text-pretty text-navy-200">
          {mode === 'now'
            ? 'Instant withdrawals take only what open shorts and the redemption queue leave free. The rest waits for a roll.'
            : 'The roll pays the queue from assets the settled expiry frees. Once requested, the queue’s claim is reserved: new sales and instant withdrawals can’t use it.'}
          {inKind && ` Exits are paid in kind: your share of the vault's USDG premium cash comes in USDG, the rest in ${unit}${mode === 'queue' ? ', and each part is claimed after the roll' : ''}.`}
          {mode === 'now' && legs && !blocked && !demo && (
            <>
              {' '}
              Sent with a floor {fmtNumber(EXIT_SLIPPAGE_BPS / 100, 0)}% under each part: the exit reverts rather than pay less than{' '}
              <span className="tabular-nums text-navy-50">{fmtExit({ tokens: floor(legs.tokens), cash: floor(legs.cash) }, unit)}</span>.
            </>
          )}
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
