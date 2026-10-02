import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createWalletClient, getAddress, http, keccak256, toHex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  baseSession,
  createNovation,
  DEPLOYED_CHAIN_IDS,
  fromWad,
  getDeployment,
  getEvents,
  clearinghouseAbi,
  isWeeklyExpiry,
  mulWadUp,
  nextWeeklyExpiry,
  proofRefusals,
  robinhoodChainTestnet,
  sessionMultiplier,
  sessionOf,
  shockRange,
  sqrtWad,
  symbolOf,
  takerCashDelta,
  toUnits,
  toWad,
  tokenOf,
  tokenToWad,
  tradeFee,
  wadToToken,
  WAD,
  GAS_HEADROOM_PERCENT,
  isRangeTooWide,
  isRateLimited,
  memoryEventCache,
  padGas,
  sendRequest,
  type UnderlyingParams,
} from '../../src/index';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('units', () => {
  it('converts WAD and token units, truncating like the contracts', () => {
    expect(toWad('1.5')).toBe(1_500_000_000_000_000_000n);
    expect(toWad(0.1)).toBe(100_000_000_000_000_000n);
    expect(fromWad(-2_250_000_000_000_000_000n)).toBe(-2.25);
    expect(toUnits('12.3456789', 6)).toBe(12_345_678n);
    expect(tokenToWad(2_000_000n, 6)).toBe(2n * WAD);
    expect(wadToToken(1_999_999_999_999_999_999n, 6)).toBe(1_999_999n);
    expect(mulWadUp(3n, WAD / 2n)).toBe(2n);
    expect(mulWadUp(0n, 5n)).toBe(0n);
  });

  it('pads gas estimates by a quarter', () => {
    expect(padGas(100_000n)).toBe(125_000n);
    expect(GAS_HEADROOM_PERCENT).toBe(125n);
  });

  it('takes the square root the way FixedPointMath.sqrtWad does', () => {
    expect(sqrtWad(4n * WAD)).toBe(2n * WAD);
    expect(sqrtWad(2n * WAD)).toBe(1_414_213_562_373_095_048n);
    expect(sqrtWad(0n)).toBe(0n);
  });
});

describe('kernel inputs', () => {
  // NVDA's parameters as Deploy.s.sol sets them
  const nvda = {
    shockK: 3n * WAD,
    minShock: WAD / 10n,
    horizonDays: 2n,
    multExtended: 12n * 10n ** 17n,
    multWeekend: 175n * 10n ** 16n,
    multHoliday: 175n * 10n ** 16n,
    multHalted: 25n * 10n ** 17n,
  } as UnderlyingParams;

  it('reproduces the session-scaled shock range', () => {
    // 3 * 0.35 * sqrt(2/365) = 0.0777 is under the 10% floor
    expect(shockRange(nvda, 35n * 10n ** 16n, 'REGULAR')).toBe(WAD / 10n);
    expect(shockRange(nvda, 35n * 10n ** 16n, 'WEEKEND')).toBe(175n * 10n ** 15n);
    // a 60% vol: 3 * 0.6 * sqrt(2/365) = 0.13324...
    const r = shockRange(nvda, 6n * 10n ** 17n, 'REGULAR');
    expect(fromWad(r)).toBeCloseTo(0.133243, 5);
    expect(shockRange(nvda, 6n * 10n ** 17n, 'HALTED')).toBe((r * 25n) / 10n);
    // capped at 90%
    expect(shockRange(nvda, 5n * WAD, 'HALTED')).toBe(9n * 10n ** 17n);
    expect(sessionMultiplier(nvda, 'EXTENDED')).toBe(nvda.multExtended);
  });

  it("charges TradeLogic's fee: the smaller of the notional rate and the premium cap", () => {
    const g = { feeRate: 3n * 10n ** 14n, feeCapOfPremium: 125n * 10n ** 15n };
    // 1 contract at 190: 0.03% of 190 = 0.057; 12.5% of a 2.00 premium = 0.25
    expect(tradeFee(g, WAD, 190n * WAD, 2n * WAD)).toBe(57n * 10n ** 15n);
    // a 0.10 premium caps it at 0.0125
    expect(tradeFee(g, WAD, 190n * WAD, WAD / 10n)).toBe(125n * 10n ** 14n);
    expect(takerCashDelta(WAD, 2n * WAD, 1n)).toBe(-(2n * WAD + 1n));
    expect(takerCashDelta(-WAD, 2n * WAD, 1n)).toBe(2n * WAD - 1n);
  });

  it('maps hub session enums', () => {
    expect([0, 1, 2, 3, 4].map(sessionOf)).toEqual(['REGULAR', 'EXTENDED', 'WEEKEND', 'HOLIDAY', 'HALTED']);
    expect(() => sessionOf(5)).toThrow();
  });
});

