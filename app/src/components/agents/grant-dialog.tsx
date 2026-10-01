'use client';

import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Lamp } from '@/components/ui/lamp';
import { NumberField } from '@/components/ui/number-field';
import { Segment, SegmentedControl } from '@/components/ui/segmented-control';
import type { NewGrant } from '@/lib/client/types';
import { cn } from '@/lib/cn';
import { fmtNumber } from '@/lib/format';
import { fmtEt } from '@/lib/nyse';

const DAY = 86400;
const TERMS = [
  { v: '1', label: '1 day' },
  { v: '7', label: '7 days' },
  { v: '30', label: '30 days' },
  { v: '90', label: '90 days' },
];

function TextField({
  label,
  value,
  onChange,
  error,
  hint,
  placeholder,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: string;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const id = useId();
  return (
    <div className="grid min-w-0 gap-s2">
      <label htmlFor={id} className="text-t13 font-medium text-navy-200">
        {label}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        data-autofocus={autoFocus ? '' : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-e` : hint ? `${id}-h` : undefined}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'h-10 min-w-0 rounded-control border bg-navy-950 px-s3 text-t15 text-navy-50 outline-offset-2 placeholder:text-navy-400',
          error ? 'border-loss-2' : 'border-navy-600 ui-hover:border-navy-400',
        )}
      />
      {error ? (
        <p id={`${id}-e`} className="flex items-center gap-s2 text-t12 text-loss-1">
          <Lamp tone="loss-2" size={6} />
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-h`} className="text-t12 text-navy-200">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface GrantDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: number;
  owner: string;
  /** The account's worst-case loss now (its initial margin). */
  worstNow: number;
  underlyings: string[];
  asOf: number;
  busy: boolean;
  onGrant: (g: NewGrant) => void;
}

/** grantAgent(id, agent, {maxWorstLoss, maxPremiumPerTrade, allowedUnderlyingsMask, expiresAt}), checked the way the contract checks it. */
export function GrantDialog({ open, onOpenChange, accountId, owner, worstNow, underlyings, asOf, busy, onGrant }: GrantDialogProps) {
  const [label, setLabel] = useState('');
  const [agent, setAgent] = useState('');
  const [budget, setBudget] = useState('1000');
  const [cap, setCap] = useState('250');
  const [allowed, setAllowed] = useState<string[]>(['NVDA']);
  const [term, setTerm] = useState('7');
  const [tried, setTried] = useState(false);

  const num = (s: string) => Number(s.replace(/,/g, '').trim());
  const errors = {
    label: label.trim() === '' ? 'Name the agent, so refusals say who signed.' : undefined,
    agent: !/^0x[0-9a-fA-F]{40}$/.test(agent.trim())
      ? 'Enter the agent’s address: 0x and 40 hex characters.'
      : /^0x0{40}$/.test(agent.trim())
        ? 'The zero address can’t sign.'
        : agent.trim().toLowerCase() === owner.toLowerCase()
          ? 'That is the owner. The owner already signs without a grant.'
          : undefined,
    budget: !(num(budget) > 0) ? 'Set a risk budget above zero.' : undefined,
    cap: !(num(cap) > 0) ? 'Set a per-trade premium cap above zero.' : undefined,
    allowed: allowed.length === 0 ? 'Allow at least one underlying.' : undefined,
  };
  const valid = Object.values(errors).every((e) => !e);
  const tight = num(budget) > 0 && num(budget) < worstNow;
  const expiresAt = asOf + Number(term) * DAY;
  const show = (k: keyof typeof errors) => (tried ? errors[k] : undefined);
  const submit = () => {
    setTried(true);
    if (!valid) return;
    onGrant({
      agent: agent.trim(),
      label: label.trim(),
      maxWorstLoss: num(budget),
      maxPremiumPerTrade: num(cap),
      allowed,
      expiresAt,
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setTried(false);
      }}
      title={`Grant an agent on account ${accountId}`}
      description="The agent can trade for this account through the venues, never withdraw or grant others. The chain refuses any trade it signs that breaks these limits."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" lamp onClick={submit} loading={busy}>
            Grant {label.trim() || 'agent'}
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
        <div className="grid gap-s4 sm:grid-cols-2">
          <TextField label="Name" value={label} onChange={setLabel} error={show('label')} placeholder="hedge-bot" autoFocus />
          <TextField label="Agent address" value={agent} onChange={setAgent} error={show('agent')} placeholder="0x…" />
        </div>
        <div className="grid gap-s4 sm:grid-cols-2">
          <NumberField
            label="Risk budget"
            unit="USDG"
            value={budget}
            onValueChange={setBudget}
            step={100}
            min={0}
            error={show('budget')}
            hint={
              tight
                ? `Under the account's worst case now (${fmtNumber(worstNow)}): the agent could only cut risk.`
                : `Caps the account's worst-case loss after its trades. Now: ${fmtNumber(worstNow)}.`
            }
          />
          <NumberField
            label="Premium cap per trade"
            unit="USDG"
            value={cap}
            onValueChange={setCap}
            step={50}
            min={0}
            error={show('cap')}
            hint="Also caps the value a trade may give up against the kernel mark."
          />
        </div>
        <fieldset className="grid gap-s2">
          <legend className="mb-s2 text-t13 font-medium text-navy-200">Underlyings it may trade</legend>
          <div className="flex flex-wrap gap-s2">
            {underlyings.map((u) => {
              const on = allowed.includes(u);
              return (
                <label
                  key={u}
                  className={cn(
                    'flex h-8 cursor-pointer items-center gap-s2 rounded-control border px-s3 text-t13 font-medium has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-cyan',
                    on ? 'border-navy-400 bg-navy-700 text-navy-50' : 'border-navy-600 text-navy-200 ui-hover:border-navy-400',
                  )}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={on}
                    onChange={() => setAllowed((a) => (on ? a.filter((x) => x !== u) : [...a, u]))}
                  />
                  <span aria-hidden="true" className={cn('size-2.5 rounded-full border-[1.5px]', on ? 'border-cyan bg-cyan' : 'border-current')} />
                  {u}
                </label>
              );
            })}
          </div>
          {show('allowed') && (
            <p className="flex items-center gap-s2 text-t12 text-loss-1">
              <Lamp tone="loss-2" size={6} />
              {errors.allowed}
            </p>
          )}
        </fieldset>
        <SegmentedControl legend="Expires after" showLegend size="sm" value={term} onValueChange={setTerm}>
          {TERMS.map((t) => (
            <Segment key={t.v} value={t.v}>
              {t.label}
            </Segment>
          ))}
        </SegmentedControl>
        <p className="text-t13 text-navy-200">
          Expires <span className="tabular-nums text-navy-50">{fmtEt(expiresAt)}</span>. After that, trades it signs revert NotAuthorized.
        </p>
      </form>
    </Dialog>
  );
}
