import { inject } from 'vitest';
import { keccak256, maxUint256, stringToHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { simulateApprove, simulateCreateSubaccount, simulateDeposit, simulateGrantAgent, simulateMint, type AgentPolicy } from '@novation/sdk';
import type {} from '../../../sdk/test/anvil/setup';
import { local, send, type Local } from '../../../sdk/test/anvil/helpers';
import { createSession, type Session, type SessionOptions } from '../../src/index';

/** anvil's default accounts 1-2 (the public test mnemonic), the owner and maker wallets the SDK helpers hold. */
export const OWNER_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
export const MAKER_KEY: Hex = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
/**
 * The agent is deliberately not one of anvil's unlocked accounts: anvil would accept an
 * eth_sendTransaction from those, a real node never does, so every agent transaction must be signed
 * locally for the tests to pass.
 */
export const AGENT_KEY: Hex = keccak256(stringToHex('novation mcp test agent'));
export const AGENT = privateKeyToAccount(AGENT_KEY).address;

/** Gas money for the agent (anvil_setBalance, 100 ETH). */
export async function fundAgent(l: Local): Promise<void> {
  await l.rpc('anvil_setBalance', [AGENT, '0x56bc75e2d63100000']);
}

export { local, send, type Local };

export function rpcUrl(): string {
  const a = inject('anvil');
  if (!a) throw new Error('no anvil');
  return a.rpcUrl;
}

export function session(l: Local, o: Omit<SessionOptions, 'deployment' | 'rpcUrl'> = {}): Session {
  return createSession({ deployment: l.ctx.deployment, rpcUrl: rpcUrl(), ...o });
}

/** wallets[i] (0 owner, 1 maker, 2 agent) opens a subaccount holding `usdg` USDG of cash. */
export async function openAccount(l: Local, i: number, usdg: bigint): Promise<bigint> {
  const w = l.wallets[i]!;
  const me = w.account.address;
  const USDG = l.ctx.deployment.tokens.USDG!;
  await send(l, w.wallet, (await simulateMint(l.ctx, me, USDG, me, usdg * 10n ** 6n)).request);
  await send(l, w.wallet, (await simulateApprove(l.ctx, me, USDG, l.ctx.deployment.clearinghouse, maxUint256)).request);
  const created = await simulateCreateSubaccount(l.ctx, me);
  await send(l, w.wallet, created.request);
  await send(l, w.wallet, (await simulateDeposit(l.ctx, me, created.result, USDG, usdg * 10n ** 6n)).request);
  return created.result;
}

export async function grant(l: Local, id: bigint, agent: `0x${string}`, p: AgentPolicy): Promise<void> {
  const w = l.wallets[0]!;
  await send(l, w.wallet, (await simulateGrantAgent(l.ctx, w.account.address, id, agent, p)).request);
}

export async function blockTime(l: Local): Promise<number> {
  return Number((await l.client.getBlock()).timestamp);
}
