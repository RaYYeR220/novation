# @novation/mcp

An MCP server that lets any AI agent trade a Novation account inside an on-chain risk budget.

The account owner grants an agent key an `AgentPolicy` on the clearinghouse: a cap on the account's worst-case loss (its initial margin after a trade), a premium cap per trade, a cap on the value one trade may give up against the mark, the underlyings it may touch and an expiry. The server holds that agent key and nothing else. Every trade it signs is simulated first, so a ticket the chain would refuse comes back to the agent as a structured `Refusal` (the contract's error name, its numbers and the rule in one sentence) instead of a failed transaction.

It speaks MCP over stdio, so it works with any MCP client: a desktop assistant, an IDE, or your own agent loop.

## Tools

| Tool | What it does |
|---|---|
| `list_underlyings` | Every underlying with spot, session (`REGULAR`, `EXTENDED`, `WEEKEND`, `HOLIDAY`, `HALTED`), the halt reason if halted, mark vol, feed age, and whether this agent may trade it |
| `get_chain` | Listed series for an underlying and expiry: strike, type, mark price and delta, open interest, and the vault's ask and bid for a quantity. Series the vault won't sell say why (type, tenor, distance from spot, delta band) |
| `quote` | The vault's ask (buy) or bid (sell back) for a series and quantity, with the fee and the total |
| `what_if_margin` | Cash, equity and initial margin before and after a hypothetical trade, from the clearinghouse's own `marginAfter`, plus every rule the trade will face (margin, risk budget, premium cap, value drain) and the refusal it would get |
| `portfolio` | Account state, positions, collateral, and the 39-scenario grid (13 price moves x 3 vol levels) with the worst case and each underlying's session-scaled shock range |
| `risk_budget` | The agent's policy: budget, used (the current initial margin), headroom, premium cap, value-drain cap, allowed underlyings, expiry |
| `buy_from_vault` | Buy from the covered-call or cash-secured-put vault, signed with the agent key |
| `sell_to_vault` | Sell back to the vault (it buys back at most its short) |
| `fill_rfq` | Fill a market maker's EIP-712 signed quote on the RFQ venue |
| `explain_refusal` | Why a mined transaction reverted: replays it and decodes the revert into a `Refusal` |

Amounts are decimal USDG, quantities are contracts (one contract is one token of the underlying). Quantities are capped at 1,000,000 contracts and amounts at 1,000,000,000 USDG, with at most 18 decimals. Every successful result starts with a one-line `summary` and carries the full object as `structuredContent`; a bad argument or a failed read comes back as a tool error with a plain message.

### How a trade runs

`buy_from_vault`, `sell_to_vault` and `fill_rfq` run the same way:

1. The price limit comes from the vault's quote plus or minus `slippage_bps` (default 2%), or from `max_premium` / `min_premium`. If the vault can't quote the trade and no limit was given, the tool returns `{ status: "no_quote", sent: false, refusal }` and sends nothing: there is never a default limit.
2. The exact transaction is simulated from the agent's address (`eth_call`).
3. If the chain would refuse it, the tool returns `{ status: "refused", sent: false, refusal: { code, message, numbers } }`. Nothing is signed or sent.
4. Otherwise it is signed locally and sent with the gas estimate plus 25% (margin-check gas moves with the block timestamp), and the tool returns `{ status: "filled", txHash, premium, fee, accountAfter, budget }`.
5. A transaction that still reverts on-chain returns `status: "refused"` with the decoded refusal, or `status: "out_of_gas"` when it burned its gas limit: that is not a policy refusal, and the trade can be retried.
6. When an underlying's vol is further behind its feed than a trade's own sync folds (more than 64 rounds, or a feed migration awaiting a rebase), the vault won't quote and the chain refuses the trade (`VolNotCurrent`). With the market open, the tool first catches the vol up with the agent key (`syncVol`, or `syncAndRebaseVol` after a migration; both are permissionless), then quotes or simulates again, and the result's `note` lists those transactions. The catch-up stops when a sync doesn't advance the vol, and one server session sends at most `NOVATION_MAX_VOL_SYNCS` such transactions in all (default 8; 0 turns it off). Vaults are closed over weekends and holidays whatever the vol.

`send_even_if_refused` exists only when the operator starts the server with `NOVATION_ALLOW_FORCED_SEND=1`; otherwise it isn't in the schema. With it set to `true`, a refused ticket is sent anyway with a fixed gas limit (`NOVATION_REFUSAL_GAS`, default 5,000,000), so the revert is mined and anyone can verify the refusal on-chain. It costs gas and changes nothing else.