describe('calendar', () => {
  it('passes the NyseCalendar.sol vectors', () => {
    expect(baseSession(1790344800)).toBe('REGULAR');
    expect(baseSession(1790434800)).toBe('WEEKEND');
    expect(baseSession(1790555400)).toBe('EXTENDED');
    expect(isWeeklyExpiry(1790366400)).toBe(true);
    expect(isWeeklyExpiry(1775160000)).toBe(true); // Good Friday 2026: Thursday close
    expect(nextWeeklyExpiry(1790344800)).toBe(1790366400);
  });
});

describe('deployments', () => {
  it('match contracts/deployments/<chainId>.json', () => {
    expect(DEPLOYED_CHAIN_IDS).toContain(46630);
    for (const id of DEPLOYED_CHAIN_IDS) {
      const json = JSON.parse(readFileSync(join(ROOT, 'contracts', 'deployments', `${id}.json`), 'utf8'));
      const d = getDeployment(id);
      expect(d.chainId).toBe(id);
      expect(d.block).toBe(BigInt(json.block));
      expect(d.kernel).toBe(getAddress(json.kernel.address));
      for (const k of ['hub', 'registry', 'clearinghouse', 'rfq', 'riskParams', 'insurance', 'auctionHouse'] as const) expect(d[k]).toBe(getAddress(json[k]));
      expect(d.vaults.map((v) => v.address)).toEqual(json.vaults.map((v: { address: string }) => getAddress(v.address)));
      expect(Object.keys(d.tokens).sort()).toEqual(Object.keys(json.tokens).sort());
    }
    expect(() => getDeployment(1)).toThrow(/no Novation deployment/);
  });

  it('look tokens up both ways', () => {
    const d = getDeployment(46630);
    expect(symbolOf(d, tokenOf(d, 'NVDA').toLowerCase() as `0x${string}`)).toBe('NVDA');
    expect(() => tokenOf(d, 'DOGE')).toThrow();
  });

  it('carry the recorded proof refusals', () => {
    const r = proofRefusals(46630);
    expect(r.map((x) => x.expectedError)).toEqual(expect.arrayContaining(['AgentRiskBudgetExceeded', 'InsufficientMargin', 'OpeningNotAllowed']));
    expect(proofRefusals(1)).toEqual([]);
  });

  it.skipIf(!existsSync(join(ROOT, 'contracts', 'out')))('ABIs and addresses match the contracts build (node scripts/gen.ts --check)', () => {
    const r = spawnSync(process.execPath, ['scripts/gen.ts', '--check'], { cwd: join(ROOT, 'sdk'), encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});

describe('events', () => {
  it('splits a range the node refuses and keeps chain order', async () => {
    const calls: [bigint, bigint][] = [];
    const client = {
      getBlockNumber: async () => 99n,
      getContractEvents: vi.fn(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        if (toBlock - fromBlock + 1n > 25n) throw new Error('query exceeds max block range 25');
        calls.push([fromBlock, toBlock]);
        return [{ blockNumber: fromBlock }];
      }),
    } as unknown as PublicClient;
    const ctx = { client, deployment: { ...getDeployment(46630), block: 0n } };
    const logs = await getEvents(ctx, { address: ctx.deployment.clearinghouse, abi: clearinghouseAbi, eventName: 'Traded', chunk: 100n });
    expect(calls).toEqual([
      [0n, 24n],
      [25n, 49n],
      [50n, 74n],
      [75n, 99n],
    ]);
    expect(logs.map((l) => l.blockNumber)).toEqual([0n, 25n, 50n, 75n]);
  });

  it('rethrows errors that are not about the range', async () => {
    const client = {
      getBlockNumber: async () => 10n,
      getContractEvents: async () => {
        throw new Error('connection reset');
      },
    } as unknown as PublicClient;
    const ctx = { client, deployment: getDeployment(46630) };
    await expect(getEvents(ctx, { address: ctx.deployment.clearinghouse, abi: clearinghouseAbi, eventName: 'Traded', fromBlock: 0n })).rejects.toThrow('connection reset');
  });

  it('asks for the whole range first', async () => {
    const calls: [bigint, bigint][] = [];
    const client = {
      getBlockNumber: async () => 1_000_000n,
      getContractEvents: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        calls.push([fromBlock, toBlock]);
        return [];
      },
    } as unknown as PublicClient;
    const ctx = { client, deployment: { ...getDeployment(46630), block: 10n } };
    await getEvents(ctx, { address: ctx.deployment.clearinghouse, abi: clearinghouseAbi, eventName: 'Traded' });
    expect(calls).toEqual([[10n, 1_000_000n]]);
  });

  it('backs off on a rate limit instead of shrinking the range', async () => {
    vi.useFakeTimers();
    const calls: [bigint, bigint][] = [];
    let n = 0;
    const client = {
      getBlockNumber: async () => 99n,
      getContractEvents: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        calls.push([fromBlock, toBlock]);
        if (n++ < 2) throw Object.assign(new Error('HTTP request failed. Status: 429. Details: rate limit exceeded'), { status: 429 });
        return [{ blockNumber: fromBlock }];
      },
    } as unknown as PublicClient;
    const ctx = { client, deployment: { ...getDeployment(46630), block: 0n } };
    const p = getEvents(ctx, { address: ctx.deployment.clearinghouse, abi: clearinghouseAbi, eventName: 'Traded' });
    await vi.runAllTimersAsync();
    const logs = await p;
    vi.useRealTimers();
    expect(calls).toEqual([
      [0n, 99n],
      [0n, 99n],
      [0n, 99n],
    ]);
    expect(logs).toHaveLength(1);
    expect(isRateLimited(new Error('rate limit exceeded'))).toBe(true);
    expect(isRangeTooWide(new Error('rate limit exceeded'))).toBe(false);
    expect(isRangeTooWide(new Error('query returned more than 10000 results'))).toBe(true);
  });

  it('refuses a chunk under one block', async () => {
    const ctx = { client: { getBlockNumber: async () => 9n } as unknown as PublicClient, deployment: getDeployment(46630) };
    await expect(getEvents(ctx, { address: ctx.deployment.clearinghouse, abi: clearinghouseAbi, eventName: 'Traded', chunk: 0n })).rejects.toThrow(RangeError);
  });

  it('with a cache, fetches only the blocks after the last scan', async () => {
    const calls: [bigint, bigint][] = [];
    let head = 100n;
    const client = {
      getBlockNumber: async () => head,
      getContractEvents: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        calls.push([fromBlock, toBlock]);
        return [{ blockNumber: toBlock }];
      },
    } as unknown as PublicClient;
    const ctx = { client, deployment: { ...getDeployment(46630), block: 0n }, eventCache: memoryEventCache() };
    const q = { address: ctx.deployment.clearinghouse, abi: clearinghouseAbi, eventName: 'Traded' as const };
    expect(await getEvents(ctx, q)).toHaveLength(1);
    expect(await getEvents(ctx, q)).toHaveLength(1);
    head = 150n;
    const third = await getEvents(ctx, q);
    expect(third.map((l) => l.blockNumber)).toEqual([100n, 150n]);
    expect(calls).toEqual([
      [0n, 100n],
      [101n, 150n],
    ]);
    // another filter is another scan
    await getEvents(ctx, { ...q, args: { takerId: 4n } });
    expect(calls.at(-1)).toEqual([0n, 150n]);
  });
});

