import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { WAD } from '@novation/sdk';
import { deriveKeeperKey } from '../../src/keys';
import { gridStrikes, toGrid } from '../../src/grid';
import { settledPayoff } from '../../src/payoff';
import { createLogger, line } from '../../src/log';

const KEY = '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6';

describe('deriveKeeperKey', () => {
  it('is deterministic, distinct from the deployer key and a valid key', () => {
    const a = deriveKeeperKey(KEY);
    expect(deriveKeeperKey(KEY)).toBe(a);
    expect(deriveKeeperKey(KEY.slice(2))).toBe(a);
    expect(deriveKeeperKey(KEY.toUpperCase().replace('0X', '0x'))).toBe(a);
    expect(a).not.toBe(KEY);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(privateKeyToAccount(a).address).not.toBe(privateKeyToAccount(KEY).address);
    expect(deriveKeeperKey(KEY, 'other')).not.toBe(a);
  });

  it('rejects something that is not a key', () => {
    expect(() => deriveKeeperKey('0x1234')).toThrow();
  });
});

describe('gridStrikes', () => {
  const step = 5n * WAD;
  it("is the seed script's grid: spot +-5/10/15/20% on the strike step", () => {
    const spot = 230_199302880000000000n; // 230.19930288
    expect(gridStrikes(spot, step, [5, 10, 15, 20], WAD / 2n).map((s) => Number(s / WAD))).toEqual([185, 195, 205, 220, 240, 255, 265, 275]);
  });

  it('rounds half up like the seed script and drops strikes beyond maxStrikeDeviation', () => {
    expect(toGrid(2_500n * WAD / 1000n, step)).toBe(5n * WAD);
    expect(toGrid(2_499n * WAD / 1000n, step)).toBe(0n);
    const spot = 100n * WAD;
    expect(gridStrikes(spot, step, [5, 10, 15, 20], (12n * WAD) / 100n).map((s) => Number(s / WAD))).toEqual([90, 95, 105, 110]);
  });
});

describe('settledPayoff', () => {
  const call = { isCall: true, strike: 100n * WAD };
  const put = { isCall: false, strike: 100n * WAD };
  it('pays longs the floor and charges shorts the ceiling', () => {
    expect(settledPayoff(call, 110n * WAD, 2n * WAD)).toBe(20n * WAD);
    expect(settledPayoff(call, 110n * WAD, -2n * WAD)).toBe(-20n * WAD);
    expect(settledPayoff(put, 90n * WAD, WAD)).toBe(10n * WAD);
    expect(settledPayoff(call, 90n * WAD, -WAD)).toBe(0n);
    expect(settledPayoff(put, 110n * WAD, WAD)).toBe(0n);
    // 1/3 contract of a 1-wei payoff: long 0, short -1
    expect(settledPayoff(call, 100n * WAD + 1n, WAD / 3n)).toBe(0n);
    expect(settledPayoff(call, 100n * WAD + 1n, -(WAD / 3n))).toBe(-1n);
  });
});

describe('log', () => {
  it('writes one JSON object per line, bigints as strings, debug only when asked', () => {
    const out: string[] = [];
    const log = createLogger({ sink: (s) => out.push(s) });
    log('info', 'settleExpiry', 'tx', { hash: '0xabc', gasUsed: 123n });
    log('debug', 'syncVol', 'current');
    expect(out).toHaveLength(1);
    const j = JSON.parse(out[0]!);
    expect(j).toMatchObject({ level: 'info', job: 'settleExpiry', msg: 'tx', hash: '0xabc', gasUsed: '123' });
    expect(Date.parse(j.t)).not.toBeNaN();
    expect(line('warn', 'x', 'y')).not.toContain('\n');
  });
});
