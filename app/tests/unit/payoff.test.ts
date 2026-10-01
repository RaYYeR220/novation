import { describe, expect, it } from 'vitest';
import { breakevens, legValue, payoffAt, priceAxis, type PayoffBook } from '@/lib/payoff';

const E = 1791216000;

describe('payoff at expiry', () => {
  // Account 7's NVDA book: 40 tokens, short 40 of the 200 call, long 10 of the 170 put.
  const book: PayoffBook = {
    tokenQty: 40,
    spot: 225.57,
    vol: 0.52,
    legs: [
      { strike: 200, isCall: true, expiry: E, qty: -40, cost: 25.769745 },
      { strike: 170, isCall: false, expiry: E, qty: 10, cost: 0.000031 },
    ],
  };

  it('a covered call is flat above its strike', () => {
    const a = payoffAt(book, 240, E);
    expect(a).toBeCloseTo(payoffAt(book, 300, E), 9);
    expect(a).toBeCloseTo(40 * (200 - 225.57) + 40 * 25.769745 - 10 * 0.000031, 6);
  });

  it('the put floors the loss below 170', () => {
    // 40 tokens lose 400 per 10 dollars; the 10 puts give 100 back
    expect(payoffAt(book, 150, E) - payoffAt(book, 160, E)).toBeCloseTo(-300, 6);
  });

  it('the ticket alone: 60 calls sold at 25.77, less the fee', () => {
    const ticket: PayoffBook = {
      tokenQty: 0,
      spot: 225.57,
      vol: 0.52,
      fee: 0.773092,
      legs: [{ strike: 200, isCall: true, expiry: E, qty: -60, cost: 25.769745 }],
    };
    expect(payoffAt(ticket, 190, E)).toBeCloseTo(60 * 25.769745 - 0.773092, 6);
    expect(payoffAt(ticket, 250, E)).toBeCloseTo(-60 * (50 - 25.769745) - 0.773092, 6);
  });

  it('values a leg that outlives the horizon with Black-Scholes', () => {
    const later = { strike: 200, isCall: true, expiry: E + 7 * 86400, qty: 1, cost: 0 };
    expect(legValue(later, 225.57, E, 0.52)).toBeGreaterThan(25.57);
    expect(legValue(later, 225.57, later.expiry, 0.52)).toBeCloseTo(25.57, 9);
  });
});

describe('price axis and breakevens', () => {
  it('spans spot ± span and inserts strikes in order', () => {
    const xs = priceAxis(100, 0.2, 5, [95, 150]);
    expect(xs[0]).toBeCloseTo(80, 9);
    expect(xs[xs.length - 1]).toBeCloseTo(120, 9);
    expect(xs).toContain(95);
    expect(xs).not.toContain(150);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  });

  it('interpolates zero crossings', () => {
    expect(breakevens([0, 1, 2, 3], [-2, 2, 2, -2])).toEqual([0.5, 2.5]);
    expect(breakevens([0, 1, 2], [1, 2, 3])).toEqual([]);
    expect(breakevens([0, 1, 2], [-1, 0, 1])).toEqual([1]);
  });
});
