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
  /** Link to the refused transaction. */
  proof?: { href: string; label: string };
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
      // Clearinghouse: the account's lossIM after the trade must stay within maxWorstLoss.
      const worst = n(r, 'worstLoss');
      const budget = n(r, 'budget');
      const now = n(r, 'used');
      if (worst === undefined || budget === undefined) return { reason: r.message, context: who };
      return {
        reason: `${agentLabel}'s risk budget can't carry this ticket.`,
        context: (
          <>
            Worst case after this trade: <span className="tabular-nums text-navy-50">{u(worst)}</span> against a{' '}
            <span className="tabular-nums text-navy-50">{u(budget)}</span> budget
            {now !== undefined && (
              <>
                {' '}
                ({fmtNumber(now)} now; this ticket adds {fmtNumber(worst - now)})
              </>
            )}
            . The worst case is the kernel&apos;s lossIM, the account&apos;s initial margin. {who}.
          </>
        ),
        breach: { attempted: { label: 'Worst case after', value: worst }, limit: { label: 'Budget', value: budget } },
        hint: `Cut the size until initial margin stays at or under ${u(budget)}, or sign from the owner wallet.`,
      };
    }
    case 'AgentPremiumExceeded': {
      const premium = n(r, 'premium');
      const cap = n(r, 'cap');
      if (premium === undefined || cap === undefined) return { reason: r.message, context: `${who}.` };
      return {
        reason: `The premium is over ${agentLabel}'s per-trade cap.`,
        context: (
          <>
            Premium <span className="tabular-nums text-navy-50">{u(premium)}</span> against a cap of{' '}
            <span className="tabular-nums text-navy-50">{u(cap)}</span> per trade. {who}.
          </>
        ),
        breach: { attempted: { label: 'Premium', value: premium }, limit: { label: 'Per-trade cap', value: cap } },
        hint: `Keep the premium at or under ${u(cap)}, or sign from the owner wallet.`,
      };
    }
    case 'AgentValueDrainExceeded': {
      const loss = n(r, 'loss');
      const cap = n(r, 'cap');
      if (loss === undefined || cap === undefined) return { reason: r.message, context: `${who}.` };
      return {
        reason: `This price gives away more value than ${agentLabel} may.`,
        context: (
          <>
            Against the kernel mark the account would give up{' '}
            <span className="tabular-nums text-navy-50">{u(loss)}</span>, fee aside. The cap is{' '}
            <span className="tabular-nums text-navy-50">{u(cap)}</span>. {who}.
          </>
        ),
        breach: { attempted: { label: 'Value given up', value: loss }, limit: { label: 'Cap', value: cap } },
        hint: 'Trade closer to the mark, cut the size, or sign from the owner wallet.',
      };
    }
    case 'AgentUnderlyingNotAllowed':
      return {
        reason: `${agentLabel} may not trade this underlying.`,
        context: `${who}.`,
        hint: 'Sign from the owner wallet, or have the owner widen the grant.',
      };
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
      if (n(r, 'sell') === 1) {
        // a sale is credited its premium first; the fee is what the cash can't cover
        return {
          reason: 'Cash, with the premium credited, doesn’t cover the fee. There is no cash borrowing.',
          context: `${who}.`,
          breach: {
            attempted: { label: 'Fee', value: fee },
            limit: { label: 'Cash with the premium', value: cash + fee },
            gapLabel: 'Short by',
          },
          hint: `Deposit ${u(-cash)}, or sell fewer contracts.`,
        };
      }
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

export function RefusalNotice({ refusal, who, agentLabel, action, hint, announce = true, level = 3, unit = 'USDG', proof, className }: RefusalNoticeProps) {
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
      proof={proof}
      className={className}
    />
  );
}
