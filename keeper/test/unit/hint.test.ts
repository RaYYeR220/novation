import { describe, expect, it } from 'vitest';
import { FALLBACK_DELAY, findHint, LAST_RESORT_DELAY, packRound, type Round, type RoundReader } from '../../src/hint';

/** A feed like the RH proxy: rounds per phase, missing rounds read as zeros. */
function feed(phases: Record<number, [answer: number, updatedAt: number][]>, latestPhase = Math.max(...Object.keys(phases).map(Number))): RoundReader & { reads: number } {
  const f = {
    reads: 0,
    async latest(): Promise<Round> {
      const rounds = phases[latestPhase] ?? [];
      const n = rounds.length;
      return f.round(packRound(BigInt(latestPhase), BigInt(n)));
    },
    async round(id: bigint): Promise<Round> {
      f.reads++;
      const p = Number(id >> 64n);
      const n = Number(id & ((1n << 64n) - 1n));
      const r = phases[p]?.[n - 1];
      return r ? { id, answer: BigInt(r[0]) * 10n ** 8n, updatedAt: r[1] } : { id, answer: 0n, updatedAt: 0 };
    },
  };
  return f;
}

const E = 1_790_971_200; // Fri 2026-10-02 16:00 ET
const LAG = 87_300;
const opts = { maxSettlementLag: LAG, minPrice: 20n * 10n ** 18n, maxPrice: 2000n * 10n ** 18n };
/** n rounds, one every `step` seconds, the last at `last`. */
const series = (n: number, last: number, step = 300, px = 230): [number, number][] =>
  Array.from({ length: n }, (_, i) => [px + i, last - (n - 1 - i) * step]);

