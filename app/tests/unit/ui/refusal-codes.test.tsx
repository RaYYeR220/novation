import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { refusalMessage } from '@novation/sdk';
import { refusalCopy, RefusalNotice } from '@/components/app/refusal-card';
import { RefusalFeed } from '@/components/risk/refusal-feed';
import type { FeedRefusal, Refusal } from '@/lib/client/types';
import { axe } from './axe';

const WHO = 'Account 12';

describe('refusals of the final contracts', () => {
  it('VolNotCurrent says which vol is syncing, by symbol', async () => {
    const r: Refusal = { code: 'VolNotCurrent', message: refusalMessage('VolNotCurrent'), underlying: 'NVDA' };
    const { container } = render(<RefusalNotice refusal={r} who={WHO} />);
    expect(screen.getByRole('alert')).toHaveAttribute('data-code', 'VolNotCurrent');
    expect(screen.getByRole('heading', { name: 'Syncing the vol of NVDA: retry in a moment.' })).toBeInTheDocument();
    expect(screen.getByText(/A vol estimate is behind its feed's latest round/)).toBeInTheDocument();
    expect(screen.getByText('Anyone may send the sync. Once it lands, the same transaction clears this check.')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it.each([
    ['TooManyClaimExpiries', { id: 12 }, /claim the ready ones first/, /Claim the expiries whose pools are ready/],
    ['StillLiquidatable', {}, /still below maintenance margin/, /back above initial margin, or once it recovers above maintenance/],
    ['FallbackApplies', {}, /the 72-hour fallback settles this expiry/, /fallback price once the 72 hours have passed/],
    ['TooManyUnderlyings', {}, /maximum number of underlyings/, /Close out an underlying/],
  ] as const)('%s reads as the SDK sentence and what would pass', (code, numbers, reason, hint) => {
    const c = refusalCopy({ code, message: refusalMessage(code), numbers }, WHO);
    expect(c.reason).toBe(refusalMessage(code));
    expect(String(c.reason)).toMatch(reason);
    expect(String(c.reason)).not.toMatch(/^Reverted with/);
    expect(String(c.hint)).toMatch(hint);
    expect(c.breach).toBeUndefined();
  });

  it('names the account that would hold too many claim expiries', () => {
    expect(refusalCopy({ code: 'TooManyClaimExpiries', message: '', numbers: { id: 31 } }, WHO).context).toBe('Account 31 would hold them. Account 12.');
  });

  it('shows in the refusal feed without numbers, and without a crash', () => {
    const items: FeedRefusal[] = [
      { code: 'StillLiquidatable', message: refusalMessage('StillLiquidatable'), at: 1790697000, account: 12 },
      { code: 'VolNotCurrent', message: refusalMessage('VolNotCurrent'), at: 1790697100, account: 12, underlying: 'TSLA' },
      { code: 'FallbackApplies', message: refusalMessage('FallbackApplies'), at: 1790697200 },
    ];
    const { container } = render(<RefusalFeed items={items} agents={[]} asOf={1790697600} demo />);
    expect(container.querySelectorAll('li[data-code]')).toHaveLength(3);
    expect(screen.getByRole('heading', { name: 'Syncing the vol of TSLA: retry in a moment.' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: refusalMessage('StillLiquidatable') })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: refusalMessage('FallbackApplies') })).toBeInTheDocument();
    expect(container).not.toHaveTextContent(/unknown error/i);
  });
});