A refusal looks like this:

```json
{
  "status": "refused",
  "sent": false,
  "refusal": {
    "code": "AgentRiskBudgetExceeded",
    "message": "Worst-case loss after this trade exceeds the agent's risk budget.",
    "numbers": { "id": 9, "worstLoss": 4.018316, "budget": 1.53888 }
  },
  "summary": "REFUSED (not sent): AgentRiskBudgetExceeded: worst-case loss after the trade 4.018316 USDG > the agent's budget 1.53888 USDG. The simulation of this exact transaction reverted, so nothing was signed or sent."
}
```

`fill_rfq` takes the quote as the maker published it, integers as decimal strings in raw on-chain units:

```json
{
  "quote": {
    "signer": "0x...", "makerId": "3", "seriesId": "5", "makerSells": true,
    "maxQty": "2000000000000000000", "price": "1490000000000000000",
    "deadline": "1790971200", "nonce": "8411..."
  },
  "signature": "0x...",
  "qty": 1
}
```

## Security model

- **The server only ever holds an agent key.** There is no setting for an owner key. If `NOVATION_AGENT_KEY` owns any subaccount at all (an owner key can withdraw and re-grant), the server refuses to start.
- **It refuses to start without a live policy.** At startup it reads `agentPolicy(account, agent)` on-chain and exits unless a policy exists and has not expired. Without `NOVATION_ACCOUNT` it looks the account up in the `AgentGranted` log and needs exactly one live grant.
- **The chain is the authority.** The simulation is a courtesy to the agent: the same rules are enforced by `TradeLogic` in the transaction itself, so a modified or compromised server can't trade past the budget either. An agent can't withdraw, deposit stock collateral, grant or revoke agents, or call the clearinghouse directly; the server exposes none of that.
- **Revocation is immediate.** Once the owner calls `revokeAgent`, every simulation refuses with `NotAuthorized` and the server won't start again.
- **No trading before verification.** The trading tools are registered only for a session that passed the on-chain check; `createServer` refuses a session whose key was never verified, and the trading handlers check it again.
- **No default price limits.** Every trade carries a limit taken from a live quote or given by the caller; without either, nothing is sent.
- **Forced sends are the operator's call.** `send_even_if_refused` burns gas by design, so the model only sees it when the operator sets `NOVATION_ALLOW_FORCED_SEND=1`.
- **Read-only mode.** Without a key the server starts with the read tools only.
- **No secrets in output.** The key is used only to sign; tool results and logs never contain it. Logs go to stderr, since stdout carries the protocol.
- **Known limit.** The value-drain cap applies per trade, so many trades can add up to more than one cap ([SECURITY.md](../SECURITY.md)). Size the premium cap and the policy expiry with that in mind.

## Run it

From the repository root:

```bash
pnpm install
# read-only, Robinhood Chain testnet
node mcp/bin/novation-mcp.mjs
# as an agent
NOVATION_AGENT_KEY=0x... NOVATION_ACCOUNT=12 node mcp/bin/novation-mcp.mjs
```

| Variable | Meaning |
|---|---|
| `NOVATION_AGENT_KEY` | The agent's private key. Absent: read-only mode |
| `NOVATION_ACCOUNT` | The subaccount the agent trades for. Absent: found from the `AgentGranted` log |
| `NOVATION_RPC_URL` | JSON-RPC endpoint. Default: the chain's public RPC |
| `NOVATION_CHAIN_ID` | Default `46630` (Robinhood Chain testnet) |
| `NOVATION_DEPLOYMENT` | Path to a `contracts/deployments/<chainId>.json`, for a local or new deployment |
| `NOVATION_REFUSAL_GAS` | Gas limit for `send_even_if_refused`. Default 5,000,000 |
| `NOVATION_ALLOW_FORCED_SEND` | `1` adds `send_even_if_refused` to the trading tools. Default off |
| `NOVATION_MAX_VOL_SYNCS` | Most vol catch-up transactions the agent key sends over the session (default 8; `0` turns the catch-up off) |

### MCP client configuration

Any MCP client that launches stdio servers takes a block like this (use absolute paths):

```json
{
  "mcpServers": {
    "novation": {
      "command": "node",
      "args": ["/path/to/novation/mcp/bin/novation-mcp.mjs"],
      "env": {
        "NOVATION_AGENT_KEY": "0x<agent key>",
        "NOVATION_ACCOUNT": "<subaccount id>",
        "NOVATION_RPC_URL": "https://rpc.testnet.chain.robinhood.com"
      }
    }
  }
}
```

