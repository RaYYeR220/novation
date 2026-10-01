/**
 * The relay on node:http for local runs: `pnpm --filter @novation/mm-bot start`.
 * Reads the maker from the environment (see config.ts); MM_PORT (default 8787) and MM_HOST
 * (default 127.0.0.1). Logs one JSON line per request.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { fromWad } from '@novation/sdk';
import { makerFromEnv, type Env } from './config';
import { createRfqHandler } from './handler';

const MAX_BODY = 64 * 1024;

/** Serves a fetch-style handler over node:http. */
export function serve(handler: (req: Request) => Promise<Response>, opts: { port: number; host?: string }): Promise<Server> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > MAX_BODY) {
          res.writeHead(413, { 'content-type': 'application/json' }).end('{"error":{"code":"BadRequest","message":"body too large"}}');
          return;
        }
        chunks.push(c as Buffer);
      }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const body = req.method !== 'GET' && req.method !== 'HEAD' && chunks.length > 0 ? Buffer.concat(chunks) : undefined;
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const response = await handler(new Request(url, { method: req.method, headers, body }));
      const out: Record<string, string> = {};
      response.headers.forEach((v, k) => (out[k] = v));
      res.writeHead(response.status, out);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":{"code":"Internal","message":"server error"}}');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => resolve(server));
  });
}

export async function main(env: Env = process.env): Promise<Server> {
  const { maker, ctx } = await makerFromEnv(env);
  const info = await maker.info();
  const handler = createRfqHandler({
    maker,
    cors: env.MM_CORS || undefined,
    onEvent: (e) => console.log(JSON.stringify({ t: new Date().toISOString(), ...e })),
  });
  const port = Number(env.MM_PORT || 8787);
  const host = env.MM_HOST || '127.0.0.1';
  const server = await serve(handler, { port, host });
  console.log(
    JSON.stringify({
      t: new Date().toISOString(),
      msg: 'rfq maker listening',
      url: `http://${host}:${port}`,
      chainId: ctx.deployment.chainId,
      venue: ctx.deployment.rfq,
      maker: info.maker,
      makerId: info.makerId.toString(),
      ttl: info.ttl,
      maxQtyPerQuote: fromWad(info.maxQtyPerQuote),
      maxInventoryPerSeries: fromWad(info.maxInventoryPerSeries),
    }),
  );
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
