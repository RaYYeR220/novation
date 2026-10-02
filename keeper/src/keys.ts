import { concat, hexToBigInt, keccak256, toHex, type Hex } from 'viem';
import { isTestChain } from './keeper';

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaae6dc5f6af48a03bbfd25e8cd0364141n;

function normalize(key: string): Hex {
  const h = (key.startsWith('0x') ? key : `0x${key}`).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(h)) throw new Error('expected a 32-byte hex private key');
  return h as Hex;
}

/**
 * The keeper's own key, derived from the deployer key: keccak256(deployerKey || "keeper"),
 * re-hashed in the (astronomically unlikely) case it falls outside the curve order. Nothing new
 * has to be stored: whoever holds the deployer key can always recompute it. A testnet convenience
 * only: it puts the deployer key on the keeper's host and makes one secret worth both keys.
 */
export function deriveKeeperKey(deployerKey: string, label = 'keeper'): Hex {
  let k = keccak256(concat([normalize(deployerKey), toHex(label)]));
  while (hexToBigInt(k) === 0n || hexToBigInt(k) >= SECP256K1_N) k = keccak256(k);
  return k;
}

/**
 * The key the keeper signs with on `chainId`: KEEPER_PRIVATE_KEY when set. Without it, the key
 * derived from DEPLOYER_PRIVATE_KEY, on the testnet and a local chain only; any other chain needs
 * an independent KEEPER_PRIVATE_KEY.
 */
export function keeperKeyFromEnv(chainId: number, env: Record<string, string | undefined> = process.env): Hex {
  if (env.KEEPER_PRIVATE_KEY) return normalize(env.KEEPER_PRIVATE_KEY);
  if (!isTestChain(chainId)) {
    throw new Error(`chain ${chainId} needs KEEPER_PRIVATE_KEY: the key derived from the deployer key is for the testnet only`);
  }
  if (!env.DEPLOYER_PRIVATE_KEY) throw new Error('set KEEPER_PRIVATE_KEY (or, on the testnet, DEPLOYER_PRIVATE_KEY) in .env');
  return deriveKeeperKey(env.DEPLOYER_PRIVATE_KEY);
}
