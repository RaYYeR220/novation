import { describe, expect, it } from 'vitest';
import type { Chain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getDeployment, robinhoodChain, robinhoodChainTestnet } from '@novation/sdk';
import { createKeeper, DEFAULT_OPTIONS, isTestChain, MAX_TX_GAS, padGas } from '../../src/keeper';
import { deriveKeeperKey, keeperKeyFromEnv } from '../../src/keys';
import { openDemoPosition } from '../../src/demo';
import { shouldRepay } from '../../src/jobs/deficit';
import { claimPlan, MAX_CLAIM_EXPIRIES, shouldStart } from '../../src/jobs/liquidations';
import { findHint, packRound, type Round, type RoundReader } from '../../src/hint';

/** anvil's account 9 (public test mnemonic): stands in for a deployer key. */
const DEPLOYER = '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6';
/** anvil's account 5 (public test mnemonic): stands in for an independent keeper key. */
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
    expect(DEFAULT_OPTIONS.rollEverySec).toBe(3600);
    expect(DEFAULT_OPTIONS.pendingMaxAgeMs).toBe(600_000);
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

describe('repay and restart gates', () => {
  const unit = 10n ** 12n;
  const base = { unit, now: 100_000, backoffSec: 21_600, repeat: false, belowReserve: false };

  it('repays when the cash covers what a repay can take, and not a sub-unit socialized remainder', () => {
    expect(shouldRepay({ ...base, total: 5n * unit, social: 0n, cash: 5n * unit }).send).toBe(true);
    expect(shouldRepay({ ...base, total: 5n * unit, social: 0n, cash: 4n * unit }).send).toBe(false);
    // only 0.4 unit of socialized debt is left: whole-unit repays can never take it
    expect(shouldRepay({ ...base, total: (4n * unit) / 10n, social: (4n * unit) / 10n, cash: 10n * unit })).toMatchObject({ send: false, reason: expect.stringMatching(/sub-unit/) });
    // 3.4 units owed, 0.4 of them stuck: 3 units of cash is enough
    expect(shouldRepay({ ...base, total: (34n * unit) / 10n, social: (34n * unit) / 10n, cash: 3n * unit }).send).toBe(true);
  });

  it('backs off after a repay that changed nothing, and holds repeats below the reserve', () => {
    const owing = { ...base, total: 5n * unit, social: 0n, cash: 5n * unit };
    expect(shouldRepay({ ...owing, lastStall: 100_000 - 60 }).send).toBe(false);
    expect(shouldRepay({ ...owing, lastStall: 100_000 - 21_600 }).send).toBe(true);
    expect(shouldRepay({ ...owing, repeat: true, belowReserve: true }).send).toBe(false);
    expect(shouldRepay({ ...owing, repeat: false, belowReserve: true }).send).toBe(true);
  });

  it('restarts a liquidation only when the keeper took part in the last one or the backoff ran out', () => {
    const b = { now: 50_000, backoffSec: 21_600 };
    expect(shouldStart({ ...b })).toBe(true);
    expect(shouldStart({ ...b, lastStart: 48_000 })).toBe(false); // no bid went through: bids failing or off
    expect(shouldStart({ ...b, lastStart: 48_000, lastBidOk: 47_000 })).toBe(false);
    expect(shouldStart({ ...b, lastStart: 48_000, lastBidOk: 48_000 })).toBe(true);
    expect(shouldStart({ ...b, lastStart: 50_000 - 21_600 })).toBe(true);
  });
});

describe('claim expiries before a liquidation bid', () => {
  const expiries = Array.from({ length: 20 }, (_, i) => 1_790_971_200 + i * 604_800);

  it('claims the ready ones so a bid can move the rest', () => {
    const ready = new Set(expiries.slice(0, 5));
    const plan = claimPlan(expiries, (e) => ready.has(e));
    expect(plan).toEqual({ claim: expiries.slice(0, 5), left: 15, over: false });
  });

  it('skips the bid when blocked claims alone keep the account over the cap', () => {
    const ready = new Set(expiries.slice(0, 3));
    expect(claimPlan(expiries, (e) => ready.has(e))).toMatchObject({ left: 17, over: true });
    expect(claimPlan(expiries.slice(0, MAX_CLAIM_EXPIRIES), () => false)).toMatchObject({ claim: [], left: 16, over: false });
    expect(MAX_CLAIM_EXPIRIES).toBe(16);
  });
});
