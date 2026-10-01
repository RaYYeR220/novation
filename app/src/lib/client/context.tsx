'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { NovationClient } from './types';
import { ChainClient } from './chain';
import { MockClient } from './mock';
import { DEFAULT_SOURCE, useDataSource, type DataSource } from './source';

const ClientContext = createContext<NovationClient | null>(null);

/** The demo snapshot (fixtures from the kernel reference), or the contracts on RH Chain testnet. */
export function createClient(source: DataSource = DEFAULT_SOURCE): NovationClient {
  return source === 'live' ? new ChainClient() : new MockClient();
}

export function ClientProvider({ children, client }: { children: ReactNode; client?: NovationClient }) {
  const [source] = useDataSource();
  const value = useMemo(() => client ?? createClient(source), [client, source]);
  return <ClientContext.Provider value={value}>{children}</ClientContext.Provider>;
}

export function useClient(): NovationClient {
  const c = useContext(ClientContext);
  if (!c) throw new Error('useClient must be used inside ClientProvider');
  return c;
}

/** The chain client in live mode (for transactions and chain-only reads); undefined in demo. */
export function useChainClient(): ChainClient | undefined {
  const c = useClient();
  return c instanceof ChainClient ? c : undefined;
}
