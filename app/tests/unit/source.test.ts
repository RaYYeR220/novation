import { describe, expect, it } from 'vitest';
import { DEFAULT_SOURCE, readSource, withSource } from '@/lib/client/source';

describe('data source in the URL', () => {
  it('adds ?data=live and drops it for demo, keeping the rest of the URL', () => {
    expect(withSource('/app/trade', 'live')).toBe('/app/trade?data=live');
    expect(withSource('/app/trade?data=live', 'demo')).toBe('/app/trade');
    expect(withSource('/app/portfolio?account=4#positions', 'live')).toBe('/app/portfolio?account=4&data=live#positions');
    expect(withSource('/app/portfolio?account=4&data=live', 'demo')).toBe('/app/portfolio?account=4');
    expect(withSource('/app/earn?data=demo', 'live')).toBe('/app/earn?data=live');
  });

  it('reads the default on the server', () => {
    expect(DEFAULT_SOURCE).toBe('demo');
    expect(readSource()).toBe(DEFAULT_SOURCE);
  });
});