describe('sendRequest', () => {
  it('refuses a wallet that would ask the node to sign', async () => {
    const wallet = createWalletClient({ account: '0x00000000000000000000000000000000000000aa', chain: robinhoodChainTestnet, transport: http('http://127.0.0.1:1') });
    const client = {} as PublicClient;
    await expect(sendRequest(wallet, client, undefined, {} as never)).rejects.toThrow(/LocalAccount/);
  });

  it('refuses a request simulated for another account', async () => {
    const account = privateKeyToAccount(keccak256(toHex('novation-test-signer')));
    const wallet = createWalletClient({ account, chain: robinhoodChainTestnet, transport: http('http://127.0.0.1:1') });
    const request = { account: '0x00000000000000000000000000000000000000aa' } as never;
    await expect(sendRequest(wallet, {} as PublicClient, undefined, request)).rejects.toThrow(/simulated for/);
  });
});

describe('createNovation', () => {
  it('binds every helper to the deployment for a chain', () => {
    const n = createNovation({ chainId: 46630 });
    expect(n.deployment.clearinghouse).toBe(getDeployment(46630).clearinghouse);
    expect(n.client.chain?.id).toBe(robinhoodChainTestnet.id);
    expect(typeof n.clearinghouse.getAccountState).toBe('function');
    expect(typeof n.writes.simulateVaultBuy).toBe('function');
    expect(typeof n.kernel.scenarioGridFor).toBe('function');
    expect(typeof n.rfq.quoteHash).toBe('function');
  });
});
