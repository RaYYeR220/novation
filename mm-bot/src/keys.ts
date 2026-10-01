import { concat, keccak256, toHex, type Hex } from 'viem';

/** secp256k1 group order: a private key must be in [1, N). */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** A 32-byte private key as 0x-prefixed lowercase hex, with or without the prefix on input. */
export function normalizeKey(key: string): Hex {
  const k = key.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(k)) throw new Error('expected a 32-byte hex private key');
  return `0x${k}`;
}

/**
 * A key derived deterministically from another: keccak256(baseKey || utf8(label)). The maker and
 * the demo taker are derived from the deployer's key with the labels "maker" and "taker", so they
 * can be recreated wherever the deployer key is, and no new secret has to be stored.
 */
export function deriveKey(baseKey: string, label: string): Hex {
  if (!label) throw new Error('deriveKey: empty label');
  const out = keccak256(concat([normalizeKey(baseKey), toHex(label)]));
  const v = BigInt(out);
  if (v === 0n || v >= N) throw new Error(`deriveKey: "${label}" gives an invalid key; pick another label`);
  return out;
}