describe('findHint', () => {
  it('waits until the expiry has strictly passed', async () => {
    const f = feed({ 1: series(5, E - 100) });
    expect(await findHint(f, E, E, opts)).toMatchObject({ kind: 'wait', until: E + 1 });
    expect(f.reads).toBe(0);
  });

  it('takes the latest round when nothing printed after the close (proof ii)', async () => {
    const h = await findHint(feed({ 1: series(5, E - 100) }), E, E + 60, opts);
    expect(h).toMatchObject({ kind: 'ready', method: 'settleExpiry', proof: 'latestRound', hint: packRound(1n, 5n) });
  });

  it('bisects to the last pre-close round when later rounds exist (proof i)', async () => {
    // 1000 rounds, 5 minutes apart, the close falls between rounds 699 and 700
    const rounds = series(1000, E + 300 * 300 + 150);
    const f = feed({ 1: rounds });
    const h = await findHint(f, E, E + 400 * 300, opts);
    expect(h.kind).toBe('ready');
    if (h.kind !== 'ready') return;
    expect(h.proof).toBe('nextRound');
    expect(h.round.updatedAt).toBeLessThanOrEqual(E);
    expect(h.next!.updatedAt).toBeGreaterThan(E);
    expect(h.hint).toBe(packRound(1n, 699n));
    expect(h.reads).toBeLessThan(20); // bisection, not a walk
  });

  it('treats a round printed exactly at the close as pre-close', async () => {
    const h = await findHint(feed({ 1: [[230, E - 600], [231, E], [232, E + 1]] }), E, E + 10, opts);
    expect(h).toMatchObject({ kind: 'ready', proof: 'nextRound', hint: packRound(1n, 2n) });
  });

  it('crosses a phase change after the close (proof iii)', async () => {
    const h = await findHint(feed({ 1: series(40, E - 30), 2: [[240, E + 900], [241, E + 1200]] }), E, E + 2000, opts);
    expect(h).toMatchObject({ kind: 'ready', proof: 'phaseChange', hint: packRound(1n, 40n) });
  });

  it('bisects inside an older phase when the phase changed later', async () => {
    const h = await findHint(feed({ 1: series(50, E + 10 * 300 + 60), 2: [[240, E + 9000]] }), E, E + 10_000, opts);
    expect(h).toMatchObject({ kind: 'ready', proof: 'nextRound', hint: packRound(1n, 39n) });
  });

  it('with rounds out of time order, still returns a pre-close round whose successor printed after the close', async () => {
    const rounds: [number, number][] = [[230, E - 900], [231, E + 50], [232, E - 300], [233, E + 100], [234, E + 200]];
    const h = await findHint(feed({ 1: rounds }), E, E + 300, opts);
    expect(h).toMatchObject({ kind: 'ready', proof: 'nextRound', hint: packRound(1n, 3n) });
    if (h.kind === 'ready') expect(h.next!.updatedAt).toBeGreaterThan(E);
  });

  it('refuses a stale pre-close print, and offers the fallback 72 hours after the close', async () => {
    const stale: [number, number][] = [[230, E - LAG - 1], [235, E + 3600]];
    const early = await findHint(feed({ 1: stale }), E, E + 3700, opts);
    expect(early).toMatchObject({ kind: 'wait', until: E + FALLBACK_DELAY });
    const late = await findHint(feed({ 1: stale }), E, E + FALLBACK_DELAY, opts);
    expect(late).toMatchObject({ kind: 'ready', method: 'settleExpiryFallback', proof: 'fallback', hint: packRound(1n, 2n) });
  });

  it('waits for a post-close round when the only pre-close print is stale', async () => {
    const h = await findHint(feed({ 1: [[230, E - LAG - 10]] }), E, E + FALLBACK_DELAY + 1, opts);
    expect(h).toMatchObject({ kind: 'wait' });
  });

  it('refuses an implausible pre-close print, and is stuck if the post-close one is implausible too', async () => {
    const h = await findHint(feed({ 1: [[5, E - 60], [3000, E + 60]] }), E, E + FALLBACK_DELAY, opts);
    expect(h).toMatchObject({ kind: 'stuck' });
    const ok = await findHint(feed({ 1: [[5, E - 60], [231, E + 60]] }), E, E + FALLBACK_DELAY, opts);
    expect(ok).toMatchObject({ kind: 'ready', method: 'settleExpiryFallback', hint: packRound(1n, 2n) });
  });

  it('settles a dead feed by the last resort 7 days after the close, at its last pre-close print', async () => {
    const dead: [number, number][] = [[230, E - LAG - 3600]];
    expect(await findHint(feed({ 1: dead }), E, E + FALLBACK_DELAY, opts)).toMatchObject({ kind: 'wait', until: E + LAST_RESORT_DELAY });
    expect(await findHint(feed({ 1: dead }), E, E + LAST_RESORT_DELAY, opts)).toMatchObject({
      kind: 'ready',
      method: 'settleExpiryLastResort',
      proof: 'lastResort',
      hint: packRound(1n, 1n),
    });
  });

  it('takes the last resort when the first post-close print is implausible, and the fallback when it is in the band', async () => {
    const implausible: [number, number][] = [[230, E - LAG - 10], [9000, E + 60]];
    expect(await findHint(feed({ 1: implausible }), E, E + FALLBACK_DELAY, opts)).toMatchObject({ kind: 'wait', until: E + LAST_RESORT_DELAY });
    expect(await findHint(feed({ 1: implausible }), E, E + LAST_RESORT_DELAY, opts)).toMatchObject({ kind: 'ready', method: 'settleExpiryLastResort', hint: packRound(1n, 1n) });
    // an in-band first print: the fallback applies (the hub refuses the last resort, FallbackApplies)
    const inBand: [number, number][] = [[230, E - LAG - 10], [231, E + 60]];
    expect(await findHint(feed({ 1: inBand }), E, E + LAST_RESORT_DELAY, opts)).toMatchObject({ kind: 'ready', method: 'settleExpiryFallback' });
  });

  it('is stuck when the feed started after the close', async () => {
    expect(await findHint(feed({ 1: [[230, E + 60]] }), E, E + 120, opts)).toMatchObject({ kind: 'stuck' });
  });
});
