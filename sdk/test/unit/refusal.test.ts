import { describe, expect, it } from 'vitest';
import { BaseError, encodeErrorResult, type AbiParameter } from 'viem';
import { decodeRefusal, decodeRevertData, novationErrorsAbi, refusalMessage, RefusalError, revertDataOf, throwAsRefusal } from '../../src/index';

const ADDR = '0x00000000000000000000000000000000000000aa';

function sample(p: AbiParameter, i: number): unknown {
  if (p.type === 'address') return ADDR;
  if (p.type === 'bool') return true;
  if (p.type === 'string') return 'why';
  if (p.type.startsWith('bytes')) return `0x${'ab'.repeat(Number(p.type.slice(5)) || 4)}`;
  const bits = Number(p.type.replace(/^u?int/, '')) || 256;
  const scale = bits >= 72 ? 10n ** 18n : 1n;
  if (p.type.startsWith('uint')) return BigInt(i + 1) * scale;
  if (p.type.startsWith('int')) return -BigInt(i + 1) * scale;
  throw new Error(`no sample for ${p.type}`);
}

describe('refusal decoding', () => {
  const errors = novationErrorsAbi.filter((e) => e.type === 'error');

  it('collects every custom error of the contracts and their libraries', () => {
    const names = new Set(errors.map((e) => e.name));
    for (const n of [
      'InsufficientMargin',
      'AgentRiskBudgetExceeded',
      'AgentPremiumExceeded',
      'AgentValueDrainExceeded',
      'AgentUnderlyingNotAllowed',
      'OpeningNotAllowed',
      'OpenInterestCap',
      'VaultNotLive',
      'InsufficientCash',
      'BadSignature',
      'ExitCooldown',
      'NoPrice',
      'BidRaisesRisk',
      'ERC20InsufficientAllowance',
    ])
      expect(names, n).toContain(n);
    expect(errors.length).toBeGreaterThan(100);
  });

  it.each(errors.map((e) => [e.name, e] as const))('decodes %s with every argument by name', (name, e) => {
    const args = e.inputs.map((p, i) => sample(p as AbiParameter, i));
    const data = encodeErrorResult({ abi: [e], errorName: name, args: args as never });
    const r = decodeRevertData(data);
    expect(r?.code).toBe(name);
    expect(r?.selector).toBe(data.slice(0, 10));
    expect(r?.message.length).toBeGreaterThan(0);
    e.inputs.forEach((p, i) => {
      const key = p.name || `arg${i}`;
      expect(r?.args).toHaveProperty(key);
      if (p.type.startsWith('uint') || p.type.startsWith('int')) expect(typeof r?.numbers[key]).toBe('number');
    });
  });

  it('turns WAD amounts into floats and keeps ids and times as integers', () => {
    const e = errors.find((x) => x.name === 'InsufficientMargin')!;
    const data = encodeErrorResult({ abi: [e], errorName: 'InsufficientMargin', args: [7n, -1_500_000_000_000_000_000n, 2_250_000_000_000_000_000n] as never });
    const r = decodeRevertData(data)!;
    expect(r.numbers).toEqual({ id: 7, equity: -1.5, im: 2.25 });
    expect(r.args).toEqual({ id: 7n, equity: -1_500_000_000_000_000_000n, im: 2_250_000_000_000_000_000n });
    expect(r.message).toBe(refusalMessage('InsufficientMargin'));

    const c = errors.find((x) => x.name === 'ExitCooldown')!;
    const cd = decodeRevertData(encodeErrorResult({ abi: [c], errorName: 'ExitCooldown', args: [ADDR, 1790000000n] as never }))!;
    expect(cd.numbers).toEqual({ until: 1790000000 });
    expect(String(cd.args.owner).toLowerCase()).toBe(ADDR);

    const b = errors.find((x) => x.name === 'ERC20InsufficientBalance')!;
    const bd = decodeRevertData(encodeErrorResult({ abi: [b], errorName: 'ERC20InsufficientBalance', args: [ADDR, 5_000_000n, 9_000_000n] as never }))!;
    expect(bd.numbers).toEqual({ balance: 5_000_000, needed: 9_000_000 });
  });

  it('keeps the legs of BelowMinOut in raw units and explains the new auction refusals', () => {
    const e = errors.find((x) => x.name === 'BelowMinOut')!;
    const r = decodeRevertData(encodeErrorResult({ abi: [e], errorName: 'BelowMinOut', args: [1_234_567_890_123_456_789n, 4_200_000n] as never }))!;
    expect(r.numbers).toEqual({ tokens: 1_234_567_890_123_456_789, cash: 4_200_000 });
    expect(r.message).toBe(refusalMessage('BelowMinOut'));
    for (const name of ['BelowMinOut', 'StillLiquidatable', 'AuctionActive', 'AuctionNotActive', 'DepositNotAllowed']) {
      expect(refusalMessage(name), name).not.toMatch(/^Reverted with/);
    }
    const s = errors.find((x) => x.name === 'StillLiquidatable')!;
    expect(decodeRevertData(encodeErrorResult({ abi: [s], errorName: 'StillLiquidatable' }))?.code).toBe('StillLiquidatable');
  });

  it('explains the settlement last resort, the claim-expiry cap and the vol catch-up refusals', () => {
    for (const name of ['FallbackApplies', 'TooManyClaimExpiries', 'VolNotCurrent', 'TooManyUnderlyings']) {
      expect(errors.some((x) => x.name === name), name).toBe(true);
      expect(refusalMessage(name), name).not.toMatch(/^Reverted with/);
    }
    // the auction house's VolNotCurrent names the underlying; the vault's has no argument: both decode
    const withU = errors.find((x) => x.name === 'VolNotCurrent' && x.inputs.length === 1)!;
    const bare = errors.find((x) => x.name === 'VolNotCurrent' && x.inputs.length === 0)!;
    expect(decodeRevertData(encodeErrorResult({ abi: [withU], errorName: 'VolNotCurrent', args: [ADDR] as never }))).toMatchObject({
      code: 'VolNotCurrent',
      args: { underlying: expect.stringMatching(/aa$/i) },
    });
    expect(decodeRevertData(encodeErrorResult({ abi: [bare], errorName: 'VolNotCurrent' }))?.code).toBe('VolNotCurrent');
    const t = errors.find((x) => x.name === 'TooManyClaimExpiries')!;
    expect(decodeRevertData(encodeErrorResult({ abi: [t], errorName: 'TooManyClaimExpiries', args: [42n] as never }))?.numbers).toEqual({ id: 42 });
    const f = errors.find((x) => x.name === 'FallbackApplies')!;
    expect(decodeRevertData(encodeErrorResult({ abi: [f], errorName: 'FallbackApplies' }))?.message).toMatch(/fallback/);
  });

  it('finds the revert data anywhere in an error chain', () => {
    const e = errors.find((x) => x.name === 'AgentRiskBudgetExceeded')!;
    const data = encodeErrorResult({ abi: [e], errorName: 'AgentRiskBudgetExceeded', args: [3n, 2n * 10n ** 18n, 10n ** 18n] as never });
    const chain = new BaseError('outer', { cause: new BaseError('rpc', { cause: Object.assign(new Error('inner'), { data }) }) });
    expect(revertDataOf(chain)).toBe(data);
    expect(decodeRefusal(chain)).toMatchObject({ code: 'AgentRiskBudgetExceeded', numbers: { id: 3, worstLoss: 2, budget: 1 } });
    expect(decodeRefusal({ data: { data } })?.code).toBe('AgentRiskBudgetExceeded');
    expect(() => throwAsRefusal(chain)).toThrow(RefusalError);
  });

  it('reads Solidity Error(string) and leaves unknown data alone', () => {
    const data = encodeErrorResult({
      abi: [{ type: 'error', name: 'Error', inputs: [{ name: 'message', type: 'string' }] }],
      errorName: 'Error',
      args: ['testnet only'],
    });
    expect(decodeRevertData(data)).toMatchObject({ code: 'Error', message: 'testnet only' });
    expect(decodeRevertData('0xdeadbeef')).toBeUndefined();
    expect(decodeRefusal(new Error('network down'))).toBeUndefined();
    const plain = new Error('network down');
    expect(() => throwAsRefusal(plain)).toThrow(plain);
  });
});
