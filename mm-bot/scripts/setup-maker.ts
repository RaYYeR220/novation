/**
 * Sets up the maker account on the chain in the environment (Robinhood Chain testnet by default):
 *
 *   pnpm --filter @novation/mm-bot setup:maker
 *
 * The maker key is keccak256(DEPLOYER_PRIVATE_KEY || "maker"). The deployer tops it up with a
 * little ETH for gas (at most 0.0004), then the maker mints mock USDG, opens a subaccount and
 * deposits MM_SETUP_CASH (default 100,000 USDG). Safe to run again: each step is skipped when it
 * is already done. Prints the maker address and subaccount id, never a key.
 */
import { formatEther } from 'viem';
import { fromWad, getAccountState, toWad } from '@novation/sdk';
import { chainFromEnv, deployerAnd, fundedAccount, log, topUpEth } from './lib';

async function main() {
  const n = chainFromEnv();
  const { deployer, derived: maker } = deployerAnd(n, 'maker');
  log({ msg: 'maker setup', chainId: n.deployment.chainId, maker: maker.account.address, deployer: deployer.account.address });

  await topUpEth(n, deployer, maker.account.address, { min: '0.0001', target: '0.0002', cap: '0.0004' });
  const id = await fundedAccount(n, maker, toWad(process.env.MM_SETUP_CASH || '100000'));
  const st = await getAccountState(n.ctx, id);
  const eth = await n.client.getBalance({ address: maker.account.address });
  log({ msg: 'maker ready', maker: maker.account.address, makerId: id, cash: fromWad(st.cash), equity: fromWad(st.equity), im: fromWad(st.im), eth: formatEther(eth) });
  console.log(`\nmaker ${maker.account.address}\nsubaccount ${id}\nset MM_MAKER_ID=${id} for the relay`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
