# @novation/sdk

TypeScript access to the Novation contracts on Robinhood Chain, on [viem](https://viem.sh) only: typed reads, write helpers that simulate before anything is signed, EIP-712 RFQ quotes, refusal decoding, chunked event scans and the NYSE calendar the contracts use.

The package ships TypeScript source (`src/index.ts`). In the workspace, Node services run it with `tsx` or vitest; Next.js lists it in `transpilePackages`.

## Start

```ts
import { createNovation, fromWad } from '@novation/sdk';

const n = createNovation({ chainId: 46630 }); // RH Chain testnet, addresses from contracts/deployments/46630.json
const st = await n.clearinghouse.getAccountState(4n);
console.log(fromWad(st.equity), fromWad(st.im));
```

`createNovation({ client, deployment })` takes your own viem public client and deployment instead. Every helper also exists as a plain function taking the context first, e.g. `getAccountState(n.ctx, 4n)`. Amounts are bigint WAD (1e18), as on chain; `fromWad` / `toWad` convert for display.

## What is in it

| Module | |
| --- | --- |
| `abi/*` | ABIs read from the forge build by `scripts/gen.ts`, plus `novationErrorsAbi`: every custom error a contract or linked library can revert with |
| `addresses` | `getDeployment(chainId)`, `parseDeployment(json)`, `proofRefusals(chainId)` |
| `hub` | spot, session, mark vol, vol state, risk parameters, and `getMarket` with the reason an underlying is halted |
| `registry` | series, expiries, settlement prices |
| `clearinghouse` | account state, positions, collateral, `getMarginAfter` and `whatIfTrade` (the pre-sign what-if), scenario grid, subaccounts, agent policies, pools, claims, deficits, insurance, auctions, `tradeFee` |
| `vault` | NAV, totals, free and locked assets, epochs, holdings, `getVaultQuote`, and `getVaultQuotesSynced`: quotes as the vault's next operation prices them, through a deployless lens that syncs the mark vol first |
| `rfq`, `quote712` | quote hashing, signing and verification matching `RfqVenue`, fills and nonces |
| `kernel` | the risk kernel's `margin`, `scenarioGrid` and `bsQuote`; `buildKernelInput` rebuilds the clearinghouse's kernel input exactly, `scenarioGridFor` prices it under another session (the weekend gap on a weekday) or after a trade |
| `writes` | `simulate*` helpers returning viem `simulateContract` results; `sendRequest`, `withGasHeadroom`, `padGas` |
| `refusal` | `decodeRefusal(err)`, `RefusalError`, `explainTx(ctx, hash)` |
| `events` | `getEvents` and typed scans (trades, agents, settlements, claims, vault activity, insurance, auctions) in block chunks from the deployment block |
| `calendar` | the NYSE sessions and weekly expiries, bit for bit with `NyseCalendar.sol` |

## Writing

Each `simulate*` helper runs the exact transaction as an `eth_call` from the given account and returns `{ request, result }`. If it would revert with a known error it throws `RefusalError`, whose `refusal` holds the error's name, a sentence and its arguments by name (`numbers` has WAD amounts as floats).

```ts
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http } from 'viem';
import { robinhoodChainTestnet, sendRequest, simulateVaultBuy, RefusalError } from '@novation/sdk';

const account = privateKeyToAccount(process.env.AGENT_KEY as `0x${string}`);
const wallet = createWalletClient({ account, chain: robinhoodChainTestnet, transport: http() });
try {
  const { request } = await simulateVaultBuy(n.ctx, account, vault, seriesId, 10n ** 18n, maxPremium, accountId);
  const { hash } = await sendRequest(wallet, n.client, n.ctx, request);
} catch (e) {
  if (e instanceof RefusalError) console.log(e.refusal.code, e.refusal.numbers);
}
```

**Sign locally.** `sendRequest` needs a wallet client bound to a `LocalAccount` (`privateKeyToAccount`): it signs in-process and sends the raw transaction. Public RPCs, the Robinhood Chain testnet one included, refuse `eth_sendTransaction`, so a request whose account is a bare address only works through a browser wallet. In a browser, hand the request to the wallet client wagmi gives you, after `withGasHeadroom`.

**Gas headroom.** `sendRequest` estimates gas and adds 25% (`padGas`, `withGasHeadroom`). The Black-Scholes inside the margin check costs a little more or less gas at a different block timestamp, so a transaction sent with its exact estimate can run out. Use `withGasHeadroom` for any write you send yourself.

**Why a transaction reverted.** `explainTx(ctx, hash)` replays it with `eth_call` at the block before (Robinhood Chain has no debug tracing). The public node prunes old state, so it falls back to the revert data Blockscout recorded.

## ABIs and addresses

```bash
cd contracts && forge build && cd ../sdk
node scripts/gen.ts           # refresh src/abi/*.ts and src/data/deployments.ts
node scripts/gen.ts --check   # fails if they are out of date (a unit test runs this)
```

Addresses only ever come from `contracts/deployments/<chainId>.json`.

## Tests

```bash
pnpm --filter @novation/sdk test:unit      # refusals for every error, EIP-712 against Solidity's encoding, kernel inputs, units, events
pnpm --filter @novation/sdk test:anvil     # needs anvil and forge; ANVIL=off skips it
pnpm --filter @novation/sdk test:testnet   # read-only, live RH testnet; RH_TESTNET_RPC=off skips it
```

The anvil suite deploys the stack with the repo's own forge scripts (`DeployMocks`, `Deploy`, `Seed`) and the Solidity `KernelReference` as the kernel, then opens an account, buys from a vault after the what-if, fills an RFQ quote signed with `signQuote` (the venue accepts it and rejects a tampered one), decodes refusals before signing and from a mined revert, and checks that `scenarioGridFor` reproduces the clearinghouse's grid and initial margin exactly.
