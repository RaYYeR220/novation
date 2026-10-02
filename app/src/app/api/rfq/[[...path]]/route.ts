/**
 * The RFQ maker relay (`@novation/mm-bot`) at /api/rfq: GET /api/rfq/quotes?series=&side=&qty=,
 * POST /api/rfq/quote-request, GET /api/rfq for the maker's details. Live trade tickets ask it for
 * signed quotes.
 *
 * The relay is built on the first request, not when the module loads: `next build` and preview
 * deployments without the maker's variables still build, and until they are set every request
 * answers 503 RelayNotConfigured. Once built, the handler is kept for the life of the instance, so
 * its rate limits and live-quote book carry over between requests.
 *
 * Server-only variables, never NEXT_PUBLIC_*: MM_MAKER_PRIVATE_KEY, MM_MAKER_ID and MM_RPC_URL (or
 * RH_TESTNET_RPC), plus the optional MM_* pricing and limit settings (mm-bot/README.md).
 */
import { createRfqHandlerFromEnv } from '@novation/mm-bot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Handler = (req: Request) => Promise<Response>;

let relay: Handler | undefined;
let reported = false;

function getRelay(): Handler | undefined {
  if (relay) return relay;
  try {
    relay = createRfqHandlerFromEnv(process.env, { basePath: '/api/rfq' });
  } catch (e) {
    // the cause names the missing or invalid setting; it goes to the server log, not to clients
    if (!reported) console.error(`RFQ relay not configured: ${e instanceof Error ? e.message : String(e)}`);
    reported = true;
    return undefined;
  }
  return relay;
}

async function handle(req: Request): Promise<Response> {
  const h = getRelay();
  if (h) return h(req);
  return Response.json(
    { error: { code: 'RelayNotConfigured', message: 'This deployment runs no RFQ maker: the relay has no maker key configured.' } },
    { status: 503, headers: { 'retry-after': '60', 'cache-control': 'no-store' } },
  );
}

export { handle as GET, handle as POST, handle as OPTIONS };
