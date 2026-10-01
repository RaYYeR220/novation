import { describe, expect, it } from 'vitest';
import { concat, encodeAbiParameters, keccak256, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  getDeployment,
  hashQuote,
  QUOTE_TYPEHASH,
  QUOTE_TYPE_STRING,
  randomNonce,
  recoverQuoteSigner,
  rfqDomain,
  rfqPremium,
  signQuote,
  verifyQuote,
  type RfqQuote,
} from '../../src/index';

// a throwaway key used only by this test; it holds nothing on any chain
const KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const maker = privateKeyToAccount(KEY);
const RFQ = getDeployment(46630).rfq;

const quote: RfqQuote = {
  signer: maker.address,
  makerId: 5n,
  seriesId: 20,
  makerSells: false,
  maxQty: 5n * 10n ** 18n,
  price: 15_191_009_000_000_000_000n,
  deadline: 1_790_000_000n,
  nonce: 1_759_320_000n,
};

/** RfqVenue.hashQuote, written out the way Solidity computes it. */
function solidityHash(q: RfqQuote, chainId: number, verifying: Hex): Hex {
  const domainTypehash = keccak256(toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [domainTypehash, keccak256(toHex('Novation RFQ')), keccak256(toHex('1')), BigInt(chainId), verifying],
    ),
  );
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint32' },
        { type: 'bool' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint64' },
        { type: 'uint256' },
      ],
      [QUOTE_TYPEHASH, q.signer, q.makerId, q.seriesId, q.makerSells, q.maxQty, q.price, q.deadline, q.nonce],
    ),
  );
  return keccak256(concat(['0x1901', domainSeparator, structHash]));
}

describe('EIP-712 quotes', () => {
  it("uses RfqVenue's type string and typehash", () => {
    expect(QUOTE_TYPE_STRING).toBe(
      'Quote(address signer,uint256 makerId,uint32 seriesId,bool makerSells,uint256 maxQty,uint256 price,uint64 deadline,uint256 nonce)',
    );
    expect(QUOTE_TYPEHASH).toBe(keccak256(toHex(QUOTE_TYPE_STRING)));
  });

  it('hashes exactly like the contract (domain separator + struct hash)', () => {
    const domain = rfqDomain(46630, RFQ);
    expect(hashQuote(quote, domain)).toBe(solidityHash(quote, 46630, RFQ));
    // the domain binds chain and venue
    expect(hashQuote(quote, rfqDomain(4663, RFQ))).not.toBe(hashQuote(quote, domain));
  });

  it('signs, recovers and verifies; any changed field fails', async () => {
    const domain = rfqDomain(46630, RFQ);
    const sig = await signQuote(maker, quote, domain);
    expect(await recoverQuoteSigner(quote, sig, domain)).toBe(maker.address);
    expect(await verifyQuote(quote, sig, domain)).toBe(true);
    for (const k of ['makerId', 'maxQty', 'price', 'deadline', 'nonce'] as const) {
      expect(await verifyQuote({ ...quote, [k]: quote[k] + 1n }, sig, domain), k).toBe(false);
    }
    expect(await verifyQuote({ ...quote, makerSells: true }, sig, domain)).toBe(false);
    expect(await verifyQuote({ ...quote, seriesId: 21 }, sig, domain)).toBe(false);
  });

  it('rounds the premium against the payer', () => {
    const q = { ...quote, price: 1_000_000_000_000_000_001n };
    expect(rfqPremium({ ...q, makerSells: true }, 10n ** 18n)).toBe(1_000_000_000_000_000_001n);
    expect(rfqPremium({ ...q, makerSells: true }, 3n)).toBe(4n); // ceil(3.000...003)
    expect(rfqPremium({ ...q, makerSells: false }, 3n)).toBe(3n); // floor
  });

  it('draws fresh 256-bit nonces', () => {
    const a = randomNonce();
    expect(a).not.toBe(randomNonce());
    expect(a < 2n ** 256n).toBe(true);
  });
});
