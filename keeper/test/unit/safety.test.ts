import { describe, expect, it } from 'vitest';
import type { Chain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getDeployment, robinhoodChain, robinhoodChainTestnet } from '@novation/sdk';
import { createKeeper, DEFAULT_OPTIONS, isTestChain, MAX_TX_GAS, padGas } from '../../src/keeper';
import { deriveKeeperKey, keeperKeyFromEnv } from '../../src/keys';
import { openDemoPosition } from '../../src/demo';
import { findHint, packRound, type Round, type RoundReader } from '../../src/hint';

const DEPLOYER = '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6';
const OTHER = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba';

describe('keeper key by chain', () => {
  it('derives from the deployer key on the testnet and a local chain only', () => {
    expect(keeperKeyFromEnv(46630, { DEPLOYER_PRIVATE_KEY: DEPLOYER })).toBe(deriveKeeperKey(DEPLOYER));
    expect(keeperKeyFromEnv(31337, { DEPLOYER_PRIVATE_KEY: DEPLOYER })).toBe(deriveKeeperKey(DEPLOYER));
    expect(() => keeperKeyFromEnv(4663, { DEPLOYER_PRIVATE_KEY: DEPLOYER })).toThrow(/KEEPER_PRIVATE_KEY/);
    expect(() => keeperKeyFromEnv(46630, {})).toThrow();
  });

  it('uses KEEPER_PRIVATE_KEY wherever it is set', () => {
    expect(keeperKeyFromEnv(4663, { KEEPER_PRIVATE_KEY: OTHER, DEPLOYER_PRIVATE_KEY: DEPLOYER })).toBe(OTHER);
    expect(keeperKeyFromEnv(46630, { KEEPER_PRIVATE_KEY: OTHER.slice(2), DEPLOYER_PRIVATE_KEY: DEPLOYER })).toBe(OTHER);
    expect(isTestChain(46630) && isTestChain(31337) && !isTestChain(4663)).toBe(true);
  });
});

describe('padGas', () => {
  it('adds 25% and never asks for more than 31.5M', () => {
    expect(padGas(1_000_000n)).toBe(1_250_000n);
    expect(padGas(25_200_000n)).toBe(31_500_000n);
    // +25% would cross the cap: +5% instead
    expect(padGas(28_200_000n)).toBe(29_610_000n);
    expect(padGas(30_500_000n)).toBe(MAX_TX_GAS);
    expect(padGas(40_000_000n)).toBe(MAX_TX_GAS);
  });
});

describe('defaults', () => {
  it('waits out the mirror before settling, scans behind the head and bids only when asked', () => {
    expect(DEFAULT_OPTIONS.settleDelaySec).toBe(900);
    expect(DEFAULT_OPTIONS.confirmations).toBeGreaterThan(0);
    expect(DEFAULT_OPTIONS.scanOverlap).toBeGreaterThan(0);
    expect(DEFAULT_OPTIONS.bid).toBe(false);
    expect(DEFAULT_OPTIONS.gasReserve).toBeGreaterThan(0n);
    expect(DEFAULT_OPTIONS.listPerTick).toBeGreaterThan(0);
  });
});

describe('testnet-only actions', () => {
  it('refuses to open the demo book anywhere but the testnet or a local chain', async () => {
    const mk = (chain: Chain) =>
      createKeeper({ chain, deployment: { ...getDeployment(46630), chainId: chain.id }, key: deriveKeeperKey(DEPLOYER), rpcUrl: 'http://127.0.0.1:1' });
    await expect(openDemoPosition(mk(robinhoodChain), { expiry: 1_790_971_200 })).rejects.toThrow(/testnet/);
    expect(privateKeyToAccount(deriveKeeperKey(DEPLOYER)).address).toBe(mk(robinhoodChainTestnet).account.address);
  });
});

describe('findHint bounds', () => {
  const E = 1_790_971_200;
  const opts = { maxSettlementLag: 87_300, minPrice: 20n * 10n ** 18n, maxPrice: 2000n * 10n ** 18n };
  function feed(phases: Record<number, [number, number][]>, latestPhase: number): RoundReader & { reads: number } {
    const f = {
      reads: 0,
      async latest(): Promise<Round> {
        return f.round(packRound(BigInt(latestPhase), BigInt(phases[latestPhase]?.length ?? 0)));
      },
      async round(id: bigint): Promise<Round> {
        f.reads++;
        const r = phases[Number(id >> 64n)]?.[Number(id & ((1n << 64n) - 1n)) - 1];
        return r ? { id, answer: BigInt(r[0]) * 10n ** 8n, updatedAt: r[1] } : { id, answer: 0n, updatedAt: 0 };
      },
    };
    return f;
  }

  it('stops at an empty phase instead of walking every phase down to 1', async () => {
    // someone re-phased a public mock feed to 60000 and printed after the close
    const f = feed({ 1: [[230, E - 60]], 60000: [[231, E + 60]] }, 60000);
    const h = await findHint(f, E, E + 120, opts);
    expect(h.kind).toBe('stuck');
    expect(f.reads).toBeLessThan(10);
  });

  it('walks back at most maxPhases phases', async () => {
    const phases: Record<number, [number, number][]> = { 1: [[230, E - 60]] };
    for (let p = 2; p <= 20; p++) phases[p] = [[230, E + p]];
    expect(await findHint(feed(phases, 20), E, E + 100, opts)).toMatchObject({ kind: 'stuck' });
    expect(await findHint(feed(phases, 20), E, E + 100, { ...opts, maxPhases: 20 })).toMatchObject({ kind: 'ready', proof: 'phaseChange', hint: packRound(1n, 1n) });
  });

  it('gives up after maxReads round reads', async () => {
    const rounds: [number, number][] = Array.from({ length: 1000 }, (_, i) => [230, E - 500 * 300 + i * 300 + 150]);
    const h = await findHint(feed({ 1: rounds }, 1), E, E + 1_000_000, { ...opts, maxReads: 5 });
    expect(h).toMatchObject({ kind: 'stuck' });
    expect(h.reads).toBeLessThanOrEqual(5);
  });
});
