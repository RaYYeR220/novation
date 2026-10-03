# Novation

Portfolio-margined options on Robinhood Chain stock tokens. Every margin check re-prices the whole book across 39 scenarios in a Stylus risk kernel, for about 15x less gas than hand-optimized Solidity.

Robinhood Chain testnet (chain id 46630): the Stylus kernel, its Solidity twin and the final core contracts are live, and a keeper settled the first weekly expiry on its own. Robinhood Chain mainnet: the kernel program is deployed, but its activation was refused during the network-wide pause of new Stylus activations, so no core contract is on mainnet ([Mainnet](#mainnet)). Internally reviewed, not externally audited. Judges can start with [JUDGES.md](JUDGES.md).

Demo video: [youtu.be/24Diq8aGN3s](https://youtu.be/24Diq8aGN3s). Live app: [novation-clearing.vercel.app](https://novation-clearing.vercel.app). It shows a demo snapshot computed with the kernel reference. The app in this repository also has a **Live testnet** mode that reads the deployed contracts and sends transactions through a browser wallet.

## What Novation is

Novation is a clearinghouse for weekly European options on the tokenized US stocks that trade on Robinhood Chain, starting with NVDA, TSLA, SPY and AAPL. Options are cash-settled in USDG at the Friday NYSE close. Trades reach the clearinghouse only through venues: an RFQ venue for EIP-712 signed maker quotes, and two option-selling vaults (covered calls and cash-secured puts). An owner can let an AI trading agent trade for an account under an on-chain risk budget, which caps the worst-case loss the account may carry rather than the amount the agent may spend.

Each account is margined as one portfolio. Its options and its stock-token collateral are re-priced with Black-Scholes across a grid of price and volatility scenarios, and the worst loss sets the margin. A covered call is covered by the stock already in the account, a spread is margined on its real worst case, and a hedge reduces the requirement. The grid runs in a stateless risk kernel written in Rust and deployed with Arbitrum Stylus; a bit-identical Solidity twin exists to check that it computes the same integers.

## Why it matters

Robinhood Chain carries tokenized US stocks with Chainlink price feeds, and contracts can hold them like any ERC-20: a transfer checks only a pause flag and a blocklist. They trade against USDG in DEX pools, but we found no options market on the chain to hedge a position or to earn premium on one.

The tokens also trade around a hole in the price data. The equity feeds publish five days a week. Across 13 weeks of mainnet history there was not one round on a Saturday or on a Sunday before 20:00 ET, and only a handful after 16:00 on a Friday: a typical weekend leaves 52 to 60 hours without a price, and a holiday weekend 76 to 81 hours. There is no round at the Friday 16:00 ET close either. On 2026-09-18 the last SPY print before the close came at 08:22 ET, and the next one at 20:00 ET on Sunday. A margin engine that treats Friday 16:00 like any other minute under-reserves for the Monday gap, and a settlement that assumes a closing print waits for one that never comes.

Novation encodes the NYSE calendar on-chain. Margin shocks widen by session (1.75x over weekends and holidays by default), opening halts when a feed goes stale or the issuer freezes the token, settlement proves the last print at or before the close from the feed itself, and liquidation auctions are designed to wait for a live price instead of selling into the gap.

## How margin works

The full model, with every parameter and its bounds, is in [docs/risk-model.md](docs/risk-model.md). In short:

1. **Scenarios.** Each underlying gets 13 price moves, evenly spaced from minus to plus its shock range, times 3 volatility levels (30% lower, unchanged, 40% higher): 39 scenarios. In the correlated regime every underlying moves by the same fraction of its own range.
2. **Shock range.** `max(10%, 3 × σ × √(2/365)) × session multiplier`, capped at 90%. σ is the mark volatility: a realized-volatility estimate built on-chain from Chainlink rounds, clamped between a per-underlying floor and cap.
3. **Sessions.** The multiplier is 1.0 in the regular session, 1.2 in extended hours, 1.75 over weekends and holidays and 2.5 when the underlying is halted.
4. **Requirement.** Initial margin (IM) is the larger of the correlated worst loss and 70% of the sum of each underlying's own worst loss, plus 1% of spot per short option. Maintenance margin (MM) is 75% of IM. Equity is cash plus the mark-to-market of options and collateral.
5. **The kernel.** Every trade, margin-checked withdrawal and what-if view sends the account's whole book to the kernel's `margin()` function and gets back its mark-to-market, its worst-case loss and the worst scenario.

Each side of a trade that opens risk must end with equity at or above IM. Reducing risk stays possible below IM: a side that grows no position, doesn't raise the worst-case loss and doesn't give up equity against the mark passes the margin check.

## The margin check that doesn't fit in an EVM transaction

Each margin check prices every option in the account 39 times. In the EVM that costs about 92,500 gas per position, even in hand-optimized Solidity. The Stylus kernel costs about 5,000.

Execution gas of one `margin()` call on Robinhood Chain testnet:

| Positions | Stylus kernel | Hand-optimized Solidity | Ratio |
|---|---|---|---|
| 32 | 199,415 | 2,922,648 | 14.7x |
| 64 | 351,072 | 5,828,423 | 16.6x |
| 128 | 685,075 | 11,646,851 | 17.0x |
| 256 | 1,323,108 | 23,269,339 | 17.6x |

Arbitrum caps a transaction at 32M gas. A trade evaluates margin once for a side that opens risk, and twice (before and after the trade) for a side that reduces risk or is acted on by an agent. Closing one position in an account at the 256-position cap therefore takes two full evaluations of that account: about 46.5M gas with hand-optimized Solidity, which no transaction can hold, and 2.6M with the Stylus kernel. A single Solidity evaluation stops fitting at about 345 positions.

The ratio above uses the conservative baseline: a separate Solidity implementation of the same 39-scenario revaluation, written for gas (unchecked arithmetic, inlined constants). For context, `KernelReference.sol`, the checked Solidity twin used for parity, costs 21.3M gas at 32 positions, about 100x the Stylus kernel; it isn't the headline because it was never tuned for gas. Methods, books, dates and the raw transaction-level numbers are in [docs/gas.md](docs/gas.md).

The rest of a liquidation stays inside the limit too. The worst bid the caps allow (256 positions over 4 underlyings with collateral in all 4, unpaid claims on 16 expiries, 8 unfolded rounds per feed, an empty bidder) costs 23,403,163 gas in a local measurement on mocks, about 23.6M with the mainnet tokens and feeds, against the 32M cap ([docs/gas.md](docs/gas.md#worst-case-liquidation-bid)).

Both kernels are live on testnet, and anyone can compare them on identical calldata:

```bash
python tools/stylus-deploy/parity.py --rpc https://rpc.testnet.chain.robinhood.com
```

The script checks that the two return byte-identical results and prints `eth_estimateGas` for both. On 2026-10-01 a 32-position book estimated at 269,605 gas on the Stylus kernel and 22,099,291 on the Solidity twin; the 256-position book estimated at 1,671,146 on Stylus and exceeds the RPC's 50M call allowance on Solidity.

## Architecture

![Novation architecture: venues, Clearinghouse, Stylus risk kernel and MarketDataHub](docs/architecture.svg)

- **Venues** are the only callers of `Clearinghouse.trade`. The list is fixed when setup ends. Each venue passes the actor for each side; the clearinghouse checks that the actor is the account owner or a live agent of that account.
- **Clearinghouse** keeps subaccounts, USDG cash (scaled by a global cash index that only a socialized loss can lower), stock-token collateral and positions. Its logic lives in three linked libraries: `MarginLogic` builds the kernel input, `TradeLogic` applies the opening rules, fees, margin and agent budgets, `SettlementLogic` runs the expiry pool and the default waterfall.
- **Risk kernel** is a stateless Rust program compiled to WASM: `margin`, `scenarioGrid` (the 39-value heat map), `bsQuote` and `ewmaUpdate`. `KernelReference.sol` implements the same interface and returns the same integers.
- **MarketDataHub** turns a Chainlink feed and a stock token into a session (regular, extended, weekend, holiday or halted), a spot price, a mark volatility and a proven settlement price. Every halt condition fails closed.
- **SeriesRegistry** lists series permissionlessly (weekly NYSE-close expiries, strike grid, distance from spot) and stores one settlement price per underlying and expiry.
- **RiskParams** holds every risk and fee parameter inside hard-coded bounds. Only a timelock can change them; a guardian can only pause opening.
- **InsuranceFund** receives a share of fees and bridges settlement shortfalls. **AuctionHouse** runs Dutch-auction liquidations and the sale of a defaulter's collateral.

| Component | Status |
|---|---|
| Risk kernel (Stylus) and `KernelReference.sol` | Shipped, deployed and activated on RH testnet; the Stylus program is also deployed on RH mainnet, not activated |
| Clearinghouse with margin, trading, agent budgets and the settlement waterfall | Shipped, deployed on RH testnet |
| MarketDataHub, SeriesRegistry, RiskParams, InsuranceFund | Shipped, deployed on RH testnet |
| RfqVenue, CoveredCallVault, PutWriteVault | Shipped, deployed on RH testnet |
| AuctionHouse (liquidations, deficit sales) | Shipped, deployed on RH testnet |
| Keeper (`keeper/`) | Shipped, settled the first testnet expiry on its own |
| RFQ market maker and relay (`mm-bot/`) | Shipped, its quotes filled on RH testnet; the web app serves the relay at `/api/rfq` |
| MCP server for agents (`mcp/`) | Shipped, run live on RH testnet |
| TypeScript SDK (`sdk/`) | Shipped, tested on a local chain and against RH testnet |
| Web app (`app/`) | Demo snapshot and live testnet mode |
| Indexer | Not built: history views (NAV series, epochs, halt episodes) show empty states in live mode |
| Robinhood Chain mainnet | Kernel deployed, activation refused during the pause of new Stylus activations; core not deployed ([Mainnet](#mainnet)) |

## Contracts and addresses

Robinhood Chain testnet, chain id 46630. The machine-readable copy is [`contracts/deployments/46630.json`](contracts/deployments/46630.json), and [docs/deployments.md](docs/deployments.md) lists every library, mock token and feed. The core contracts are immutable, so each fix after review shipped as a fresh deployment of the core: the stack below runs the final reviewed code, and the earlier stacks stay on-chain with their proofs ([why there are several stacks](docs/deployments.md#why-there-are-several-stacks)).

| Contract | Address | State |
|---|---|---|
| Risk kernel (Stylus) | [`0xAeE1D4F45AF43a9C4d52ADa65d423b1c0e67f0fd`](https://explorer.testnet.chain.robinhood.com/address/0xAeE1D4F45AF43a9C4d52ADa65d423b1c0e67f0fd) | deployed, activated |
| KernelReference (Solidity twin) | [`0xB7d9232c8ff46b4950d85ed639908c86C08750C6`](https://explorer.testnet.chain.robinhood.com/address/0xB7d9232c8ff46b4950d85ed639908c86C08750C6) | deployed |
| Mock USDG, NVDA, TSLA, AAPL, SPY and their feeds | see [docs/deployments.md](docs/deployments.md) | deployed, testnet only ([MOCKS.md](MOCKS.md)) |
| RiskParams | [`0x569768651DbB577Dcda4547e9B177f702b6F1D00`](https://explorer.testnet.chain.robinhood.com/address/0x569768651DbB577Dcda4547e9B177f702b6F1D00) | deployed, setup finalized |
| MarketDataHub | [`0x42894B89a9fC7aFe3bD12555CAc20b6695a5ed9C`](https://explorer.testnet.chain.robinhood.com/address/0x42894B89a9fC7aFe3bD12555CAc20b6695a5ed9C) | deployed |
| SeriesRegistry | [`0x079f744c046F7C1fCc43b1Fe5124513637d19dA8`](https://explorer.testnet.chain.robinhood.com/address/0x079f744c046F7C1fCc43b1Fe5124513637d19dA8) | deployed, 128 series listed |
| InsuranceFund | [`0x295FB7eB9dcE936190567032C72697FaCEAdb96C`](https://explorer.testnet.chain.robinhood.com/address/0x295FB7eB9dcE936190567032C72697FaCEAdb96C) | deployed, funded with 100,000 mock USDG |
| Clearinghouse (with MarginLogic, TradeLogic, SettlementLogic, AuctionHookLogic) | [`0x397dc6b74003172C27297520E98472C5fd168238`](https://explorer.testnet.chain.robinhood.com/address/0x397dc6b74003172C27297520E98472C5fd168238) | deployed, setup finalized |
| AuctionHouse | [`0x2775a3feECA95a29141A9d3903b1C8fABa2B4658`](https://explorer.testnet.chain.robinhood.com/address/0x2775a3feECA95a29141A9d3903b1C8fABa2B4658) | deployed |
| RfqVenue | [`0xcD5d78984A2ebe76D7B09C8304E79a078B93D328`](https://explorer.testnet.chain.robinhood.com/address/0xcD5d78984A2ebe76D7B09C8304E79a078B93D328) | deployed |
| CoveredCallVault NVDA | [`0xAC989aF37744FeB96Cad8d553e7321a8b5b1D5d9`](https://explorer.testnet.chain.robinhood.com/address/0xAC989aF37744FeB96Cad8d553e7321a8b5b1D5d9) | deployed, seeded |
| CoveredCallVault TSLA | [`0x55E624783C129721Bd8735D1E4Ef1E5c06BE708A`](https://explorer.testnet.chain.robinhood.com/address/0x55E624783C129721Bd8735D1E4Ef1E5c06BE708A) | deployed, seeded |
| PutWriteVault NVDA | [`0xa47A07846902bDB8cE5306C1F851278447f3e237`](https://explorer.testnet.chain.robinhood.com/address/0xa47A07846902bDB8cE5306C1F851278447f3e237) | deployed, seeded |
| TimelockController (60 s on testnet) | [`0xe3a0D2Dd94607f86d9641571B5fe328a274C4030`](https://explorer.testnet.chain.robinhood.com/address/0xe3a0D2Dd94607f86d9641571B5fe328a274C4030) | deployed |

**Proofs on the current stack** (2026-10-02, every hash in [`tools/e2e/out/46630.json`](tools/e2e/out/46630.json)): a [vault buy](https://explorer.testnet.chain.robinhood.com/tx/0xe3b1dc0f7ab30332db2e96f82cd7b478ff3082485d0f993f9600c041f182a9ff), a [vault deposit](https://explorer.testnet.chain.robinhood.com/tx/0xbd883651fa209ddb90f21b1149737c5465d8e467f36e32f3702efec1767a0565), an [RFQ fill](https://explorer.testnet.chain.robinhood.com/tx/0x37e5459edea8d90290033d8747d5671e669f7614353af01ce62e24f9876a0192), an agent's [in-budget buy](https://explorer.testnet.chain.robinhood.com/tx/0xf4e14eeff6188e6259b78b3c426632912b858d6c6bd2d58c8cdedd3e0733353d) and its [over-budget buy reverted](https://explorer.testnet.chain.robinhood.com/tx/0x7b91ebf435f1c2e3f57d65dc06d0e01e88ed48d2b9fcfe1a862ed5c677826afb) with `AgentRiskBudgetExceeded`, a [withdrawal below initial margin reverted](https://explorer.testnet.chain.robinhood.com/tx/0x96b225d4cef0e2c30fb00da1b406e30799b16be5342edb2f6bb363459175edb5) with `InsufficientMargin`, and an [opening refused during a corporate action](https://explorer.testnet.chain.robinhood.com/tx/0xae5f3ea5f320c91d36334a53d56e90cb2e203f8933b454bba396bbc8f6fc32cf) with `OpeningNotAllowed`.

**Proofs on the earlier stacks**, still on-chain:

- **The first expiry settlement.** The Oct 2 expiry was settled by the keeper with no manual step, 16 minutes after the 16:00 ET close. On stack 2 (Clearinghouse [`0x0b0F…1949`](https://explorer.testnet.chain.robinhood.com/address/0x0b0F4e67DcA3B846859Af452576e8E09316D1949)): [`settleExpiry` for NVDA](https://explorer.testnet.chain.robinhood.com/tx/0xdc08998d8ddea08197e4b0efa2057b4ef23e59a80a95cfb88bc28fc976c79afa), the [paying account settled first](https://explorer.testnet.chain.robinhood.com/tx/0xf303523f00cbb362c3d3edf5f2351612fe13e5e4ab9ce16c5576e8fc337aef35), the [covered-call vault's roll](https://explorer.testnet.chain.robinhood.com/tx/0x37509f3958172e139017b726222a2ba79fa094d75c0881847b798af4c68b4411) and a [claim paid](https://explorer.testnet.chain.robinhood.com/tx/0x1561dcd3964a1f2be8508335cde79d98af2b46aeed6521043393c832f315f3b0). On stack 1 (Clearinghouse [`0xe799…ABB2`](https://explorer.testnet.chain.robinhood.com/address/0xe799DF9b96a4809c411D3F90f67C5261a245ABB2)): [`settleExpiry` for NVDA](https://explorer.testnet.chain.robinhood.com/tx/0xd78516aa7b120632b6af0f946d6126fcd9261d8c0d80c8cbff4821f6e86a4226) and a [claim paid](https://explorer.testnet.chain.robinhood.com/tx/0xeb761f6db520348bd03cfe4074d0251c92cd106768784c6d22cff2561952a1d6).
- **Weekend margin.** On stack 2, one account sold 5 NVDA calls in the Friday regular session ([`0x39e7db43…`](https://explorer.testnet.chain.robinhood.com/tx/0x39e7db43cd5bdc5bd11c5ca349fff37bc4d692247438c695963a672e472e051f)) at an initial margin of 81% of its equity. On Saturday 2026-10-03 its twin sent the identical fill, same quote, same size, same spot, in the WEEKEND session, and the clearinghouse refused it on-chain ([`0x6562a49e…`](https://explorer.testnet.chain.robinhood.com/tx/0x6562a49e1176f72920201285be4672101ba417a2d0fc0a482c0b7294434637f3)): `InsufficientMargin`, initial margin 582.92 USDG against equity 407.00 (143%). The same book needs 78% of equity under regular-session shocks.
- **Agents and the market maker.** The MCP server's in-budget fill and its mined refusal, and a fill of a quote served by the market maker, on stack 2 ([Agents](#agents), [mm-bot/README.md](mm-bot/README.md)).

## Mainnet

Nothing but the kernel program is on Robinhood Chain mainnet (chain id 4663), and the program isn't active.

- **Kernel deployed.** The same WASM as the testnet kernel was deployed at [`0x6d07e246eb757A1F97E3cdB7d1881ee5De27ceaA`](https://robinhoodchain.blockscout.com/address/0x6d07e246eb757A1F97E3cdB7d1881ee5De27ceaA) in [`0x154dd531…`](https://robinhoodchain.blockscout.com/tx/0x154dd53142d61126f6f9ca7a2c0cbc0322470853bf259d5628c26ba934706d61) on 2026-10-02 (5,261,543 gas, the same code hash).
- **Activation refused.** The activation transaction was rejected at submission ("Transaction rejected by chain policy") at about 20:00 UTC that day, during the Arbitrum Security Council's emergency pause of new Stylus activations, announced the same day. The core needs an active kernel, so nothing else was deployed: no clearinghouse, vault or user funds are on mainnet.
- **Tested against mainnet anyway.** The fork suite forks the latest mainnet block and deploys the core against the real stock tokens and Chainlink feeds; it passes 5/5, including a covered-call vault cycle through settlement.
- **Ready when activations resume.** `bash tools/deploy/deploy-mainnet.sh --broadcast` activates the program, deploys and seeds the core with the mainnet configuration (24-hour timelock, separate guardian and treasury keys), and `tools/e2e/mainnet_proofs.py` runs the proof transactions step by step. Without `--broadcast` it only simulates.

Details, addresses of the real tokens and feeds, and the runbook: [docs/deployments.md](docs/deployments.md#robinhood-chain-mainnet-chain-id-4663).

## Agents

An owner can give an AI agent its own key with an on-chain risk budget. `grantAgent` sets a cap on the account's worst-case loss (its initial margin after any trade the agent opens), a premium cap and a value-drain cap per trade, the underlyings the agent may trade and an expiry. `TradeLogic` enforces the policy inside every trade, whatever software the agent runs. The agent can always reduce risk, and it can never withdraw.

[`mcp/`](mcp/README.md) is an MCP server that lets any AI agent trade through that key. It reads markets, option chains, vault quotes, what-if margin, the portfolio with its scenario grid, and the budget. It buys and sells through the vaults and fills RFQ quotes. Every trade is simulated first, so an over-budget ticket comes back as a structured refusal, for example `AgentRiskBudgetExceeded` with the worst-case loss and the budget, and nothing is sent. The server holds only the agent key and refuses to start unless the chain has a live policy for it.

On testnet (stack 2), an agent driving the server got a budget of 0.77 USDG (1.5x the initial margin of one NVDA call). It bought one call inside the budget ([`0xf1791085…`](https://explorer.testnet.chain.robinhood.com/tx/0xf17910855569d9d6fed1b5ef3676ac48599e955b3dc889ee7bdc5d7d1f109542)). A ticket for three more was refused in simulation and not sent. Sent anyway to leave proof, that ticket reverted on-chain with `AgentRiskBudgetExceeded` (worst-case loss 2.04 USDG, budget 0.77 USDG): [`0x43941aae…`](https://explorer.testnet.chain.robinhood.com/tx/0x43941aae0c18d7d004d052fd4baa72ccbb74fddd9ffe0d9e6d4dcb57407b42fe). The transcript and every hash are in [`mcp/out/46630.json`](mcp/out/46630.json).

## Security model

The full trust model, invariants, threat table and review history are in [SECURITY.md](SECURITY.md). The short version:

- The core is immutable. There are no proxies, no `selfdestruct` and no `delegatecall` outside linked libraries.
- Risk parameters change only through a timelock, and every setter enforces hard-coded bounds. The guardian can pause opening and nothing else: withdrawals, risk-reducing trades and settlement stay open.
- The venue list and the auction house are fixed when setup is finalized.
- Prices come from Chainlink only. Any doubt about a feed or a token (stale, unreadable, out of the plausibility band, paused, mid corporate action) reads as HALTED, which blocks opening and widens margin.
- Settlement prices are proven from the feed's own round history, with no admin override.
- Rounding goes against the actor: requirements and debts round up, credits and payouts round down.
- The Stylus kernel, the Solidity twin and a Python reference agree bit for bit on every test vector. A differential fuzz of 5,100 random calls, run against `KernelReference` on a local node, found no difference in return data or revert data.

## Honest limits

- Mark volatility is realized volatility from Chainlink rounds, not implied volatility. Vault premiums add model parameters (skew, spread) on top of it.
- Options are weekly, European and cash-settled. Settlement uses the last feed print at or before the close, which can be hours old.
- The vaults close over weekends and holidays: they quote, sell, buy back and take deposits only in the regular and extended sessions (a redemption can still be queued).
- Liquidation and deficit auctions pause over weekends and while an underlying is halted, by design, and their discount clock stops over weekends and holidays. A gap larger than the weekend shock can still create bad debt; it goes through the waterfall and, as a last resort, the cash index.
- While a feed returns no usable price (unreadable, zero or outside the plausibility band), stock tokens held only as collateral are valued at 0. An account with options on that underlying can't withdraw, trade or be liquidated until the feed recovers.
- An agent's value-drain cap applies per trade. Many trades can add up to more than one cap; owners should size budgets and expiries with that in mind. Revoking an agent takes effect immediately.
- The Stylus program expires 365 days after activation. It must be kept alive (anyone can pay for that through ArbWasm), or every margin check fails.
- The stock-token issuer can pause transfers, blocklist addresses and burn tokens from any holder with `adminBurn`, the clearinghouse included.
- The NYSE holiday table covers 2026 and 2027. The contracts are immutable, so later years need a new deployment.
- 1 USDG is treated as 1 USD.
- Stock tokens are not available to US persons, and Novation inherits the issuer's restrictions. Derivatives on tokenized securities raise regulatory questions this build doesn't answer.
- On-chain portfolio margin exists elsewhere, for example Derive on its own chain. Novation's contribution is the stock-token market on Robinhood Chain, a Stylus kernel with measured gas, and scenarios that know the trading calendar.

Every public claim, with its evidence, is listed in [CLAIMS.md](CLAIMS.md).

## Repository layout

```text
contracts/                 Foundry project
  src/core/                Clearinghouse, RiskParams, MarketDataHub, SeriesRegistry, InsuranceFund, AuctionHouse
  src/core/logic/          MarginLogic, TradeLogic, SettlementLogic, AuctionHookLogic (linked libraries)
  src/kernel/              KernelReference.sol, the Solidity twin of the kernel
  src/libraries/           FixedPointMath, BlackScholes, NyseCalendar
  src/venues/              RfqVenue, CoveredCallVault, PutWriteVault, VaultPricing
  src/lens/                VaultQuoteLens, a read helper run as a deployless call
  src/mocks/               testnet-only tokens and feeds
  script/                  Deploy, Seed and SeedMainnet, DeployMocks
  test/                    unit, fuzz, invariant (test/invariant) and mainnet fork (test/fork) suites; test/vectors holds the shared parity vectors
  deployments/             addresses per chain id
kernel/                    Stylus risk kernel (Rust, stylus-sdk 0.10.9)
  src/                     fixed-point math, Black-Scholes, scenario grid, EWMA, ABI codec
  tests/                   parity, codec and exported-ABI tests
  bench/                   wasm instruction counts, on-chain gas probe, differential fuzz
sdk/                       TypeScript SDK (@novation/sdk): reads, simulated writes, EIP-712 quotes, refusal decoding
keeper/                    permissionless upkeep: vol sync, listing, settlement, claims, vault rolls, liquidations
mm-bot/                    RFQ market maker and its HTTP relay
mcp/                       MCP server for AI agents under an on-chain risk budget
app/                       Next.js web app, demo snapshot and live testnet mode
tools/
  ref/                     Python reference and vector generator
  stylus-deploy/           build checks, deploy and activation, on-chain parity
  deploy/                  testnet core deploy, mainnet go-live, library and role-key helpers
  e2e/                     end-to-end proofs (testnet scenario, weekend margin, mainnet proof steps)
  mirror-feeds.py          mirrors mainnet Chainlink rounds into the testnet mock feeds
docs/                      risk model, gas, deployments, architecture diagram
```

## Run it

Prerequisites: [Foundry](https://getfoundry.sh), Rust (the toolchain is pinned in `kernel/rust-toolchain.toml`), Python 3 for the tools, and Node with pnpm 9 for the app.

```bash
git clone --recurse-submodules https://github.com/RaYYeR220/novation.git novation
cd novation/contracts && forge build && forge test
cd ../kernel && cargo test --test parity
```

`forge test` runs the Solidity suites, including the parity vectors, the 256-position cap and a short campaign of the stateful invariant suite. `cargo test --test parity` checks the Rust kernel against the same vectors, integer for integer. `cargo test --release` runs the full kernel suite.

On the release tree, `forge test` runs 413 tests in 22 suites: 412 pass and 1 is skipped (the fork suite, without `RH_MAINNET_RPC`; with it, 5/5). The default campaign of the 18-invariant suite runs inside it. The TypeScript packages, with `pnpm --filter <package> test`: the SDK 194 (176 unit, 13 against a local anvil running the repo's deploy scripts, 5 read-only against testnet), the keeper 44 (32 unit, 12 on anvil), the market maker 75 (62 unit, 13 on anvil), the MCP server 29 (12 unit, 17 on anvil, 3 of them over stdio), and the app 216 unit and 48 end-to-end tests.

The invariant suite drives the whole system (trades, vaults, agents, time across sessions and expiries, settlement, liquidations, deficit sales). The `invariant-deep` profile runs a long campaign. The fork suite deploys the core against the real tokens and Chainlink feeds on Robinhood Chain mainnet; it is skipped unless `RH_MAINNET_RPC` is set. Both commands run from `contracts/`:

```bash
FOUNDRY_PROFILE=invariant-deep forge test --match-path "test/invariant/*"
RH_MAINNET_RPC=https://rpc.mainnet.chain.robinhood.com forge test --match-path "test/fork/*"
```

The on-chain tools need a few Python packages:

```bash
pip install requests eth-abi eth-account eth-utils brotli
python tools/stylus-deploy/parity.py --rpc https://rpc.testnet.chain.robinhood.com
```

To build the WASM program and check that it fits the 24 KB Stylus limit (needs `wasm-tools`):

```bash
cd kernel && cargo build --release --target wasm32-unknown-unknown
python ../tools/stylus-deploy/deploy.py --check-size target/wasm32-unknown-unknown/release/novation_kernel.wasm
```

The MCP server for agents needs a `pnpm install` at the root, then runs with `node mcp/bin/novation-mcp.mjs` (read-only without `NOVATION_AGENT_KEY`; setup in [mcp/README.md](mcp/README.md)).

The web app lives in `app/` and uses pnpm:

```bash
pnpm install
pnpm --filter @novation/app dev
```

The RFQ market maker in `mm-bot/` prices, margin-checks and signs quotes over HTTP: `pnpm --filter @novation/mm-bot start` (setup and endpoints in [mm-bot/README.md](mm-bot/README.md)). The web app also serves it at `/api/rfq` once the maker's server-only variables are set; without them that route answers 503.

The keeper syncs vol, lists the weekly grid, settles expiries and accounts, pays claims, rolls the vaults and runs liquidations: `pnpm --filter @novation/keeper loop` (see [keeper/README.md](keeper/README.md)).

## License

[MIT](LICENSE)
