import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { decodeRefusal, RefusalError } from '@novation/sdk';
import { z } from 'zod';
import { MAX_AMOUNT, MAX_QTY, refusalLine, refusalView, toJson, ToolInputError } from './format';
import { verifiedAgentOf, type Session } from './session';
import * as t from './tools';

export const SERVER_NAME = 'novation';
export const SERVER_VERSION = '0.1.0';

export const READ_TOOLS = ['list_underlyings', 'get_chain', 'quote', 'what_if_margin', 'portfolio', 'risk_budget', 'explain_refusal'] as const;
export const TRADE_TOOLS = ['buy_from_vault', 'sell_to_vault', 'fill_rfq'] as const;

// Sanity caps (the handlers enforce them exactly): at most MAX_QTY contracts, MAX_AMOUNT USDG, 18 decimals.
const qtyArg = z.union([z.number().gt(0).lte(MAX_QTY), z.string().regex(/^\d{1,7}(\.\d{1,18})?$/)]);
const signedQtyArg = z.union([z.number().gte(-MAX_QTY).lte(MAX_QTY), z.string().regex(/^-?\d{1,7}(\.\d{1,18})?$/)]);
const amountArg = z.union([z.number().gte(0).lte(MAX_AMOUNT), z.string().regex(/^\d{1,10}(\.\d{1,18})?$/)]);
const intLike = z.union([z.number().int().nonnegative(), z.string().regex(/^\d{1,78}$/)]);
const accountArg = intLike.optional().describe("Subaccount id. Default: the account the server's agent key trades for.");
const seriesId = z.number().int().positive().max(2 ** 32 - 1).describe('Series id, from get_chain.');
const force = z
  .boolean()
  .optional()
  .default(false)
  .describe(
    'Default false: a ticket the simulation refuses is returned as a Refusal and never sent. True: send it anyway with a fixed gas limit, so the revert is mined on-chain (costs gas; use it only to produce on-chain proof of a refusal).',
  );
/**
 * A trading tool's input shape, with send_even_if_refused only when the operator set
 * NOVATION_ALLOW_FORCED_SEND=1. Without it the option is not in the schema (unknown keys are
 * stripped), and the handlers treat it as false.
 */
function tradeShape<T extends z.ZodRawShape>(s: Session, shape: T): T & { send_even_if_refused: typeof force } {
  return (s.allowForcedSend ? { ...shape, send_even_if_refused: force } : shape) as T & { send_even_if_refused: typeof force };
}
const slippage = z.number().int().min(0).max(5000).optional().describe('Price tolerance on the vault quote in basis points (default 200 = 2%).');

