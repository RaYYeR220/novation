'use client';

import { useCallback, useSyncExternalStore } from 'react';

/** Where the app reads from: the kernel-computed demo snapshot, or the contracts on RH Chain testnet. */
export type DataSource = 'demo' | 'live';

export const SOURCE_PARAM = 'data';
const STORAGE_KEY = 'novation:data';
const EVENT = 'novation:data-source';

/** The source when neither the URL nor this browser says otherwise. */
export const DEFAULT_SOURCE: DataSource = process.env.NEXT_PUBLIC_CLIENT === 'chain' ? 'live' : 'demo';

function parse(v: string | null | undefined): DataSource | undefined {
  return v === 'live' || v === 'demo' ? v : undefined;
}

function stored(): DataSource | undefined {
  try {
    return parse(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return undefined;
  }
}

/** The URL's ?data= first (so a shared link opens what was shared), then this browser's last choice. */
export function readSource(): DataSource {
  if (typeof window === 'undefined') return DEFAULT_SOURCE;
  return parse(new URLSearchParams(window.location.search).get(SOURCE_PARAM)) ?? stored() ?? DEFAULT_SOURCE;
}

/** The URL with ?data=live while live, without the parameter in demo. */
export function withSource(href: string, source: DataSource): string {
  const url = new URL(href, 'http://x');
  if (source === 'live') url.searchParams.set(SOURCE_PARAM, 'live');
  else url.searchParams.delete(SOURCE_PARAM);
  const q = url.searchParams.toString();
  return `${url.pathname}${q ? `?${q}` : ''}${url.hash}`;
}

/** Keeps the address bar in step with the source without a navigation. */
export function syncUrl(source: DataSource) {
  if (typeof window === 'undefined') return;
  const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const next = withSource(here, source);
  if (next !== here) window.history.replaceState(window.history.state, '', next);
}

export function setSource(source: DataSource) {
  try {
    window.localStorage.setItem(STORAGE_KEY, source);
  } catch {
    /* private mode or blocked storage: the URL still carries it */
  }
  syncUrl(source);
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  window.addEventListener('popstate', cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener('popstate', cb);
  };
}

/** The current source and a setter. The server render (and the first client render) use DEFAULT_SOURCE. */
export function useDataSource(): [DataSource, (s: DataSource) => void] {
  const source = useSyncExternalStore(subscribe, readSource, () => DEFAULT_SOURCE);
  const set = useCallback((s: DataSource) => setSource(s), []);
  return [source, set];
}
