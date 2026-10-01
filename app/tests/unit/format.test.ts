import { describe, expect, it } from 'vitest';
import {
  fmtAddress,
  fmtDays,
  fmtExpiry,
  fmtExpiryLong,
  fmtFee,
  fmtNumber,
  fmtPct,
  fmtSeries,
  fmtSeriesShort,
  fmtShock,
  fmtSigned,
  fmtStrike,
  fmtUsd,
} from '@/lib/format';

const NOW = 1790697600; // 2026-09-29 16:00 UTC, the fixture snapshot

describe('number formatting', () => {
  it('groups thousands and uses a true minus sign', () => {
    expect(fmtNumber(1612.4)).toBe('1,612.40');
    expect(fmtNumber(-1085.351797)).toBe('−1,085.35');
    expect(fmtNumber(0.004)).toBe('0.00');
    expect(fmtNumber(225.57, 0)).toBe('226');
  });

  it('signs changes explicitly, zero unsigned', () => {
    expect(fmtSigned(1085.35)).toBe('+1,085.35');
    expect(fmtSigned(-0.773092)).toBe('−0.77');
    expect(fmtSigned(0)).toBe('0.00');
  });

  it('formats dollars and percents', () => {
    expect(fmtUsd(-1546.18)).toBe('−$1,546.18');
    expect(fmtPct(0.169, 1)).toBe('16.9%');
    expect(fmtPct(-0.05)).toBe('−5.0%');
  });

  it('shows a fee under a cent as <0.01', () => {
    expect(fmtFee(0.0033)).toBe('<0.01');
    expect(fmtFee(0.009999)).toBe('<0.01');
    expect(fmtFee(0.01)).toBe('0.01');
    expect(fmtFee(0)).toBe('0.00');
    expect(fmtFee(0.767793)).toBe('0.77');
  });

  it('prints strikes bare when whole', () => {
    expect(fmtStrike(200)).toBe('200');
    expect(fmtStrike(1200)).toBe('1,200');
    expect(fmtStrike(202.5)).toBe('202.50');
  });

  it('prints shocks as signed percents', () => {
    expect(fmtShock(0.115476)).toBe('+11.5%');
    expect(fmtShock(-0.115476 / 6)).toBe('−1.9%');
    expect(fmtShock(0)).toBe('0%');
    expect(fmtShock(1e-9)).toBe('0%');
  });
});

describe('series and time labels', () => {
  it('names a series in words and in short form', () => {
    expect(fmtSeries({ underlying: 'NVDA', strike: 200, isCall: true })).toBe('NVDA 200 call');
    expect(fmtSeries({ underlying: 'TSLA', strike: 380, isCall: false })).toBe('TSLA 380 put');
    expect(fmtSeriesShort({ strike: 200, isCall: true })).toBe('200C');
  });

  it('dates expiries in UTC', () => {
    expect(fmtExpiry(NOW + 6 * 86400)).toBe('Oct 5');
    expect(fmtExpiryLong(NOW + 6 * 86400)).toBe('Mon, Oct 5, 16:00 UTC');
  });

  it('counts whole days to expiry', () => {
    expect(fmtDays(NOW + 6 * 86400, NOW)).toBe('6d');
    expect(fmtDays(NOW + 6.9 * 86400, NOW)).toBe('6d');
    expect(fmtDays(NOW + 3600, NOW)).toBe('<1d');
    expect(fmtDays(NOW, NOW)).toBe('expired');
  });

  it('shortens addresses', () => {
    expect(fmtAddress('0x4a1c000000000000000000000000000000009e2f')).toBe('0x4a1c…9e2f');
    expect(fmtAddress('0x1234')).toBe('0x1234');
  });
});
