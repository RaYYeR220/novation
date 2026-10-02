import { afterAll, describe, expect, it, vi } from 'vitest';
import { keccak256, toHex } from 'viem';
import { GET, OPTIONS, POST } from '@/app/api/rfq/[[...path]]/route';

const URL = 'http://localhost/api/rfq';

describe('the RFQ relay route', () => {
  afterAll(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('answers 503 RelayNotConfigured without a maker key, and keeps the cause in the server log', async () => {
    vi.stubEnv('MM_MAKER_PRIVATE_KEY', '');
    vi.stubEnv('DEPLOYER_PRIVATE_KEY', '');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const r of [
      await GET(new Request(`${URL}/quotes?series=1&side=buy&qty=1`)),
      await POST(new Request(`${URL}/quote-request`, { method: 'POST', body: '{"series":1,"side":"buy","qty":"1"}' })),
      await OPTIONS(new Request(URL, { method: 'OPTIONS' })),
    ]) {
      expect(r.status).toBe(503);
      expect(r.headers.get('retry-after')).toBe('60');
      const body = (await r.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('RelayNotConfigured');
      expect(body.error.message).not.toMatch(/MM_|DEPLOYER|KEY/);
    }
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toMatch(/MM_MAKER_PRIVATE_KEY/);
  });

  it('mounts the relay at /api/rfq once a maker key is set, without touching the chain for a malformed request', async () => {
    vi.stubEnv('MM_MAKER_PRIVATE_KEY', keccak256(toHex('novation-route-test-maker')));
    vi.stubEnv('MM_MAKER_ID', '7');
    vi.stubEnv('MM_RPC_URL', 'http://127.0.0.1:1');
    const r = await GET(new Request(`${URL}/quotes?series=abc&side=buy&qty=1`));
    expect(r.status).toBe(400);
    const missing = await GET(new Request(`${URL}/nowhere`));
    expect(missing.status).toBe(404);
  });
});
