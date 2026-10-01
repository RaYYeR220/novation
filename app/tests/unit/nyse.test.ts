import { describe, expect, it } from 'vitest';
import chains from '@/fixtures/chains.json';
import account7 from '@/fixtures/account7.json';
import underlyings from '@/fixtures/underlyings.json';
import {
  baseSession,
  fmtCloseEt,
  isDst,
  isWeeklyExpiry,
  nextWeeklyExpiry,
  weeklyExpiries,
} from '@/lib/nyse';

const SNAPSHOT = 1790697600; // Tue Sep 29 2026, 16:00 UTC

describe('NYSE calendar mirror', () => {
  it('passes the contract vectors (contracts/test/calendar/NyseCalendar.t.sol)', () => {
    expect(baseSession(1790344800)).toBe('REGULAR');
    expect(baseSession(1790434800)).toBe('WEEKEND');
    expect(baseSession(1790555400)).toBe('EXTENDED');
    expect(isWeeklyExpiry(1790366400)).toBe(true);
    expect(isWeeklyExpiry(1790366400 + 1)).toBe(false);
    expect(isWeeklyExpiry(1790366400 - 86400)).toBe(false);
    expect(isWeeklyExpiry(1775160000)).toBe(true); // Good Friday 2026: Thursday close
    expect(isWeeklyExpiry(1795802400)).toBe(true); // Black Friday 2026: 13:00 early close
    expect(isDst(1772953199)).toBe(false);
    expect(isDst(1772953200)).toBe(true);
    expect(isDst(1793512799)).toBe(true);
    expect(isDst(1793512800)).toBe(false);
    expect(nextWeeklyExpiry(1790344800)).toBe(1790366400);
  });

  it('lists the Friday closes after the snapshot, in EDT', () => {
    const e = weeklyExpiries(SNAPSHOT, 4);
    expect(e.map((t) => new Date(t * 1000).toISOString())).toEqual([
      '2026-10-02T20:00:00.000Z',
      '2026-10-09T20:00:00.000Z',
      '2026-10-16T20:00:00.000Z',
      '2026-10-23T20:00:00.000Z',
    ]);
    expect(fmtCloseEt(e[0]!)).toBe('Fri, Oct 2, 16:00 ET');
    expect(baseSession(SNAPSHOT)).toBe('REGULAR');
  });

  it('moves the expiry to Thursday when Friday is a holiday, and keeps early closes', () => {
    // Independence Day observed on Fri Jul 3 2026: Thursday Jul 2 16:00 EDT
    expect(new Date(nextWeeklyExpiry(1782864000) * 1000).toISOString()).toBe('2026-07-02T20:00:00.000Z');
    expect(fmtCloseEt(1795802400)).toBe('Fri, Nov 27, 13:00 ET');
    // after the November DST change the close is 21:00 UTC
    expect(new Date(nextWeeklyExpiry(1795000000) * 1000).toISOString()).toBe('2026-11-20T21:00:00.000Z');
  });

  it('every fixture expiry is a weekly expiry, and the snapshot session matches', () => {
    for (const c of Object.values(chains)) {
      expect(c.expiries).toEqual(weeklyExpiries(SNAPSHOT, 4));
      for (const s of c.series) expect(isWeeklyExpiry(s.expiry)).toBe(true);
    }
    for (const p of account7.account.positions) expect(isWeeklyExpiry(p.expiry)).toBe(true);
    for (const u of underlyings) expect(u.session).toBe(baseSession(SNAPSHOT));
  });
});