/** Runs a handler and shapes its result: the summary line, then the JSON, plus the same object as structuredContent. */
async function run(f: () => Promise<{ summary: string } & Record<string, unknown>>): Promise<CallToolResult> {
  try {
    const out = await f();
    const json = toJson(out);
    return { content: [{ type: 'text', text: `${out.summary}\n\n${json}` }], structuredContent: JSON.parse(json) as Record<string, unknown> };
  } catch (e) {
    const r = e instanceof RefusalError ? e.refusal : decodeRefusal(e);
    if (r) {
      const refusal = refusalView(r);
      const out = { status: 'refused', refusal, summary: `REFUSED: ${refusalLine(refusal)}` };
      return { content: [{ type: 'text', text: `${out.summary}\n\n${toJson(out)}` }], structuredContent: out };
    }
    const msg = e instanceof ToolInputError ? e.message : ((e as { shortMessage?: string }).shortMessage ?? (e as Error).message ?? String(e));
    return { isError: true, content: [{ type: 'text', text: msg }] };
  }
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

/**
 * The MCP server. Read tools are always there; the trading tools only when the session holds an
 * agent key that passed verifyAgent (read-only mode has none of them). A session with a key that
 * was never verified is refused outright.
 */
export function createServer(s: Session): McpServer {
  const verified = s.agent ? verifiedAgentOf(s) : undefined;
  if (s.agent && !verified) throw new Error('createServer: the agent key has not passed verifyAgent; verify the on-chain policy before serving it');
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: [
        'Novation is an options clearinghouse on Robinhood Chain: weekly cash-settled options on tokenized stocks, portfolio-margined across 39 price and volatility scenarios.',
        s.agent
          ? `You trade subaccount ${s.accountId} as an agent with an on-chain risk budget: the account's worst-case loss (initial margin) after any trade you open must stay within it. Check risk_budget and what_if_margin before trading. Every trade is simulated first; a refusal comes back as a structured Refusal and is not sent.`
          : 'Read-only mode: no agent key, so no trading tools.',
        'Amounts are decimal USDG, quantities are contracts (1 contract = 1 token of the underlying).',
      ].join(' '),
    },
  );

  server.registerTool(
    'list_underlyings',
    {
      title: 'List underlyings',
      description:
        'Every underlying stock token with its spot price, trading session (REGULAR, EXTENDED, WEEKEND, HOLIDAY, HALTED), the reason it is halted if it is, mark volatility, feed freshness, and whether this agent may trade it.',
      annotations: READ,
    },
    () => run(() => t.listUnderlyings(s)),
  );

  server.registerTool(
    'get_chain',
    {
      title: 'Option chain',
      description:
        "Listed series for one underlying and expiry: strike, type, mark price and delta at the mark vol, open interest, and the vault's ask (and bid where it can buy back) for qty contracts. Series the vault won't sell say why.",
      inputSchema: {
        underlying: z.string().describe('Symbol (NVDA, TSLA, AAPL, SPY) or token address.'),
        expiry: z.union([z.string(), z.number().int()]).optional().describe('Expiry as YYYY-MM-DD or unix seconds. Default: the nearest live expiry.'),
        type: z.enum(['call', 'put', 'both']).optional().describe('Default both.'),
        qty: qtyArg.optional().describe('Contracts to quote (default 1).'),
      },
      annotations: READ,
    },
    (a) => run(() => t.getChain(s, a)),
  );

  server.registerTool(
    'quote',
    {
      title: 'Vault quote',
      description:
        "The vault's ask (side buy) or bid (side sell) for qty contracts of a series: total premium, price per contract, the fee, and the total. A series the vault won't quote returns its Refusal.",
      inputSchema: {
        series_id: seriesId,
        qty: qtyArg.optional().describe('Contracts (default 1).'),
        side: z.enum(['buy', 'sell']).optional().describe('buy: you buy from the vault (ask). sell: you sell back to it (bid). Default buy.'),
      },
      annotations: READ,
    },
    (a) => run(() => t.quote(s, a)),
  );

  server.registerTool(
    'what_if_margin',
    {
      title: 'What-if margin',
      description:
        "The account's cash, equity and initial margin before and after a hypothetical trade, from the clearinghouse's own margin procedure (marginAfter), with every rule the trade will face in order (margin, risk budget, premium cap, value drain) and the refusal it would get, if any. Nothing is sent.",
      inputSchema: {
        series_id: seriesId,
        qty: signedQtyArg.describe('Signed contracts: positive buys, negative sells.'),
        premium: amountArg.optional().describe('Total premium in USDG. Default: the vault ask (buy) or bid (sell).'),
        account: accountArg,
      },
      annotations: READ,
    },
    (a) => run(() => t.whatIfMargin(s, a)),
  );

  server.registerTool(
    'portfolio',
    {
      title: 'Portfolio',
      description:
        "An account's cash, equity, initial and maintenance margin, positions, collateral, and its 39-scenario grid (13 price moves x 3 vol levels) with the worst case and each underlying's session-scaled shock range.",
      inputSchema: { account: accountArg },
      annotations: READ,
    },
    (a) => run(() => t.portfolio(s, a)),
  );

  server.registerTool(
    'risk_budget',
    {
      title: 'Risk budget',
      description:
        "The agent's on-chain policy for the account: the budget (cap on the account's worst-case loss, i.e. initial margin after a trade), how much is used (current initial margin), the headroom, the premium cap, the value-drain cap, allowed underlyings and expiry.",
      inputSchema: { account: accountArg, agent: z.string().optional().describe("Agent address. Default: this server's agent.") },
      annotations: READ,
    },
    (a) => run(() => t.riskBudget(s, a)),
  );

  server.registerTool(
    'explain_refusal',
    {
      title: 'Explain refusal',
      description: 'Why a mined transaction reverted: replays it against the chain and decodes the revert into a structured Refusal (code, numbers, the rule).',
      inputSchema: { tx_hash: z.string().describe('Transaction hash, 0x + 64 hex.') },
      annotations: READ,
    },
    (a) => run(() => t.explainRefusal(s, a)),
  );

  if (!verified) return server;

  server.registerTool(
    'buy_from_vault',
    {
      title: 'Buy from vault',
      description:
        "Buy qty contracts of a series from the option vault, signed with the agent key. The exact transaction is simulated first: if the chain would refuse it (risk budget, premium cap, margin, halted market...), the Refusal is returned and nothing is sent. Otherwise it is sent and the fill, premium, fee and the account's margin and budget after it are returned.",
      inputSchema: tradeShape(s, {
        series_id: seriesId,
        qty: qtyArg.describe('Contracts to buy, positive.'),
        max_premium: amountArg
          .optional()
          .describe("Most you will pay in total, USDG. Default: the vault's ask plus slippage_bps; required when the vault can't quote."),
        slippage_bps: slippage,
      }),
      annotations: WRITE,
    },
    (a) => run(() => t.buyFromVault(s, a)),
  );

  server.registerTool(
    'sell_to_vault',
    {
      title: 'Sell to vault',
      description:
        'Sell qty contracts of a series back to the vault (it buys back at most its short), signed with the agent key. Simulated first; a refusal is returned as a Refusal and not sent.',
      inputSchema: tradeShape(s, {
        series_id: seriesId,
        qty: qtyArg.describe('Contracts to sell back, positive.'),
        min_premium: amountArg
          .optional()
          .describe("Least you will accept in total, USDG. Default: the vault's bid minus slippage_bps; required when the vault can't quote."),
        slippage_bps: slippage,
      }),
      annotations: WRITE,
    },
    (a) => run(() => t.sellToVault(s, a)),
  );

  server.registerTool(
    'fill_rfq',
    {
      title: 'Fill RFQ quote',
      description:
        "Fill a market maker's EIP-712 signed quote on the RFQ venue, signed with the agent key. makerSells true: you buy; false: you sell. Simulated first; a refusal (bad signature, expired, overfilled, risk budget...) is returned as a Refusal and not sent.",
      inputSchema: tradeShape(s, {
        quote: z
          .object({
            signer: z.string(),
            makerId: intLike,
            seriesId: intLike,
            makerSells: z.boolean(),
            maxQty: intLike.describe('WAD contracts (1e18 = 1 contract).'),
            price: intLike.describe('WAD USDG per contract.'),
            deadline: intLike.describe('Unix seconds.'),
            nonce: intLike,
          })
          .describe('The signed quote as the maker published it; integers as decimal strings in raw on-chain units.'),
        signature: z.string().describe("The maker's signature, 0x hex."),
        qty: qtyArg.optional().describe('Contracts to fill. Default: all that is left on the quote.'),
      }),
      annotations: WRITE,
    },
    (a) => run(() => t.fillRfq(s, a)),
  );

  return server;
}
