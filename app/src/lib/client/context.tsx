'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { NovationClient } from './types';
import { MockClient } from './mock';

const ClientContext = createContext<NovationClient | null>(null);

/** Mock unless NEXT_PUBLIC_CLIENT=chain (the chain client is not built yet). */
export function createClient(): NovationClient {
  if (process.env.NEXT_PUBLIC_CLIENT === 'chain') {
    throw new Error('NEXT_PUBLIC_CLIENT=chain: the chain client is not implemented yet');
  }
  return new MockClient();
}

export function ClientProvider({ children, client }: { children: ReactNode; client?: NovationClient }) {
  const value = useMemo(() => client ?? createClient(), [client]);
  return <ClientContext.Provider value={value}>{children}</ClientContext.Provider>;
}

export function useClient(): NovationClient {
  const c = useContext(ClientContext);
  if (!c) throw new Error('useClient must be used inside ClientProvider');
  return c;
}
