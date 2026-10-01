import { concat, hexToBigInt, keccak256, toHex, type Hex } from 'viem';

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaae6dc5f6af48a03bbfd25e8cd0364141n;

function normalize(key: string): Hex {
  const h = (key.startsWith('0x') ? key : `0x${key}`).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(h)) throw new Error('expected a 32-byte hex private key');
  return h as Hex;
}

/**
 * The keeper's own key, derived from the deployer key: keccak256(deployerKey || "keeper"),
 * re-hashed in the (astronomically unlikely) case it falls outside the curve order. Nothing new
 * has to be stored: whoever holds the deployer key can always recompute it.
 */
export function deriveKeeperKey(deployerKey: string, label = 'keeper'): Hex {
  let k = keccak256(concat([normalize(deployerKey), toHex(label)]));
  while (hexToBigInt(k) === 0n || hexToBigInt(k) >= SECP256K1_N) k = keccak256(k);
  return k;
}
