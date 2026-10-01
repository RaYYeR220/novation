/**
 * Shared by the setup and fill scripts: wallets on the chain the environment names, a small ETH
 * top-up from the deployer, and a funded clearinghouse subaccount. Keys are never printed.
 */
import { createWalletClient, formatEther, http, maxUint256, parseEther, type Address, type WalletClient } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import {
  createNovation,
  erc20Abi,
  getAccountState,
  getSubaccountsOf,
  sendRequest,
  simulateApprove,
  simulateCreateSubaccount,
  simulateDeposit,
  simulateMint,
  type Novation,
} from '@novation/sdk';
import { DEMO_CHAIN_ID } from '../src/config';
import { deriveKey } from '../src/keys';

export interface Actor {
  account: PrivateKeyAccount;
  wallet: WalletClient;
}

export function chainFromEnv(env: NodeJS.ProcessEnv = process.env): Novation {
  const chainId = Number(env.MM_CHAIN_ID || 46630);
  const rpcUrl = env.MM_RPC_URL || (chainId === 46630 ? env.RH_TESTNET_RPC : env.RH_MAINNET_RPC) || undefined;
  return createNovation({ chainId, rpcUrl });
}

export function actor(n: Novation, key: `0x${string}`): Actor {
  const account = privateKeyToAccount(key);
  const url = (n.client.transport as { url?: string }).url;
  return { account, wallet: createWalletClient({ account, chain: n.client.chain, transport: http(url) }) };
}

/**
 * The deployer and an actor derived from its key with `label`. A testnet demo convenience only:
 * whoever holds the deployer key controls the derived accounts, so it is refused on other chains.
 */
export function deployerAnd(n: Novation, label: string, env: NodeJS.ProcessEnv = process.env): { deployer: Actor; derived: Actor } {
  if (n.deployment.chainId !== DEMO_CHAIN_ID) throw new Error(`derived ${label} keys are for Robinhood Chain testnet only, not chain ${n.deployment.chainId}`);
  const key = env.DEPLOYER_PRIVATE_KEY;
  if (!key) throw new Error('DEPLOYER_PRIVATE_KEY is not set (see .env.example)');
  const deployer = actor(n, (key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`);
  return { deployer, derived: actor(n, deriveKey(key, label)) };
}

/**
 * Sends a simulated request with 25% gas headroom over the estimate. Margin checks run
 * Black-Scholes, whose cost moves a little with the block timestamp, so an exact estimate can
 * leave a sub-call short of gas when the transaction lands in a later block.
 */
export async function sendWithHeadroom(n: Novation, a: Actor, request: Parameters<typeof sendRequest>[3]) {
  const gas = await n.client.estimateContractGas(request as Parameters<typeof n.client.estimateContractGas>[0]);
  return sendRequest(a.wallet, n.client, n.ctx, { ...request, gas: gas + gas / 4n } as Parameters<typeof sendRequest>[3]);
}

export function log(o: Record<string, unknown>) {
  console.log(JSON.stringify({ t: new Date().toISOString(), ...o }, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

/**
 * Tops `to` up to `target` ETH from the deployer when it holds less than `min`. Never sends more
 * than `cap` in one go. Retries on a nonce clash (other jobs share the deployer).
 */
export async function topUpEth(n: Novation, from: Actor, to: Address, opts: { min: string; target: string; cap: string }): Promise<void> {
  const have = await n.client.getBalance({ address: to });
  if (have >= parseEther(opts.min)) {
    log({ msg: 'eth ok', address: to, eth: formatEther(have) });
    return;
  }
  let value = parseEther(opts.target) - have;
  if (value > parseEther(opts.cap)) value = parseEther(opts.cap);
  for (let attempt = 0; ; attempt++) {
    try {
      const nonce = await n.client.getTransactionCount({ address: from.account.address, blockTag: 'pending' });
      const hash = await from.wallet.sendTransaction({ account: from.account, chain: n.client.chain, to, value, nonce });
      const rc = await n.client.waitForTransactionReceipt({ hash });
      if (rc.status !== 'success') throw new Error(`eth transfer ${hash} reverted`);
      log({ msg: 'eth sent', to, eth: formatEther(value), tx: hash });
      return;
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (attempt < 3 && /nonce|underpriced|already known/i.test(m)) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      throw e;
    }
  }
}

/**
 * The actor's first subaccount (created if it has none) with at least `cash` USDG deposited:
 * mints mock USDG for the shortfall, approves the clearinghouse and deposits.
 */
export async function fundedAccount(n: Novation, a: Actor, cash: bigint): Promise<bigint> {
  const me = a.account.address;
  const ctx = n.ctx;
  const USDG = ctx.deployment.tokens.USDG as Address;
  let id = (await getSubaccountsOf(ctx, me))[0];
  if (id === undefined) {
    const created = await simulateCreateSubaccount(ctx, a.account);
    const { hash } = await sendRequest(a.wallet, n.client, ctx, created.request);
    // the id is assigned at inclusion: read it back rather than trust the simulation
    id = (await getSubaccountsOf(ctx, me))[0];
    if (id === undefined) throw new Error(`subaccount creation ${hash} left ${me} without a subaccount`);
    log({ msg: 'subaccount created', owner: me, id, tx: hash });
  }
  const st = await getAccountState(ctx, id);
  if (st.cash >= cash) {
    log({ msg: 'cash ok', id, cash: st.cash });
    return id;
  }
  const need = (cash - st.cash + 10n ** 12n - 1n) / 10n ** 12n; // raw USDG (6 decimals), rounded up
  const held = await n.client.readContract({ address: USDG, abi: erc20Abi, functionName: 'balanceOf', args: [me] });
  if (held < need) {
    const { hash } = await sendRequest(a.wallet, n.client, ctx, (await simulateMint(ctx, a.account, USDG, me, need - held)).request);
    log({ msg: 'usdg minted', to: me, raw: need - held, tx: hash });
  }
  const allowance = await n.client.readContract({ address: USDG, abi: erc20Abi, functionName: 'allowance', args: [me, ctx.deployment.clearinghouse] });
  if (allowance < need) {
    const { hash } = await sendRequest(a.wallet, n.client, ctx, (await simulateApprove(ctx, a.account, USDG, ctx.deployment.clearinghouse, maxUint256)).request);
    log({ msg: 'usdg approved', tx: hash });
  }
  const { hash } = await sendRequest(a.wallet, n.client, ctx, (await simulateDeposit(ctx, a.account, id, USDG, need)).request);
  log({ msg: 'deposited', id, raw: need, tx: hash });
  return id;
}
