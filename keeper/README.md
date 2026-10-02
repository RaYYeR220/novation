# @novation/keeper

The keeper does the permissionless upkeep that keeps a Novation deployment running week to week. It settles each expiry and the accounts holding it, pays claims, rolls the vaults, runs liquidations, syncs realized vol and lists the weekly strike grid.

Nothing it does needs a privileged role. Every call it makes is open to anyone, and the contracts enforce every rule. A keeper that stops only delays things, and a misbehaving keeper can't make the contracts accept anything they wouldn't accept from anyone else. On the testnet the feeds are mirrored from mainnet and anyone can push to them, so what the keeper settles there is only as good as those prints.

Every transaction goes through the same path:

- It is simulated first, as an `eth_call` of the exact transaction from the keeper's address. A simulation or gas estimate that reverts becomes a logged skip with the decoded refusal code, and nothing is signed.
- It is signed locally with the keeper key, and its hash is known before it is broadcast.
- Its gas limit is the estimate plus 25%, never more than 31.5M; when +25% would cross that, it is the estimate plus 5%, capped at 31.5M.
- If its receipt doesn't arrive in time, it stays open and nothing new is sent until it lands or the node drops it. So a slow inclusion can't lead to the same work being sent twice.
- After 10 minutes, an open transaction is given up on, with an error. If its nonce is still unused, the next send reuses that nonce with doubled fees, so it replaces the stuck transaction rather than queueing behind it.
- The gas is estimated against the latest block, like the simulation, so a stuck transaction doing the same work can't make the new one look like a no-op.

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
| `KEEPER_PRIVATE_KEY` | The key the keeper signs with. Required on any chain but the testnet (46630) and a local chain (31337). |
| `DEPLOYER_PRIVATE_KEY` | On the testnet and a local chain, if `KEEPER_PRIVATE_KEY` is unset, the keeper key is derived from it as `keccak256(deployerKey ‖ "keeper")`. **This is a testnet convenience only. On mainnet, set `KEEPER_PRIVATE_KEY` to an independent key, and never put the deployer key on the keeper's host.** The deployer key itself signs only `fund`. |
| `RH_TESTNET_RPC` / `RH_MAINNET_RPC` | The RPC for `--chain-id 46630` (the default) or `4663`. |

Addresses come from `contracts/deployments/<chainId>.json` through `@novation/sdk`. To run against a deployment the SDK hasn't recorded yet, pass `--deployment <path to its json>`.

### Commands

| Command | What it does |
|---|---|
| `tsx src/cli.ts --once` | Runs one tick and exits. |
| `tsx src/cli.ts --loop <s>` | Runs a tick every `s` seconds, forever. A failed tick is logged and the loop goes on. |
| `tsx src/cli.ts address` | Prints the keeper address and its ETH balance. |
| `tsx src/cli.ts fund [--eth 0.0005]` | Tops the keeper's gas up to that balance from the deployer key, at most 0.0006 ETH per call. |
| `tsx src/cli.ts setup [--usdg 5000]` | Testnet only. Opens the keeper's first subaccount and funds it with mock USDG. This is the account it bids from. |
| `tsx src/cli.ts hint [--expiry <unix>] [--now <unix>] [--underlying NVDA]` | Dry-runs the settlement hint finder. For each underlying, it finds the round `settleExpiry` would get at `--now`. It then asks the deployed registry, as an `eth_call` with the block time overridden to `--now`, whether it accepts that round. Nothing is sent. |
| `tsx src/cli.ts demo [--underlying NVDA] [--expiry <unix>]` | Testnet only. Opens a small book on an expiry from the keeper's own subaccounts, so that its settlement has a payer and a receiver. The long subaccount buys the nearest call the covered-call vault sells. The short subaccount sells the long one an at-the-money straddle through a signed RFQ quote. **This is a self-trade between two subaccounts of one key. It exercises settlement and is not trading volume.** |

`setup`, `demo` and the dust sweep mint mock USDG, and they refuse to run on any chain but the testnet and a local chain.

Don't run `fund`, `setup` or `demo` while the loop is running. They sign with the same keys, and their nonces would collide.

### Options

| Option | Default | Meaning |
|---|---|---|
| `--jobs a,b` | all | Run only these jobs. |
| `--dry-run` | off | Simulate and log what would be sent, without sending it. |
| `--settle-delay <s>` | 900 | How long after a close to wait before settling it. This is also the library default. The testnet feeds are mirrored from mainnet every 300 s, so a pre-close round can land a few minutes after the close. Waiting lets the last one arrive before proof (ii) is used. |
| `--gas-reserve <eth>` | 0.0001 | Below this balance, the optional work waits: vol sync, listing and queue-only rolls. That keeps the remaining gas for settlement. |
| `--list-per-tick <n>` | 16 | The most series the grid job lists in one tick. The rest wait for the next tick. |
| `--min-list-tenor <s>` | 172800 | The grid job skips an expiry that closes sooner than this. Few trades open on a series listed less than two days before its close, and each listing costs gas. |
| `--sync-vol-every <s>` | 3600 | Leaves an underlying alone if anyone poked its vol more recently than this. This keeps gas down. Vaults sync vol themselves before they price. |
| `--roll-every <s>` | 3600 | After the roll job sends a roll to a vault, it waits this long before rolling the same vault again. It only ever sends rolls that would pay the queue. |
| `--bid` / `--no-bid` | on for the testnet and a local chain, off elsewhere | Whether to bid in liquidations and deficit sales at all. |
| `--bid-cap <usdg>` | 5000 | The most the keeper commits to bids over the life of the process. A single bid is capped at 2000 USDG. |
| `--confirmations <n>` | 5 | Event scans stop this many blocks below the head. |
| `--deployment <path>` | the SDK's record | The deployments json to run against. |
| `--debug` | off | Also logs the debug lines (grids, up-to-date feeds, rate limits). |

