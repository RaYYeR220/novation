# @novation/keeper

The keeper does the permissionless upkeep that keeps a Novation deployment running week to week. It syncs realized vol, lists the weekly strike grid, settles each expiry and the accounts holding it, pays claims, rolls the vaults and runs liquidations.

Nothing it does needs a privileged role. Every call it makes is open to anyone, and the contracts enforce every rule. A keeper that stops only delays things, and a keeper that misbehaves can't break anything. Before each transaction is signed, it is simulated (`eth_call` of the exact transaction from the keeper's address). A simulation that reverts becomes a logged skip with the decoded refusal code, and nothing is sent.

## Run it

```bash
pnpm install
cd keeper
pnpm once                      # one tick of every job
pnpm loop                      # a tick every 120 s, forever (tsx src/cli.ts --loop 120)
```

It reads the repo's `.env`:

| Variable | Use |
|---|---|
| `DEPLOYER_PRIVATE_KEY` | The keeper key is derived from it as `keccak256(deployerKey ‖ "keeper")`. No new secret is stored, and whoever holds the deployer key can always recompute it. The deployer key itself signs only `fund`. |
| `KEEPER_PRIVATE_KEY` | Optional. Uses this key instead of the derived one. |
| `RH_TESTNET_RPC` / `RH_MAINNET_RPC` | The RPC for `--chain-id 46630` (the default) or `4663`. |

Addresses come from `contracts/deployments/<chainId>.json` through `@novation/sdk`.

### Commands

| Command | What it does |
|---|---|
| `tsx src/cli.ts --once` | Runs one tick and exits. |
| `tsx src/cli.ts --loop <s>` | Runs a tick every `s` seconds, forever. A failed tick is logged and the loop goes on. |
| `tsx src/cli.ts address` | Prints the keeper address and its ETH balance. |
| `tsx src/cli.ts fund [--eth 0.0005]` | Tops the keeper's gas up to that balance from the deployer key, at most 0.0006 ETH per call. |
| `tsx src/cli.ts setup [--usdg 5000]` | Opens the keeper's first subaccount and funds it with mock USDG. This is the account it bids from. |
| `tsx src/cli.ts hint [--expiry <unix>] [--now <unix>] [--underlying NVDA]` | Dry-runs the settlement hint finder. For each underlying, it finds the round `settleExpiry` would get at `--now`. It then asks the deployed registry, as an `eth_call` with the block time overridden to `--now`, whether it accepts that round. Nothing is sent. |
| `tsx src/cli.ts demo [--underlying NVDA] [--expiry <unix>]` | Testnet only. Opens a small book on an expiry from the keeper's own subaccounts, so that its settlement has a payer and a receiver. The long subaccount buys the nearest call the covered-call vault sells. The short subaccount sells the long one an at-the-money straddle through a signed RFQ quote. |

### Options

| Option | Default | Meaning |
|---|---|---|
| `--jobs a,b` | all | Run only these jobs. |
| `--dry-run` | off | Simulate and log what would be sent, without sending it. |
| `--min-list-tenor <s>` | 172800 | The grid job skips an expiry that closes sooner than this. Few trades open on a series listed less than two days before its close, and each listing costs gas. |
| `--sync-vol-every <s>` | 3600 | Leaves an underlying alone if anyone poked its vol more recently than this. This keeps gas down. Vaults sync vol themselves before they price. |
| `--settle-delay <s>` | 900 | How long after a close to wait before settling it. The testnet feeds are mirrored from mainnet every 300 s, so a pre-close round can land a few minutes after the close. Waiting lets the last one arrive before proof (ii) is used. |
| `--roll-every <s>` | 3600 | Minimum time between two queue-only rolls of one vault. |
| `--debug` | off | Also logs the debug lines (grids, up-to-date feeds, rate limits). |

## Jobs

A tick runs the jobs in this order. Before each job, the keeper's state is brought up to the chain head: it picks up new series and scans the new blocks for `Traded`, `LiquidationBid`, `AccountSettled` and `DeficitSaleStarted`. A settlement sent by one job is therefore seen by the next. Every job can run again safely: it reads the chain and sends only what is still missing.

