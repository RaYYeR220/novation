import { memoryEventCache, type CachedScan, type EventCache } from '@novation/sdk';

const BIG = '__bigint';

function replacer(_k: string, v: unknown) {
  return typeof v === 'bigint' ? { [BIG]: v.toString() } : v;
}

function reviver(_k: string, v: unknown) {
  if (v && typeof v === 'object' && BIG in v && Object.keys(v).length === 1) return BigInt((v as Record<string, string>)[BIG]!);
  return v;
}

/**
 * An EventCache kept in memory and mirrored to sessionStorage, so a reload in the same tab scans only
 * the blocks it hasn't seen. Storage that is missing, full or blocked just falls back to memory.
 */
export function sessionEventCache(prefix: string): EventCache {
  const mem = memoryEventCache();
  return {
    get(key) {
      const hit = mem.get(key);
      if (hit) return hit;
      try {
        const raw = typeof window === 'undefined' ? null : window.sessionStorage.getItem(`${prefix}:${key}`);
        if (!raw) return undefined;
        const scan = JSON.parse(raw, reviver) as CachedScan;
        mem.set(key, scan);
        return scan;
      } catch {
        return undefined;
      }
    },
    set(key, scan) {
      mem.set(key, scan);
      try {
        if (typeof window !== 'undefined') window.sessionStorage.setItem(`${prefix}:${key}`, JSON.stringify(scan, replacer));
      } catch {
        /* storage full or blocked: memory still has it */
      }
    },
  };
}
