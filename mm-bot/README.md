# @novation/mm-bot

An RFQ market maker for Novation. It prices weekly options off the hub's mark vol, checks that a fill would keep its own account above initial margin, and only then signs an EIP-712 quote that any taker can fill through `RfqVenue`. The relay is one web-standard handler, `(Request) => Promise<Response>`, so the same code runs behind `node:http` locally or as a Next.js route handler.

Live on Robinhood Chain testnet: maker `0xFa29A382CF892496A70CC95327072FDAcDD39555`, subaccount `7`. A taker filled a quote served by this relay in [0x883c803d…](https://explorer.testnet.chain.robinhood.com/tx/0x883c803d27356c5d1a6d368090fc845b0d8a3848539cfbb85ab7c9d62e3988c5): 1 NVDA 240 call expiring 2026-10-02, at 4.151995 USDG.

## Run it

From the repo root, with `DEPLOYER_PRIVATE_KEY` and `RH_TESTNET_RPC` in `.env`:

```bash
pnpm install
pnpm --filter @novation/mm-bot setup:maker   # once: maker key, gas, mock USDG, subaccount, deposit
pnpm --filter @novation/mm-bot start         # the relay on http://127.0.0.1:8787
pnpm --filter @novation/mm-bot fill --qty 1  # a throwaway taker fills one quote on chain
```

`setup:maker` derives the maker key as `keccak256(deployerKey ‖ "maker")`, tops it up with at most 0.0004 ETH from the deployer, mints mock USDG, opens a subaccount and deposits 100,000 USDG (`MM_SETUP_CASH`). Each step is skipped when it is already done. It prints the maker address and subaccount id, never a key. `fill` does the same for a taker (`‖ "taker"`), asks the relay for a quote on the NVDA call nearest the money and fills it with the SDK's `simulateRfqFill`.

| Variable | Default | |
| --- | --- | --- |
| `MM_MAKER_PRIVATE_KEY` | derived from `DEPLOYER_PRIVATE_KEY` | Owner or agent of the maker subaccount |
| `MM_MAKER_ID` | the key's first subaccount | Maker subaccount |
| `MM_CHAIN_ID` | `46630` | Robinhood Chain testnet |
| `MM_RPC_URL` | `RH_TESTNET_RPC`, then the public RPC | |
| `MM_PORT`, `MM_HOST` | `8787`, `127.0.0.1` | Standalone server only |
| `MM_CORS` | none | `Access-Control-Allow-Origin` value |
| `MM_TTL` | `60` | Quote lifetime, seconds |
| `MM_MAX_QTY` | `10` | Contracts per quote |
| `MM_MAX_INVENTORY` | `50` | Contracts per series, counting live quotes |
| `MM_DEFAULT_QTY` | `1` | Size when a request names none |
| `MM_VOL_SPREAD` | `0.05` | Vol points added to the ask, taken off the bid |
| `MM_PRICE_SPREAD` | `0.01` | Price markup on the ask, markdown on the bid |
| `MM_SKEW_SLOPE` | `0.1` | Vol add per unit of \|ln(K/S)\| |
| `MM_INVENTORY_SLOPE` | `0.2` | Vol lean at a full inventory cap |
| `MM_MARGIN_BUFFER` | `0.2` | Equity must stay above IM × 1.2 after the fill |
| `MM_MAX_PRICE_AGE` | the hub's limit | Tighter bound on the feed's age, seconds |
| `MM_MIN_TIME_TO_EXPIRY` | `900` | No quotes this close to expiry, seconds |

## Endpoints

`side` is always the taker's: `buy` means the taker buys and the maker sells. Sizes are decimal contracts.

**`GET /quotes?series=<id>&side=buy|sell&qty=<n>`** returns signed quotes, both sides when `side` is left out. Status 200 when at least one side is quoted, 422 when none is.

```json
{
  "series": 1,
  "quotes": [{
    "side": "buy",
    "quote": { "signer": "0xFa29…9555", "makerId": "7", "seriesId": 1, "makerSells": true,
               "maxQty": "1000000000000000000", "price": "4151995000000000000",
               "deadline": "1790875446", "nonce": "7628…3696" },
    "signature": "0x…", "hash": "0xfe9f…0719", "premium": "4151995000000000000",
    "chainId": 46630, "venue": "0x56562573b74A6cD6ca96cfb794A63625A48edf08", "expiresAt": 1790875446,
    "display": { "price": 4.151995, "qty": 1, "premium": 4.151995, "vol": 1.5623, "mark": 3.8261, "spot": 230.2283, "session": "REGULAR" }
  }],
  "refusals": [{ "side": "sell", "code": "NoBid", "message": "…" }]
}
```

`quote` is the `RfqVenue.Quote` struct with integers as decimal strings (WAD for `maxQty` and `price`). `fromJson()` turns it back into the struct for `simulateRfqFill`.

**`POST /quote-request`** with `{"series": 1, "side": "buy", "qty": "2.5"}` returns one firm quote (the same object as above), or 422 with `{"error": {"code", "message"}}`. Nothing is signed on a refusal.

**`GET /`** returns the maker, its subaccount, the chain, the venue, the caps and how many quotes are live.

Refusal codes: `Halted`, `StalePrice`, `StaleVol`, `Expired`, `NearExpiry`, `QtyTooSmall`, `SizeCap`, `InventoryCap`, `NoBid`, `MakerMargin`, `MakerCash`, `UnknownSeries`, `Unavailable`. A malformed request gets 400.

## Pricing

The quote follows the option vaults' shape, made two-sided. With `vol` the hub's mark vol and `m = |ln(K/S)|`:

```
volMid  = vol × (1 + skewSlope × m)
ask vol = volMid × (1 + inventorySlope × shortUse) + sessionAdd + volSpread
bid vol = volMid × (1 − inventorySlope × longUse)  − sessionAdd − volSpread
ask     = ceil(max(BS(ask vol), mark) × (1 + priceSpread))
bid     = floor(min(BS(bid vol), mark) × (1 − priceSpread))
```

- **The Black-Scholes** is a TypeScript port of `BlackScholes.sol`, so it returns the same integer as the kernel's `bsQuote` and the mark the clearinghouse gives the position. The anvil test checks this against the deployed kernel.
- **Inventory lean.** `shortUse` and `longUse` are the maker's position after the fill, counting its live quotes in the series, as a fraction of the inventory cap. As the maker gets shorter the ask rises, and as it gets longer the bid falls.
- **Session widening.** `sessionAdd` widens both sides while the stock market is closed: 0.02 in extended hours, 0.05 over weekends and holidays.
- **Clamped to the mark.** The ask is never below the mark and the bid never above it, so a fill never hands value to the counterparty against the clearinghouse's own mark.
- **Ticks.** Prices round to whole micro-USDG, the ask up and the bid down.

Before pricing, the bot refuses in these cases:
- the hub reports the underlying `HALTED`, opening is paused or the underlying is disabled;
- the feed's last round is older than the hub's limit for the session (or `MM_MAX_PRICE_AGE`);
- the mark vol is stale;
- the series has expired or is within 15 minutes of expiry;
- the size is above the per-quote cap or below the minimum trade;
- the fill would push the maker's position past the inventory cap (a quote that reduces the position is always allowed).

Before signing, it runs the clearinghouse's own `marginAfter` as an `eth_call` on the maker account. The input is the fill plus the maker's live quotes on the same side, and the premium as the cash change. When equity after the fill would be below IM × (1 + buffer), the quote is refused with `MakerMargin`; when the maker can't pay a premium, it is refused with `MakerCash`. The venue and the clearinghouse still enforce margin at fill time. This check keeps the maker from signing a quote it couldn't honour.

Every quote expires 60 seconds after it is made and carries a random 256-bit nonce. Quotes are made one at a time, so two concurrent requests can't both spend the same inventory room.

## Mounting in Next.js

```ts
// app/src/app/api/rfq/[...path]/route.ts
import { createRfqHandlerFromEnv } from '@novation/mm-bot';

const handler = createRfqHandlerFromEnv(process.env, { basePath: '/api/rfq' });
export { handler as GET, handler as POST, handler as OPTIONS };
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
```

The app adds `"@novation/mm-bot": "workspace:*"` to its dependencies and lists `@novation/mm-bot` and `@novation/sdk` in `transpilePackages` in `next.config.ts`, since both packages ship TypeScript source. The route needs `MM_MAKER_PRIVATE_KEY`, `MM_MAKER_ID` and `MM_RPC_URL` (or `RH_TESTNET_RPC`) as server-only variables, never `NEXT_PUBLIC_*`, plus any of the pricing variables. The maker is built on the first request. `createRfqHandler({ maker })` takes a `Maker` you build yourself instead.

## Tests

```bash
pnpm --filter @novation/mm-bot test:unit    # pricing, Black-Scholes, handler, server, keys
pnpm --filter @novation/mm-bot test:anvil   # needs anvil and forge
```

The anvil suite reuses the SDK's fixture: a local chain with the repo's forge deploy scripts and `KernelReference` as the kernel. On it, a taker fills a quote the bot signed through `RfqVenue`, an expired quote is refused with `QuoteExpired`, and an over-margin quote is never issued: the same quote signed by hand is refused at fill with `InsufficientMargin`. It also checks that the local Black-Scholes matches the kernel integer for integer, the inventory cap, the cash check and that the bot stops quoting a halted underlying.

## Limits

- Live quotes are tracked in memory, per process. Several relay instances for one maker don't see each other's quotes. The clearinghouse still holds each fill to the maker's margin.
- Anyone can request quotes. A burst of requests holds inventory room until those quotes expire, 60 seconds at most.
- On testnet, USDG, the stock tokens and the price feeds are mocks ([MOCKS.md](../MOCKS.md)), so testnet quotes are only as good as the mock prices.
