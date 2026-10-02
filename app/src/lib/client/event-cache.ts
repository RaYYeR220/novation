import { memoryEventCache, type CachedScan, type EventCache } from '@novation/sdk';

const BIG = '__bigint';

function replacer(_k: string, v: unknown) {
  return typeof v === 'bigint' ? { [BIG]: v.toString() } : v;
}

function reviver(_k: string, v: unknown) {
  if (v && typeof v === 'object' && BIG in v && Object.keys(v).length === 1) return BigInt((v as Record<string, string>)[BIG]!);
  return v;
}

/** Larger scans stay in memory only. */
export const MAX_PERSISTED_BYTES = 256 * 1024;
/** Keys kept in sessionStorage; the least recently written go first. */
export const MAX_PERSISTED_KEYS = 64;

/**
 * An EventCache kept in memory and mirrored to sessionStorage, so a reload in the same tab scans only
 * the blocks it hasn't seen. The mirror is bounded: an entry over MAX_PERSISTED_BYTES is not stored,
 * and at most MAX_PERSISTED_KEYS entries are, least recently written evicted first. Storage that is
 * missing, full or blocked just falls back to memory.
 */
export function sessionEventCache(prefix: string): EventCache {
  const mem = memoryEventCache();
  const indexKey = `${prefix}:index`;
  const storage = (): Storage | undefined => {
    try {
      return typeof window === 'undefined' ? undefined : window.sessionStorage;
    } catch {
      return undefined;
    }
  };
  const readIndex = (st: Storage): string[] => {
    try {
      const v = JSON.parse(st.getItem(indexKey) ?? '[]');
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  };
  return {
    get(key) {
      const hit = mem.get(key);
      if (hit) return hit;
      try {
        const raw = storage()?.getItem(`${prefix}:${key}`);
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
      const st = storage();
      if (!st) return;
      try {
        const index = readIndex(st).filter((k) => k !== key);
        const raw = JSON.stringify(scan, replacer);
        if (raw.length > MAX_PERSISTED_BYTES) {
          st.removeItem(`${prefix}:${key}`);
        } else {
          st.setItem(`${prefix}:${key}`, raw);
          index.push(key);
        }
        while (index.length > MAX_PERSISTED_KEYS) st.removeItem(`${prefix}:${index.shift()!}`);
        st.setItem(indexKey, JSON.stringify(index));
      } catch {
        /* storage full or blocked: memory still has it */
      }
    },
  };
}
