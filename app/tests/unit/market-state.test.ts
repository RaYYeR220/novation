import { describe, expect, it } from 'vitest';
import {
  VOL_SYNC_TXS,
  closedFor,
  closedSession,
  reopensAt,
  untilReopen,
  vaultClosedText,
  vaultNeedsVolSync,
  vaultVolText,
  volStatus,
  volSyncText,
  volSyncedText,
  volPartlySyncedText,
} from '@/lib/market-state';
import type { Session } from '@/lib/client/types';
import { baseSession, fmtEt } from '@/lib/nyse';

const et = (iso: string) => Date.parse(iso) / 1000;
/** Sat Oct 3 2026, 12:00 ET (EDT). */
const SATURDAY = et('2026-10-03T16:00:00Z');
/** Thanksgiving, Thu Nov 26 2026, 12:00 ET (EST). */
const THANKSGIVING = et('2026-11-26T17:00:00Z');
/** Tue Sep 29 2026, 12:00 ET: the demo snapshot. */
const TUESDAY = 1790697600;

describe('closed sessions', () => {
  it('closes the vaults on a weekend or a holiday only', () => {
    expect(closedSession('WEEKEND')).toBe('WEEKEND');
    expect(closedSession('HOLIDAY')).toBe('HOLIDAY');
    for (const s of ['REGULAR', 'EXTENDED', 'HALTED', undefined] as const) expect(closedSession(s)).toBeUndefined();
    expect(closedFor('WEEKEND')).toBe('the weekend');
    expect(closedFor('HOLIDAY')).toBe('the holiday');
  });

  it('reopens at 20:00 ET on the eve of the next trading day', () => {
    expect(baseSession(SATURDAY)).toBe('WEEKEND');
    expect(fmtEt(reopensAt(SATURDAY)!)).toBe('Sun, Oct 4, 20:00 ET');
    // Friday night is already the weekend
    const friday = et('2026-10-03T01:30:00Z');
    expect(baseSession(friday)).toBe('WEEKEND');
    expect(fmtEt(reopensAt(friday)!)).toBe('Sun, Oct 4, 20:00 ET');
    // Thanksgiving: Friday trades (an early close), so it reopens Thursday evening
    expect(baseSession(THANKSGIVING)).toBe('HOLIDAY');
    expect(fmtEt(reopensAt(THANKSGIVING)!)).toBe('Thu, Nov 26, 20:00 ET');
    // Good Friday runs into the weekend
    const goodFriday = et('2026-04-03T16:00:00Z');
    expect(baseSession(goodFriday)).toBe('HOLIDAY');
    expect(fmtEt(reopensAt(goodFriday)!)).toBe('Sun, Apr 5, 20:00 ET');
  });

  it('names no time when the calendar has the market open', () => {
    expect(reopensAt(TUESDAY)).toBeUndefined();
    expect(untilReopen(TUESDAY)).toBe('until the market reopens');
    expect(untilReopen(undefined)).toBe('until the market reopens');
    expect(vaultClosedText(SATURDAY)).toBe(
      'No quotes, sales, buy-backs, deposits, exits or roll payouts until Sun, Oct 4, 20:00 ET. A redemption request still queues.',
    );
  });
});

describe('vol sync', () => {
  it('says which vol is syncing, by symbol', () => {
    expect(volSyncText('NVDA')).toBe('Syncing the vol of NVDA: retry in a moment.');
    expect(volSyncText(undefined)).toBe('Syncing a vol estimate: retry in a moment.');
  });

  it('flags a vol a liquidation would refuse: over 8 rounds behind, over 64, or a migration', () => {
    expect(volStatus('NVDA', 0)).toEqual({ ok: true, text: 'Vol estimate current with its feed' });
    expect(volStatus('NVDA', 8).ok).toBe(true);
    expect(volStatus('NVDA', 9)).toMatchObject({ ok: false, text: expect.stringMatching(/9 rounds behind.*a liquidation folds 8 at most/) });
    expect(volStatus('NVDA', 65)).toMatchObject({ ok: false, text: expect.stringMatching(/withdrawals, opening trades and liquidations are refused/) });
    expect(volStatus('NVDA', null)).toMatchObject({ ok: false, text: expect.stringMatching(/^NVDA's feed moved to a new aggregator.*syncAndRebaseVol/) });
  });
});

describe('a vault waiting for its vol', () => {
  const v = (session: Session, volBehind: number | null | undefined, live = false) => ({ live, session, volBehind });

  it('offers a sync only while the market is open and the vol is past what the vault folds itself', () => {
    expect(vaultNeedsVolSync(v('REGULAR', 65))).toBe(true);
    expect(vaultNeedsVolSync(v('EXTENDED', 200))).toBe(true);
    // a feed migration waits for syncAndRebaseVol
    expect(vaultNeedsVolSync(v('REGULAR', null))).toBe(true);
    // a vault folds up to 64 rounds itself, and a live one needs nothing
    expect(vaultNeedsVolSync(v('REGULAR', 64))).toBe(false);
    expect(vaultNeedsVolSync(v('REGULAR', 200, true))).toBe(false);
    // closed or halted: a sync would not make it quote
    for (const s of ['WEEKEND', 'HOLIDAY', 'HALTED'] as const) expect(vaultNeedsVolSync(v(s, 200))).toBe(false);
    // the demo has no vol state
    expect(vaultNeedsVolSync(v('REGULAR', undefined))).toBe(false);
  });

  it('says why, and how many transactions a sync may take', () => {
    expect(vaultVolText('NVDA', 120)).toBe('The NVDA vol is 120 rounds behind its feed, more than one sync folds.');
    expect(vaultVolText('NVDA', null)).toBe('The NVDA feed moved to a new aggregator, and its vol waits for syncAndRebaseVol.');
    expect(VOL_SYNC_TXS).toBe('up to 4 transactions');
    expect(volSyncedText('TSLA')).toBe('Vol of TSLA synced: check the updated quote and sign again.');
    expect(volPartlySyncedText('TSLA')).toBe('Vol of TSLA partly synced, still behind its feed: retry in a moment.');
  });
});
