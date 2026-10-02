import { afterEach, describe, expect, it } from 'vitest';
import type { PublicClient, WalletClient } from 'viem';
import { ChainClient, rfqBand } from '@/lib/client/chain';
import { MAX_PERSISTED_BYTES, MAX_PERSISTED_KEYS, sessionEventCache } from '@/lib/client/event-cache';

const OWNER = '0x00000000000000000000000000000000000000aa';
const AGENT = '0x00000000000000000000000000000000000000bb';
const STRANGER = '0x00000000000000000000000000000000000000cc';

/** A chain where account 4 belongs to OWNER and AGENT holds a live grant on it. */
function client(): PublicClient {
  return {
    chain: { id: 46630 },
    readContract: async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
      if (functionName === 'ownerOf') return OWNER;
      if (functionName === 'isAuthorized') return [OWNER, AGENT].includes(String(args[1]).toLowerCase());
      throw new Error(`unexpected read ${functionName}`);
    },
  } as unknown as PublicClient;
}

function as(address: string): ChainClient {
  const c = new ChainClient({ client: client() });
  c.setWallet({ account: { address, type: 'json-rpc' } } as unknown as WalletClient);
  return c;
}

describe('ChainClient: who may move funds', () => {
  it('refuses a deposit from an agent of the account: an unsolicited grant must never fund it', async () => {
    const c = as(AGENT);
    expect(await c.canAct(4)).toBe(true);
    expect(await c.owns(4)).toBe(false);
    await expect(c.deposit(4, 'USDG', 100)).rejects.toThrow(/one of its agents.*never fund it/);
    await expect(c.withdraw(4, 'USDG', 1)).rejects.toThrow(/Only the owner of account 4/);
    await expect(c.grantAgent(4, { agent: STRANGER, label: 'x', maxWorstLoss: 1, maxPremiumPerTrade: 1, allowed: ['NVDA'], expiresAt: 2e9 })).rejects.toThrow(/Only the owner/);
    await expect(c.revokeAgent(4, STRANGER)).rejects.toThrow(/Only the owner/);
  });

  it('refuses a stranger, and lets only the owner through the owner check', async () => {
    await expect(as(STRANGER).deposit(4, 'USDG', 100)).rejects.toThrow(/doesn't own it/);
    expect(await as(STRANGER).canAct(4)).toBe(false);
    expect(await as(OWNER).owns(4)).toBe(true);
  });
});

describe('ChainClient: sending', () => {
  it('refuses to send once the wallet signs as another account than the one simulated for', async () => {
    const simulated: unknown[] = [];
    const pub = {
      ...client(),
      simulateContract: async (args: { account: string }) => {
        simulated.push(args.account);
        return { request: { ...args }, result: undefined };
      },
    } as unknown as PublicClient;
    const c = new ChainClient({ client: pub });
    c.setWallet({
      account: { address: OWNER, type: 'json-rpc' },
      // the wallet switched to another account after the simulation
      getAddresses: async () => [STRANGER],
      writeContract: async () => {
        throw new Error('must not reach the wallet');
      },
    } as unknown as WalletClient);
    await expect(c.revokeAgent(4, AGENT)).rejects.toThrow(/simulated for 0x0+aa, but the wallet signs as 0x0+cc/i);
    expect(simulated).toEqual([OWNER]);
  });
});

describe('RFQ band', () => {
  it('stays a fraction in (0, 1]', () => {
    expect(rfqBand(undefined)).toBe(0.2);
    expect(rfqBand('0.1')).toBe(0.1);
    expect(rfqBand('20')).toBe(1);
    expect(rfqBand('-1')).toBe(0.2);
    expect(rfqBand('abc')).toBe(0.2);
  });
});

describe('sessionStorage mirror of the event cache', () => {
  const g = globalThis as unknown as { window?: { sessionStorage: Storage } };
  afterEach(() => {
    delete g.window;
  });

  function fakeStorage() {
    const m = new Map<string, string>();
    const s = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    } as unknown as Storage;
    return { m, s };
  }

  it('round-trips bigints and keeps at most MAX_PERSISTED_KEYS entries, oldest out first', () => {
    const { m, s } = fakeStorage();
    g.window = { sessionStorage: s };
    const a = sessionEventCache('t');
    for (let i = 0; i < MAX_PERSISTED_KEYS + 3; i++) a.set(`k${i}`, { from: 1n, to: BigInt(i), logs: [{ blockNumber: 5n }] });
    expect(m.has('t:k0')).toBe(false);
    expect(m.has('t:k2')).toBe(false);
    expect(m.has(`t:k${MAX_PERSISTED_KEYS + 2}`)).toBe(true);
    // a fresh cache (a reload) reads the persisted entries back with their bigints
    const b = sessionEventCache('t');
    expect(b.get('k10')).toEqual({ from: 1n, to: 10n, logs: [{ blockNumber: 5n }] });
    expect(b.get('k0')).toBeUndefined();
  });

  it('keeps an oversized scan in memory only', () => {
    const { m, s } = fakeStorage();
    g.window = { sessionStorage: s };
    const c = sessionEventCache('t');
    const big = { from: 0n, to: 1n, logs: [{ data: 'x'.repeat(MAX_PERSISTED_BYTES) }] };
    c.set('big', big);
    expect(m.has('t:big')).toBe(false);
    expect(c.get('big')).toBe(big);
  });

  it('falls back to memory when storage throws', () => {
    g.window = {
      sessionStorage: {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
        removeItem: () => {},
      } as unknown as Storage,
    };
    const c = sessionEventCache('t');
    c.set('k', { from: 0n, to: 1n, logs: [] });
    expect(c.get('k')).toEqual({ from: 0n, to: 1n, logs: [] });
  });
});
