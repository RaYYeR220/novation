import { afterEach, describe, expect, it } from 'vitest';
import { encodeErrorResult, type Abi, type Address, type PublicClient, type WalletClient } from 'viem';
import { RefusalError, getDeployment, novationErrorsAbi } from '@novation/sdk';
import { ChainClient, refusalOf, rfqBand } from '@/lib/client/chain';
import { refusalCopy } from '@/components/app/refusal-card';
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

/**
 * A chain whose NVDA vol is behind its feed: account 4's withdrawal is refused VolNotCurrent(NVDA)
 * until a syncVol lands. `syncs` is how many syncs it takes to bring the vol up to the feed.
 */
function behindChain(syncs: number) {
  const d = getDeployment(46630);
  const nvda = d.tokens.NVDA! as Address;
  let left = syncs;
  const sent: string[] = [];
  const simulated: string[] = [];
  const revert = (args: unknown[]) =>
    Object.assign(new Error('execution reverted'), { data: encodeErrorResult({ abi: novationErrorsAbi as Abi, errorName: 'VolNotCurrent', args }) });
  const pub = {
    chain: { id: 46630 },
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'ownerOf') return OWNER;
      if (functionName === 'decimals') return 6;
      if (functionName === 'volCurrent') return left === 0;
      // both in the feed's first phase: no migration, so the catch-up is a plain syncVol
      if (functionName === 'volState') return [0n, 0n, (1n << 64n) | 10n, 0n, 0n, 0n];
      if (functionName === 'underlying') return { feed: d.feeds.NVDA };
      if (functionName === 'latestRoundData') return [(1n << 64n) | 90n, 0n, 0n, 0n, (1n << 64n) | 90n];
      throw new Error(`unexpected read ${functionName}`);
    },
    simulateContract: async (a: { functionName: string; account: string }) => {
      simulated.push(a.functionName);
      if (a.functionName === 'withdraw' && left > 0) throw revert([nvda]);
      return { request: { ...a }, result: undefined };
    },
    estimateContractGas: async () => 100_000n,
    waitForTransactionReceipt: async () => ({ status: 'success' }),
  } as unknown as PublicClient;
  const c = new ChainClient({ client: pub });
  c.setWallet({
    account: { address: OWNER, type: 'json-rpc' },
    getAddresses: async () => [OWNER],
    writeContract: async (req: { functionName: string }) => {
      sent.push(req.functionName);
      if (req.functionName === 'syncVol') left = Math.max(0, left - 1);
      return `0x${'ab'.repeat(32)}`;
    },
  } as unknown as WalletClient);
  const told: string[] = [];
  c.onVolSync((symbol) => told.push(symbol));
  return { c, sent, simulated, told, nvda, revert };
}

describe('ChainClient: a vol behind its feed', () => {
  it('syncs the vol a withdrawal is refused for, then sends the withdrawal again', async () => {
    const { c, sent, simulated, told } = behindChain(1);
    await expect(c.withdraw(4, 'USDG', 100)).resolves.toBe(`0x${'ab'.repeat(32)}`);
    expect(simulated).toEqual(['withdraw', 'syncVol', 'withdraw']);
    // nothing reached the wallet before the sync: the refused withdrawal was only simulated
    expect(sent).toEqual(['syncVol', 'withdraw']);
    expect(told).toEqual(['NVDA']);
  });

  it('catches up a long backlog a few syncs at most, then says the vol is still syncing', async () => {
    const { c, sent } = behindChain(10);
    const e = await c.withdraw(4, 'USDG', 100).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RefusalError);
    expect(sent).toEqual(['syncVol', 'syncVol', 'syncVol']);
    const r = refusalOf(e)!;
    expect(r).toMatchObject({ code: 'VolNotCurrent', underlying: 'NVDA', message: 'Syncing the vol of NVDA: retry in a moment.' });
    expect(refusalCopy(r, 'Account 4').reason).toBe('Syncing the vol of NVDA: retry in a moment.');
  });

  it("names the vault's underlying when the vault's own refusal names none", async () => {
    const { c, sent, nvda } = behindChain(1);
    let tries = 0;
    const write = async () => {
      tries++;
      if (tries === 1) throw new RefusalError({ code: 'VolNotCurrent', message: '', selector: '0x', args: {}, numbers: {} });
      return 'sent';
    };
    const syncingVol = (c as unknown as { syncingVol: (t: Address, w: () => Promise<string>) => Promise<string> }).syncingVol.bind(c);
    await expect(syncingVol(nvda, write)).resolves.toBe('sent');
    expect(tries).toBe(2);
    expect(sent).toEqual(['syncVol']);
  });

  it('leaves every other refusal alone', async () => {
    const { c, sent } = behindChain(0);
    const write = async () => {
      throw new RefusalError({ code: 'InsufficientMargin', message: 'Initial margin after the trade exceeds equity.', selector: '0x', args: {}, numbers: {} });
    };
    const syncingVol = (c as unknown as { syncingVol: (t: undefined, w: () => Promise<never>) => Promise<never> }).syncingVol.bind(c);
    await expect(syncingVol(undefined, write)).rejects.toThrow(/InsufficientMargin/);
    expect(sent).toEqual([]);
  });

  it('decodes both forms of the refusal, by symbol where it names one', () => {
    const { revert } = behindChain(0);
    const d = getDeployment(46630);
    expect(refusalOf(revert([d.tokens.TSLA]))).toMatchObject({ code: 'VolNotCurrent', underlying: 'TSLA' });
    const vaultForm = refusalOf(revert([]))!;
    expect(vaultForm.code).toBe('VolNotCurrent');
    expect(vaultForm.underlying).toBeUndefined();
    expect(refusalCopy(vaultForm, 'Account 4').reason).toBe('Syncing a vol estimate: retry in a moment.');
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
