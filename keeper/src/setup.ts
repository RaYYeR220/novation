/**
 * One-off actions around the keeper key: topping up its gas from the deployer, and opening and
 * funding its own subaccounts (mock USDG on testnet is public-mint).
 */
import { createWalletClient, erc20Abi, formatEther, http, maxUint256, type Chain, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getCash, getSubaccountsOf, simulateApprove, simulateCreateSubaccount, simulateDeposit, simulateMint, fromWad, tokenOf } from '@novation/sdk';
import { execute, isTestChain, padGas, txUrl, type Keeper, type TxRecord } from './keeper';
import type { Logger } from './log';

/** Hard cap on one top-up from the deployer. */
export const MAX_TOP_UP = 600_000_000_000_000n; // 0.0006 ETH

/**
 * Tops the keeper address up to `target` wei from the deployer key, never sending more than
 * MAX_TOP_UP in one go. Returns the transfer, or null when the keeper already holds `target`.
 */
export async function topUpKeeper(a: {
  client: PublicClient;
  chain: Chain;
  rpcUrl?: string;
  deployerKey: Hex;
  keeper: `0x${string}`;
  target: bigint;
  log: Logger;
}): Promise<TxRecord | null> {
  const have = await a.client.getBalance({ address: a.keeper });
  if (have >= a.target) {
    a.log('info', 'fund', 'skip', { keeper: a.keeper, eth: formatEther(have), reason: 'already funded' });
    return null;
  }
  const value = a.target - have > MAX_TOP_UP ? MAX_TOP_UP : a.target - have;
  const deployer = privateKeyToAccount(a.deployerKey);
  const wallet = createWalletClient({ account: deployer, chain: a.chain, transport: http(a.rpcUrl) });
  const estimate = await a.client.estimateGas({ account: deployer, to: a.keeper, value });
  const hash = await wallet.sendTransaction({ to: a.keeper, value, gas: padGas(estimate) });
  const rc = await a.client.waitForTransactionReceipt({ hash, timeout: 180_000 });
  const base = a.chain.blockExplorers?.default.url;
  const rec: TxRecord = {
    job: 'fund',
    label: `fund keeper ${formatEther(value)} ETH`,
    hash,
    status: rc.status,
    gasUsed: rc.gasUsed,
    block: rc.blockNumber,
    ...(base ? { url: `${base}/tx/${hash}` } : {}),
  };
  a.log(rc.status === 'success' ? 'info' : 'error', 'fund', 'tx', { ...rec, from: deployer.address, to: a.keeper, eth: formatEther(value) });
  return rec;
}

/** The keeper's subaccounts, creating new ones until it has `n`. */
export async function ensureSubaccounts(k: Keeper, n: number): Promise<bigint[]> {
  let ids = await getSubaccountsOf(k.ctx, k.account.address);
  while (ids.length < n) {
    const rec = await execute(k, 'setup', 'createSubaccount', () => simulateCreateSubaccount(k.ctx, k.account));
    if (rec?.status !== 'success') throw new Error('createSubaccount failed');
    ids = await getSubaccountsOf(k.ctx, k.account.address);
  }
  return ids;
}

/**
 * Brings subaccount `id`'s cash up to `wad` USDG: mints mock USDG to the keeper (testnet mocks are
 * public-mint), approves the clearinghouse once and deposits the difference.
 */
export async function fundSubaccount(k: Keeper, id: bigint, wad: bigint): Promise<void> {
  const cash = await getCash(k.ctx, id);
  if (cash >= wad) {
    k.log('info', 'setup', 'skip', { id, cash: fromWad(cash), reason: 'already funded' });
    return;
  }
  await depositUsdg(k, 'setup', id, wad - cash);
}

/**
 * Deposits at least `wad` USDG (rounded up to whole token units) from the keeper's wallet into
 * subaccount `id`, which anyone may fund with USDG. On the testnet or a local chain the shortfall is
 * minted first (the mock is public-mint); elsewhere a wallet short of USDG is a logged skip. Approves
 * the clearinghouse once.
 */
export async function depositUsdg(k: Keeper, job: string, id: bigint, wad: bigint): Promise<TxRecord | null> {
  const usdg = tokenOf(k.ctx.deployment, 'USDG');
  const decimals = await k.client.readContract({ address: usdg, abi: erc20Abi, functionName: 'decimals' });
  const scale = 10n ** BigInt(18 - decimals);
  const raw = (wad + scale - 1n) / scale;
  const me = k.account.address;
  const bal = await k.client.readContract({ address: usdg, abi: erc20Abi, functionName: 'balanceOf', args: [me] });
  if (bal < raw) {
    // only the testnet's mock USDG mints freely; anywhere else the keeper must hold the USDG
    if (!isTestChain(k.chain.id)) {
      k.log('warn', job, 'skip', { label: `deposit USDG into ${id}`, reason: `the keeper wallet holds ${bal} raw USDG, ${raw} needed`, id });
      return null;
    }
    await execute(k, job, 'mint USDG', () => simulateMint(k.ctx, k.account, usdg, me, raw - bal), { amount: raw - bal });
  }
  const allowance = await k.client.readContract({ address: usdg, abi: erc20Abi, functionName: 'allowance', args: [me, k.ctx.deployment.clearinghouse] });
  if (allowance < raw) await execute(k, job, 'approve USDG', () => simulateApprove(k.ctx, k.account, usdg, k.ctx.deployment.clearinghouse, maxUint256));
  return execute(k, job, `deposit USDG into ${id}`, () => simulateDeposit(k.ctx, k.account, id, usdg, raw), { id, amount: raw });
}

export { txUrl };