## Jobs

A tick runs the jobs in this order: settlement first, then the optional upkeep that the gas reserve can hold back.

Before each job, the keeper's state is refreshed:

- It picks up new series.
- It scans for `Traded`, `LiquidationBid`, `AccountSettled` and `DeficitSaleStarted`. The scan stops `--confirmations` blocks below the head and re-reads 200 blocks before its cursor, so a load-balanced RPC whose `getLogs` lags behind can't make it skip a block. Each log is applied once, by (transaction, log index).

Every job can run again safely: it reads the chain and sends only what is still missing.

1. **settleExpiry.**
   - Once a close is `--settle-delay` in the past, the job settles each underlying that has series on it.
   - The hint finder ([`src/hint.ts`](src/hint.ts)) looks for the last round printed at or before the close:
     - if nothing has printed since, that is the latest round;
     - otherwise it bisects the feed's rounds.
   - It walks back across aggregator phases if needed. It stops at an empty phase, after 8 phases or after 1000 round reads. The hub's phase-change proof only looks one phase up, and a mock feed anyone can re-phase mustn't stall a tick.
   - It then checks which of the hub's proofs makes the round acceptable:
     - (i) the next round printed after the close;
     - (ii) the hint is still the latest round, and now is after the close;
     - (iii) the feed changed phase after the close.
   - If the pre-close print is older than `maxSettlementLag` or outside the plausibility band, the job waits for the 72-hour fallback. It then calls `settleExpiryFallback` with the first post-close round, if that round is in the band.
   - If no in-band round has printed since the close (a dead feed, or an implausible first print), the job waits for the last resort, 7 days after the close. It then calls `settleExpiryLastResort` with the last pre-close round, proven last as for (i)–(iii) but without the lag bound, if that round is in the band. The hub refuses the last resort while the fallback applies (`FallbackApplies`).
   - Each decision is logged with the proof, the hint, its timestamp and the next round.
2. **settleAccount.**
   - This job covers every account the keeper has seen trade, or take positions in an auction, that holds positions on a settled expiry.
   - It computes each account's net payoff with the contract's rounding, then settles the payers first and the receivers after.
   - A vault's account is settled by `roll([expiry])`, which also collects the vault's claim and pays its redemption queue. Every other account is settled by `Clearinghouse.settleAccount`.
3. **claim.**
   - `Clearinghouse.claim` is permissionless, so the keeper pays every receiver's claim into its cash.
   - It does so once the expiry's pool is ready: no short of the expiry is unsettled and nothing is pending.
   - A vault's claim goes through its roll.
4. **roll.** This job rolls a vault with shares queued for redemption only when the roll would pay them. That means:
   - no deficit;
   - an open market: vaults close over weekends and holidays, and a roll pays its queue only in a REGULAR or EXTENDED session;
   - live after the roll's own vol sync;
   - enough unlocked assets (`freeAssets`, which is net of the queue, above zero).

   A roll that would do nothing is never sent. After a roll it sent, the job waits `--roll-every` before rolling the same vault again. A vault whose cash already covers a deficit has it applied first with `repayDeficit`.
5. **syncVol.**
   - It runs before liquidations. The auction house folds at most 8 new rounds per underlying itself and refuses a liquidation over a longer backlog (`VolNotCurrent`), so the keeper catches up first. The liquidation job does the same for the underlyings of an account it is about to start or bid on, regardless of `--sync-vol-every` and the gas reserve.
   - For each underlying where the feed has a round the hub hasn't folded in, the job calls `MarketDataHub.syncVol`, which folds up to 64 rounds per call.
   - It does nothing while an underlying is up to date, was poked within `--sync-vol-every`, or the balance is below the gas reserve.
   - When the feed has moved to a new aggregator phase, it calls `syncAndRebaseVol`, which folds what is left of the old phase (up to 64 rounds per call) and re-anchors on the new phase in one transaction, so the old aggregator can't print in between.
