import { describe, expect, it } from 'vitest';
import { concat, keccak256, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { toWad } from '@novation/sdk';
import { createRfqHandlerFromEnv, makerKeyFromEnv, pricingFromEnv, rateLimitFromEnv } from '../../src/config';
import { deriveKey, normalizeKey } from '../../src/keys';
import { DEFAULT_PRICING } from '../../src/pricing';

/** anvil's account 0 (public test mnemonic). */
const BASE = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

describe('derived keys', () => {
  it('is keccak256(base key || label), with or without the 0x prefix', () => {
    const want = keccak256(concat([BASE, stringToHex('maker')]));
    expect(deriveKey(BASE, 'maker')).toBe(want);
    expect(deriveKey(BASE.slice(2), 'maker')).toBe(want);
    expect(deriveKey(BASE.toUpperCase().replace('0X', '0x'), 'maker')).toBe(want);
    expect(deriveKey(BASE, 'taker')).not.toBe(want);
    // a usable account
    expect(privateKeyToAccount(want).address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('rejects anything that is not a 32-byte key', () => {
    expect(() => normalizeKey('0x1234')).toThrow();
    expect(() => normalizeKey(`${BASE}00`)).toThrow();
    expect(() => deriveKey(BASE, '')).toThrow();
  });
});

describe('environment', () => {
  it('prefers MM_MAKER_PRIVATE_KEY, else derives from the deployer key on testnet only', () => {
    const own = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
    expect(makerKeyFromEnv({ MM_MAKER_PRIVATE_KEY: own, DEPLOYER_PRIVATE_KEY: BASE })).toBe(own);
    expect(makerKeyFromEnv({ DEPLOYER_PRIVATE_KEY: BASE })).toBe(deriveKey(BASE, 'maker'));
    expect(makerKeyFromEnv({ DEPLOYER_PRIVATE_KEY: BASE, MM_CHAIN_ID: '46630' })).toBe(deriveKey(BASE, 'maker'));
    expect(() => makerKeyFromEnv({})).toThrow(/MM_MAKER_PRIVATE_KEY/);
    // any other chain (mainnet, anvil) needs its own key
    for (const id of ['4663', '31337', '1']) {
      expect(() => makerKeyFromEnv({ DEPLOYER_PRIVATE_KEY: BASE, MM_CHAIN_ID: id })).toThrow(/MM_MAKER_PRIVATE_KEY/);
      expect(makerKeyFromEnv({ DEPLOYER_PRIVATE_KEY: BASE, MM_MAKER_PRIVATE_KEY: own, MM_CHAIN_ID: id })).toBe(own);
    }
  });

  it('fails fast on a bad setting when the route handler is built', () => {
    const ok = { DEPLOYER_PRIVATE_KEY: BASE };
    expect(() => createRfqHandlerFromEnv(ok)).not.toThrow();
    expect(() => createRfqHandlerFromEnv({ ...ok, MM_PRICE_SPREAD: '-0.2' })).toThrow(RangeError);
    expect(() => createRfqHandlerFromEnv({ DEPLOYER_PRIVATE_KEY: BASE, MM_CHAIN_ID: '4663' })).toThrow(/MM_MAKER_PRIVATE_KEY/);
    expect(() => createRfqHandlerFromEnv({ ...ok, MM_RATE_BURST: '0' })).toThrow();
  });

  it('reads the rate limit', () => {
    expect(rateLimitFromEnv({})).toEqual({ burst: 10, perMinute: 30 });
    expect(rateLimitFromEnv({ MM_RATE_BURST: '3', MM_RATE_PER_MIN: '12' })).toEqual({ burst: 3, perMinute: 12 });
    expect(rateLimitFromEnv({ MM_RATE_PER_MIN: '0' })).toBe(false);
  });

  it('reads pricing overrides and keeps the defaults otherwise', () => {
    expect(pricingFromEnv({})).toEqual(DEFAULT_PRICING);
    const p = pricingFromEnv({ MM_VOL_SPREAD: '0.08', MM_MAX_QTY: '2.5', MM_TTL: '30', MM_MAX_PRICE_AGE: '600', MM_MARGIN_BUFFER: '0.5' });
    expect(p.volSpread).toBe(toWad('0.08'));
    expect(p.maxQtyPerQuote).toBe(toWad('2.5'));
    expect(p.ttl).toBe(30);
    expect(p.maxPriceAge).toBe(600);
    expect(p.marginBuffer).toBe(toWad('0.5'));
    expect(p.priceSpread).toBe(DEFAULT_PRICING.priceSpread);
    expect(() => pricingFromEnv({ MM_TTL: '0' })).toThrow();
    expect(() => pricingFromEnv({ MM_TTL: '1.5' })).toThrow();
    expect(pricingFromEnv({ MM_TTL: '10' }).indicativeTtl).toBe(10);
    for (const [k, v] of [
      ['MM_PRICE_SPREAD', '-0.2'],
      ['MM_PRICE_SPREAD', '1.5'],
      ['MM_MARGIN_BUFFER', '-0.5'],
      ['MM_VOL_SPREAD', '-0.3'],
      ['MM_MAX_QTY', '0'],
      ['MM_MAX_INVENTORY', '0'],
      ['MM_DEFAULT_QTY', '11'],
      ['MM_TTL', '301'],
      ['MM_INDICATIVE_TTL', '61'],
      ['MM_SKEW_SLOPE', 'abc'],
    ]) {
      expect(() => pricingFromEnv({ [k as string]: v }), `${k}=${v}`).toThrow();
    }
  });
});
