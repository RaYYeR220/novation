import {
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  toHex,
  type Account,
  type LocalAccount,
  type Address,
  type Hex,
  type PublicClient,
  type TypedDataDomain,
  type WalletClient,
} from 'viem';
import type { RfqQuote } from './types';

/** RfqVenue is EIP712("Novation RFQ", "1"). */
export const RFQ_DOMAIN_NAME = 'Novation RFQ';
export const RFQ_DOMAIN_VERSION = '1';

/** The struct string behind RfqVenue.QUOTE_TYPEHASH, verbatim. */
export const QUOTE_TYPE_STRING =
  'Quote(address signer,uint256 makerId,uint32 seriesId,bool makerSells,uint256 maxQty,uint256 price,uint64 deadline,uint256 nonce)';
export const QUOTE_TYPEHASH = keccak256(toHex(QUOTE_TYPE_STRING));

export const QUOTE_TYPES = {
  Quote: [
    { name: 'signer', type: 'address' },
    { name: 'makerId', type: 'uint256' },
    { name: 'seriesId', type: 'uint32' },
    { name: 'makerSells', type: 'bool' },
    { name: 'maxQty', type: 'uint256' },
    { name: 'price', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

export function rfqDomain(chainId: number, rfq: Address): TypedDataDomain {
  return { name: RFQ_DOMAIN_NAME, version: RFQ_DOMAIN_VERSION, chainId, verifyingContract: rfq };
}

const message = (q: RfqQuote) => ({
  signer: q.signer,
  makerId: q.makerId,
  seriesId: q.seriesId,
  makerSells: q.makerSells,
  maxQty: q.maxQty,
  price: q.price,
  deadline: q.deadline,
  nonce: q.nonce,
});

/** RfqVenue.hashQuote(q), computed locally: the digest the maker signs. */
export function hashQuote(q: RfqQuote, domain: TypedDataDomain): Hex {
  return hashTypedData({ domain, types: QUOTE_TYPES, primaryType: 'Quote', message: message(q) });
}

/**
 * Signs `q` as EIP-712 typed data. `signer` is a local account (privateKeyToAccount) or a wallet
 * client with an account; its address must equal `q.signer` for the venue to accept it.
 */
export async function signQuote(signer: Account | WalletClient, q: RfqQuote, domain: TypedDataDomain): Promise<Hex> {
  const args = { domain, types: QUOTE_TYPES, primaryType: 'Quote' as const, message: message(q) };
  if ('type' in signer && signer.type === 'local') return (signer as LocalAccount).signTypedData(args);
  const wc = signer as WalletClient;
  if (!wc.account) throw new Error('signQuote: the wallet client has no account');
  return wc.signTypedData({ ...args, account: wc.account });
}

/** The address that signed `q` (EOA signatures). */
export async function recoverQuoteSigner(q: RfqQuote, signature: Hex, domain: TypedDataDomain): Promise<Address> {
  return recoverTypedDataAddress({ domain, types: QUOTE_TYPES, primaryType: 'Quote', message: message(q), signature });
}

/**
 * True when `signature` is `q.signer`'s over `q`. With a public client, smart-account signers are
 * checked through ERC-1271 too, like the venue's SignatureChecker.
 */
export async function verifyQuote(q: RfqQuote, signature: Hex, domain: TypedDataDomain, client?: PublicClient): Promise<boolean> {
  if (client) {
    return client.verifyTypedData({ address: q.signer, domain, types: QUOTE_TYPES, primaryType: 'Quote', message: message(q), signature });
  }
  try {
    return (await recoverQuoteSigner(q, signature, domain)).toLowerCase() === q.signer.toLowerCase();
  } catch {
    return false;
  }
}

/** A fresh 256-bit nonce. Nonces are a bitmap per signer: any unused value works. */
export function randomNonce(): bigint {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return BigInt(toHex(b));
}
