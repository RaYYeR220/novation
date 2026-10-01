'use client';

import type { ReactNode } from 'react';
import { RefusalCard, type RefusalBreach } from '@/components/ui/refusal-card';
import type { Refusal } from '@/lib/client/types';
import { fmtNumber } from '@/lib/format';

export interface RefusalNoticeProps {
  refusal: Refusal;
  /** Who and what, e.g. "Account 7, signed by hedge-bot". */
  who: string;
  /** The agent's name when an agent signed. */
  agentLabel?: string;
  /** An action that would clear, e.g. a resize button. */
  action?: ReactNode;
  /** Replaces the default hint, e.g. with a size that is known to fit. */
  hint?: ReactNode;
  announce?: boolean;
  level?: 2 | 3 | 4;
  /** Unit after each readout figure. Narrow columns pass '' and let the context sentence carry it. */
  unit?: string;
  className?: string;
}

interface Copy {
  reason: ReactNode;
  context: ReactNode;
  breach?: RefusalBreach;
  hint?: ReactNode;
}

const n = (r: Refusal, k: string) => r.numbers?.[k];
const u = (v: number) => `${fmtNumber(v)} USDG`;

/** Contract refusals in words, with the two numbers that crossed and what would clear instead. */
export function refusalCopy(r: Refusal, who: string, agentLabel = 'the agent'): Copy {
  switch (r.code) {
    case 'AgentRiskBudgetExceeded': {
      const worst = n(r, 'worstLoss');
      const budget = n(r, 'budget');
      const used = n(r, 'used');
      const left = n(r, 'remaining');
      if (worst === undefined || budget === undefined) return { reason: r.message, context: who };
      return {
        reason: `${agentLabel}'s risk budget can't carry this ticket.`,
        context: (
          <>
            Worst case after this trade: <span className="tabular-nums text-navy-50">{u(worst)}</span> against a{' '}
            <span className="tabular-nums text-navy-50">{u(budget)}</span> budget
            {used !== undefined && (
              <>
                {' '}
                ({fmtNumber(used)} already used; this ticket adds {fmtNumber(worst - used)})
              </>
            )}
            . {who}.
          </>
        ),
        breach: { attempted: { label: 'Worst case after', value: worst }, limit: { label: 'Budget', value: budget } },
        hint:
          left !== undefined
            ? `Cut the size until the worst case fits in the ${u(left)} left, or sign from the owner wallet.`
            : 'Cut the size, or sign from the owner wallet.',
      };
    }
    case 'InsufficientMargin': {
      const im = n(r, 'im');
      const equity = n(r, 'equity');
      if (im === undefined || equity === undefined) return { reason: r.message, context: who };
      return {
        reason: 'Initial margin after this trade is more than the account’s equity.',
        context: (
          <>
            Margin needed after this trade: <span className="tabular-nums text-navy-50">{u(im)}</span>. Equity:{' '}
            <span className="tabular-nums text-navy-50">{u(equity)}</span>. {who}.
          </>
        ),
        breach: {
          attempted: { label: 'Margin needed', value: im },
          limit: { label: 'Equity', value: equity },
          gapLabel: 'Short by',
        },
        hint: `Deposit ${u(im - equity)}, or cut the size until margin fits inside equity.`,
      };
    }
    case 'InsufficientCash': {
      const cash = n(r, 'cash');
      const premium = n(r, 'premium');
      const fee = n(r, 'fee');
      if (cash === undefined || premium === undefined || fee === undefined) return { reason: r.message, context: who };
      const before = cash + premium + fee;
      return {
        reason: 'Cash doesn’t cover the premium and the fee. There is no cash borrowing.',
        context: `${who}.`,
        breach: {
          attempted: { label: 'Premium and fee', value: premium + fee },
          limit: { label: 'Cash', value: before },
          gapLabel: 'Short by',
        },
        hint: `Deposit ${u(-cash)}, or buy fewer contracts.`,
      };
    }
    case 'OpeningNotAllowed':
      return { reason: r.message, context: `${who}.`, hint: 'Trades that reduce risk still clear. Opening resumes when the session reopens.' };
    default:
      return { reason: r.message, context: `${who}.` };
  }
}

export function RefusalNotice({ refusal, who, agentLabel, action, hint, announce = true, level = 3, unit = 'USDG', className }: RefusalNoticeProps) {
  const c = refusalCopy(refusal, who, agentLabel);
  return (
    <RefusalCard
      code={refusal.code}
      reason={c.reason}
      context={c.context}
      breach={c.breach}
      hint={hint ?? c.hint}
      action={action}
      announce={announce}
      level={level}
      unit={unit}
      className={className}
    />
  );
}