1. **syncVol.** For each underlying where the feed has a round the hub hasn't folded in, the job calls `MarketDataHub.syncVol`, which folds up to 64 rounds per call. It does nothing while an underlying is up to date, or was poked within `--sync-vol-every`. When the feed has moved to a new aggregator phase, it first folds what is left of the old phase with `pokeVol`, then calls `rebaseVol`.
2. **listSeries.** This job keeps the weekly grid listed for the next two weekly expiries, within the registry's `maxWeeksOut`. It skips an expiry that closes within `--min-list-tenor`. The grid is a call and a put at spot × (1 ± 5/10/15/20%) on the strike step, the same grid as the seed script. That puts the nearest strikes right at the vaults' `minOtm` of 5%. Strikes beyond `maxStrikeDeviation` are skipped, and so is an underlying the hub reports HALTED. Only missing series are sent.
3. **settleExpiry.** Once a close is `--settle-delay` in the past, the job settles each underlying that has series on it. The hint finder ([`src/hint.ts`](src/hint.ts)) looks for the last round printed at or before the close. If nothing has printed since, that is the latest round. Otherwise it bisects the feed's rounds, across aggregator phases if needed. It then checks which of the hub's proofs makes the round acceptable:
   - (i) the next round printed after the close;
   - (ii) the hint is still the latest round, and now is after the close;
   - (iii) the feed changed phase after the close.

   If the pre-close print is older than `maxSettlementLag` or outside the plausibility band, the job waits for the 72-hour fallback and then calls `settleExpiryFallback` with the first post-close round. Each decision is logged with the proof, the hint, its timestamp and the next round.
4. **settleAccount.** This job covers every account the keeper has seen trade, or take positions in an auction, that holds positions on a settled expiry. It computes each account's net payoff with the contract's rounding, then settles the payers first and the receivers after. A vault's account is settled by `roll([expiry])`, which also collects the vault's claim and pays its redemption queue. Every other account is settled by `Clearinghouse.settleAccount`.
5. **claim.** `Clearinghouse.claim` is permissionless, so the keeper pays every receiver's claim into its cash. It does so once the expiry's pool is ready, which means no short of the expiry is unsettled and nothing is pending. A vault's claim goes through its roll.
6. **roll.** This job rolls any vault with shares queued for redemption and no deficit, at most once per `--roll-every`. The settle and claim jobs already roll a vault whenever one of its expiries settles. This job retries a queue that couldn't be paid then, for example because assets were still locked behind later expiries.
7. **liquidation.** Any account below maintenance margin with a live book gets its Dutch auction started. Then, from the keeper's own subaccount, the job bids on each running auction as soon as it starts, at the start discount. A bid takes `maxFractionPerBid` of the book, or all of it once equity is dust, and the fraction is halved while the bidder would end up below initial margin. Deficit sales started by settlement get bids for the defaulter's stock collateral, sized to what the deficit still needs. The discount ramps every second, so a bid can land a block later at a slightly lower price and leave a sliver of the deficit unpaid. The job pays a sliver of up to 0.01 USDG into the account and applies it with `repayDeficit`, so dust doesn't keep the account blocked. Anyone may make both calls. The bids need a funded keeper subaccount (`setup`). Without one, they are logged as skipped.

## Logs

The keeper writes one JSON object per line to stdout: `t`, `level`, `job`, `msg`, then the job's fields. Every transaction is one `msg: "tx"` line with `hash`, `status`, `gasUsed`, `block` and the explorer `url`. `settleExpiry` also logs the `hint` it used and the `proof` that makes it valid, and `settleAccount` logs each account's `net` and its `role` (payer or receiver). Every tick ends with a `tick`/`done` line that gives the transactions and gas the tick used and the keeper's ETH balance. The keeper warns when that balance falls below 0.00005 ETH.

## Tests

```bash
pnpm test:unit     # the hint finder against fake feeds, the grid, payoffs, key derivation
pnpm test:anvil    # the full keeper against a local chain
```

The anvil suite uses the SDK's fixture: anvil, the Solidity `KernelReference` as the risk kernel, and the repo's own forge scripts. The tests drive the mock feeds themselves. In order, the suite checks:

- funding the derived key;
- vol sync on new rounds only;
- grid listing;
- a full weekly cycle:
  - the keeper's demo book, an outside taker and a vault depositor queueing a redemption;
  - pre-close prints, then the clock past the close;
  - the hint accepted by `settleExpiry` under proofs (i), (ii) and (iii);
  - one tick that settles all four underlyings, settles the accounts payers first, claims, and buys the vault's deficit-sale collateral;
  - a second tick in which the vault's roll pays the queue;
  - a third tick with nothing to do;
- a liquidation started below maintenance margin and bid at the start discount from the keeper's subaccount.

`tsx scripts/fork-rehearsal.ts` rehearses the next settlement against a local anvil fork of the live chain, with the deployed contracts and the real open positions. It re-prints each feed just before the close, moves the fork's clock past it and runs the settlement jobs for real on the fork. Nothing reaches the real network.
