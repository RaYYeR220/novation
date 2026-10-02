import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { WAD, type NovationContext } from '@novation/sdk';
import { exposure, Maker, type LiveQuote } from '../../src/maker';

/** anvil's account 5 (public test mnemonic). */
const signer = privateKeyToAccount('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba');
const ZERO = '0x0000000000000000000000000000000000000000';

/** A context whose client answers the registry's `series` read through `series`, counting calls. */
function fakeCtx(series: () => Promise<unknown>) {
  const calls = { n: 0 };
  const ctx = {
    client: {
      readContract: async () => {
        calls.n++;
        return series();
      },
    },
    deployment: { chainId: 46630, rfq: ZERO, registry: ZERO },
  } as unknown as NovationContext;
  return { ctx, calls };
}

describe('Maker limits without a chain', () => {
  it('validates its config when it is built', () => {
    const { ctx } = fakeCtx(async () => undefined);
    expect(() => new Maker({ ctx, signer, makerId: 1n, pricing: { priceSpread: -1n } })).toThrow(RangeError);
    expect(() => new Maker({ ctx, signer, makerId: 1n, pricing: { maxQtyPerQuote: 0n } })).toThrow(RangeError);
    expect(() => new Maker({ ctx, signer, makerId: 1n, maxOutstandingPerClient: 0 })).toThrow(RangeError);
    expect(() => new Maker({ ctx, signer, makerId: 1n, maxQueue: 1.5 })).toThrow(RangeError);
    expect(() => new Maker({ ctx, signer, makerId: 1n })).not.toThrow();
  });

  it('remembers unknown series ids instead of asking the chain again', async () => {
    const { ctx, calls } = fakeCtx(async () => ({ underlying: ZERO, expiry: 0n, isCall: false, strike: 0n }));
    const m = new Maker({ ctx, signer, makerId: 1n });
    const a = await m.quote({ seriesId: 4242, side: 'buy' });
    expect(a.ok ? 'quoted' : a.refusal.code).toBe('UnknownSeries');
    expect(calls.n).toBe(1);
    const b = await m.quote({ seriesId: 4242, side: 'sell' });
    expect(b.ok ? 'quoted' : b.refusal.code).toBe('UnknownSeries');
    expect(calls.n).toBe(1);
    // it expires
    const short = new Maker({ ctx, signer, makerId: 1n, unknownSeriesMs: 0 });
    await short.quote({ seriesId: 4242, side: 'buy' });
    await short.quote({ seriesId: 4242, side: 'buy' });
    expect(calls.n).toBe(3);
  });

  it('answers a transport failure with a generic refusal, keeps the cause as detail, and caches nothing', async () => {
    const { ctx, calls } = fakeCtx(async () => {
      throw new Error('HTTP request failed.\nURL: https://rpc.internal/secret-key');
    });
    const m = new Maker({ ctx, signer, makerId: 1n });
    const r = await m.quote({ seriesId: 7, side: 'buy' });
    if (r.ok) throw new Error('expected a refusal');
    expect(r.refusal.code).toBe('Unavailable');
    expect(r.refusal.message).not.toContain('rpc.internal');
    expect(r.refusal.detail).toBe('HTTP request failed.');
    await m.quote({ seriesId: 7, side: 'buy' });
    expect(calls.n).toBe(2);
  });

  it('refuses as Busy once too many requests are waiting', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { ctx } = fakeCtx(async () => {
      await gate;
      return { underlying: ZERO, expiry: 0n, isCall: false, strike: 0n };
    });
    const m = new Maker({ ctx, signer, makerId: 1n, maxQueue: 2 });
    const first = m.quoteSides(1, ['buy']);
    const second = m.quoteSides(2, ['buy']);
    const third = await m.quoteSides(3, ['buy', 'sell']);
    expect(third.map((r) => (r.ok ? 'quoted' : r.refusal.code))).toEqual(['Busy', 'Busy']);
    release();
    expect((await first)[0]!.ok).toBe(false);
    expect((await second)[0]!.ok).toBe(false);
    // the queue drained: requests are taken again
    const after = await m.quoteSides(1, ['buy']);
    expect(after[0]!.ok ? 'quoted' : (after[0] as { refusal: { code: string } }).refusal.code).toBe('UnknownSeries');
  });
});

describe('exposure of live quotes', () => {
  const q = (o: Partial<LiveQuote>): LiveQuote => ({ seriesId: 1, side: 'buy', maxQty: 2n * WAD, remaining: 2n * WAD, im: 100n * WAD, cashOut: 0n, ...o });

  it('folds the same series and side exactly and adds every other quote as its standalone margin', () => {
    const live = [
      q({}), // same series, same side
      q({ side: 'sell', im: 10n * WAD, cashOut: 8n * WAD }), // same series, other side
      q({ seriesId: 2, im: 60n * WAD }), // other series
      q({ seriesId: 3, side: 'sell', remaining: WAD, im: 30n * WAD, cashOut: 5n * WAD }), // half filled
      q({ seriesId: 4, remaining: 0n, im: 999n * WAD }), // fully filled
    ];
    const ex = exposure(live, 1, 'buy');
    expect(ex.sameSide).toBe(2n * WAD);
    expect(ex.reserved).toEqual({ buy: 2n * WAD, sell: 2n * WAD });
    expect(ex.otherIm).toBe(10n * WAD + 60n * WAD + 15n * WAD);
    expect(ex.otherCash).toBe(8n * WAD + (5n * WAD) / 2n);
  });

  it('rounds the pro-rata shares up', () => {
    const ex = exposure([q({ seriesId: 2, maxQty: 3n, remaining: 1n, im: 10n, cashOut: 10n })], 1, 'buy');
    expect(ex.otherIm).toBe(4n);
    expect(ex.otherCash).toBe(4n);
  });
});