6. **liquidation.**
   - Any account below maintenance margin with a live book gets its Dutch auction started. A restart waits 6 hours per account unless a keeper bid went through since the last start. So an account nobody takes over doesn't cost a start every 30 minutes. That includes the case where the keeper can't bid, and the case where its bids keep failing in simulation.
   - Bidding is opt-in. It comes from the keeper's own subaccount (`setup`), and it is capped at 2000 USDG per bid and `--bid-cap` in total.
   - A bid goes in as soon as an auction starts, so at the start discount. It takes `maxFractionPerBid` of the book, or all of it once equity is dust. The fraction is halved while the bidder would end up below initial margin.
   - A bid moves the account's unpaid claims to the bidder, and neither side may end up holding claims on more than 16 expiries (`TooManyClaimExpiries`). Before bidding, the job claims the ready claims of both. If blocked claims alone keep either side over the cap, it logs that and skips the bid.
   - An auction left running on an account that has recovered is ended with `endLiquidation`, so a later fall starts a fresh ramp.
   - The keeper never unwinds or hedges what it takes over. On mainnet, size `--bid-cap` with that in mind.
   - Deficit sales started by settlement get bids for the defaulter's stock collateral, sized to what the deficit still needs.
   - The discount ramps every second, so a bid can land a block later at a slightly lower price and leave a sliver of the deficit unpaid. The job pays a sliver of up to 0.01 USDG into the account and applies it with `repayDeficit`.
   - Cash that already covers a deficit, from a deposit or a claim, only counts once it is applied. The job calls `repayDeficit` before it drops the sale.
   - A repaid sale that is still open, because it was repaid by cash rather than a bid, is ended with `endDeficitSale`, so a later deficit on the same expiry starts a fresh ramp.
   - A repay is skipped when all that is left is a sub-unit of socialized debt, which whole-unit repays can never take. It also waits 6 hours after a repay that left the debt unchanged, and a repeat repay waits while the balance is below the gas reserve.
   - Anyone may make all of these calls.
7. **listSeries.**
   - This job keeps the weekly grid listed for the next two weekly expiries, within the registry's `maxWeeksOut`. It skips an expiry that closes within `--min-list-tenor`.
   - The grid is a call and a put at spot × (1 ± 5/10/15/20%) on the strike step, the same grid as the seed script. That puts the nearest strikes right at the vaults' `minOtm` of 5%.
   - Strikes beyond `maxStrikeDeviation` are skipped, and so is an underlying the hub reports HALTED.
   - Only missing series are sent, at most `--list-per-tick` per tick, and none below the gas reserve.

## Logs

The keeper writes one JSON object per line to stdout: `t`, `level`, `job`, `msg`, then the job's fields.

- Every transaction is one `msg: "tx"` line with `hash`, `status`, `gasUsed`, `block` and the explorer `url`. A transaction that landed after its receipt timed out is marked `late`.
- A transaction still waiting for its receipt is logged as `pending`. One the node dropped is logged as `dropped`.
- `settleExpiry` also logs the `hint` it used and the `proof` that makes it valid.
- `settleAccount` logs each account's `net` and its `role` (payer or receiver).
- Every tick ends with a `tick`/`done` line that gives the transactions and gas the tick used and the keeper's ETH balance.
- The keeper warns (`low balance`) as soon as that balance is below the gas reserve, the same threshold that pauses the optional work.

## Tests

```bash
pnpm test:unit     # the hint finder against fake feeds, the grid, payoffs, keys, gas padding, guards, repay and restart gates
pnpm test:anvil    # the full keeper against a local chain
```

The anvil suite uses the SDK's fixture: anvil, the Solidity `KernelReference` as the risk kernel, and the repo's own forge scripts. The tests drive the mock feeds and anvil's mining themselves. In order, the suite checks:

1. Funding the derived key.
2. Vol sync on new rounds only, with the tx signed by the derived key and its gas padded.
3. A transaction whose receipt doesn't arrive stays open. Nothing more is sent until it lands, and it is then logged as late.
4. A transaction pending too long is given up on and replaced at the same nonce. The replacement does the work, and the stuck one never lands.
5. Below the gas reserve, a warning and no listing; and the per-tick listing cap.
6. Grid listing.
7. Event scans behind the head, with the overlap re-read and each log applied once.
8. A full weekly cycle:
   - setup: the keeper's demo book, an outside taker, and a vault depositor queueing a redemption;
   - pre-close prints, then the clock past the close;
   - the hint is accepted by `settleExpiry` under proofs (i), (ii) and (iii);
   - one tick settles all four underlyings, settles the accounts payers first, claims, and buys the vault's deficit-sale collateral;
   - a second tick, in which the vault's roll pays the queue;
   - a third tick with nothing to do.
9. A vault queue that is fully locked gets no roll. Once assets are free it still gets none over the weekend, and then exactly one roll when the market opens.
10. A liquidation:
   - with a feed nine rounds ahead of the vol, the keeper syncs the vol before it starts the auction;
   - with bidding off, it is only started;
   - with the exposure cap used up, there is no bid;
   - otherwise, the bid goes in at the start discount from the keeper's subaccount.
11. A liquidation left running on an account that recovered is ended.
12. Cash deposited to cover a deficit is applied with `repayDeficit`, then the still-open sale is ended and dropped.

`tsx scripts/fork-rehearsal.ts` rehearses the next settlement against a local anvil fork of the live chain, with the deployed contracts and the real open positions. It re-prints each feed just before the close, moves the fork's clock past it, and runs the settlement jobs on the fork. Nothing reaches the real network.