Leave out `NOVATION_AGENT_KEY` and `NOVATION_ACCOUNT` for a read-only server.

## Demo

`scripts/demo-agent.ts` runs an agent's session end to end on testnet: it derives an owner key and an agent key from the deployer key, funds them with a little gas, has the owner open an account and grant a budget of 1.5x the initial margin of one call, then starts this server over stdio and calls it as an agent would: `risk_budget`, `what_if_margin`, `buy_from_vault` for 1 call (in budget, sent), for 3 more (refused in simulation, not sent), the same with `send_even_if_refused` (the revert is mined), then `explain_refusal` on that transaction.

```bash
pnpm --filter @novation/mcp demo
```

The keccak256(deployerKey ‖ role) keys are a testnet demo convenience: whoever holds the deployer key controls them, and the script refuses to run on any chain but Robinhood Chain testnet (46630). Use an independent agent key for anything real. The demo starts the server with `NOVATION_ALLOW_FORCED_SEND=1` and a minimal environment, so the server process sees the agent key and nothing else from the shell.

It reads `DEPLOYER_PRIVATE_KEY` and `RH_TESTNET_RPC` from the root `.env` and writes the transaction hashes and the transcript to [`out/46630.json`](out/46630.json).

The run on Robinhood Chain testnet, abridged. It ran on the testnet's second core stack (Clearinghouse `0x0b0F…1949`), which stays on-chain next to the current one ([why there are several stacks](../docs/deployments.md#why-there-are-several-stacks)):

```text
> risk_budget {}
< budget 0.767935 USDG, used 0, headroom 0.767935 USDG; premium cap 25 USDG; NVDA allowed until 2026-10-09T11:18:13Z
> what_if_margin {"series_id":129,"qty":1}
< PASSES: initial margin 0 -> 0.51174 USDG, budget 0.767935 USDG
> buy_from_vault {"series_id":129,"qty":1}
< FILLED: buy 1 NVDA 2026-10-02 250 C for 0.67934 USDG (fee 0.070507); initial margin 0.509432 of budget 0.767935 USDG; tx 0xf1791085...
> buy_from_vault {"series_id":129,"qty":3}
< REFUSED (not sent): AgentRiskBudgetExceeded: worst-case loss after the trade 2.037482 USDG > the agent's budget 0.767935 USDG. ...
> buy_from_vault {"series_id":129,"qty":3,"send_even_if_refused":true}
< REFUSED ON-CHAIN: AgentRiskBudgetExceeded: worst-case loss after the trade 2.037235 USDG > the agent's budget 0.767935 USDG. The transaction was mined and reverted: 0x43941aae...
> explain_refusal {"tx_hash":"0x43941aae..."}
< 0x43941aae... was refused on-chain: AgentRiskBudgetExceeded: worst-case loss after the trade 2.037235 USDG > the agent's budget 0.767935 USDG
```

- In-budget fill: [`0xf17910855569d9d6fed1b5ef3676ac48599e955b3dc889ee7bdc5d7d1f109542`](https://explorer.testnet.chain.robinhood.com/tx/0xf17910855569d9d6fed1b5ef3676ac48599e955b3dc889ee7bdc5d7d1f109542)
- Over-budget buy, mined as a revert: [`0x43941aae0c18d7d004d052fd4baa72ccbb74fddd9ffe0d9e6d4dcb57407b42fe`](https://explorer.testnet.chain.robinhood.com/tx/0x43941aae0c18d7d004d052fd4baa72ccbb74fddd9ffe0d9e6d4dcb57407b42fe)
- The same session on the first stack (Clearinghouse `0xe799…ABB2`, still on-chain): in-budget fill [`0x0307e2d5…`](https://explorer.testnet.chain.robinhood.com/tx/0x0307e2d54fd130e1858ce85cc1dfd72e37bedc0434f9429abbe213f8388b36fc), mined refusal [`0x2aa5a4ce…`](https://explorer.testnet.chain.robinhood.com/tx/0x2aa5a4ceaf099d14136d921b29b5bc2bce8b52f618b25e4935b04494210f1064)

## Tests

```bash
pnpm --filter @novation/mcp test:unit
pnpm --filter @novation/mcp test:anvil
```

The anvil suite reuses the SDK's fixture (a local anvil, `KernelReference` as the kernel, the repository's own deploy and seed scripts). It runs every tool handler in-process: startup refusals for an owner key, a missing or revoked policy; the reads; an in-budget fill; an over-budget refusal that sends nothing; the mined refusal and its explanation; a sale back to the vault; an RFQ fill and a tampered quote. A second file spawns the real server over stdio and drives it with the MCP client.
