'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useClient } from './context';
import { MockClient } from './mock';
import type { Session } from './types';

/** True when the app reads fixtures instead of the chain. */
export function useIsDemo(): boolean {
  return useClient() instanceof MockClient;
}

export function useAsOf() {
  const c = useClient();
  return useQuery({ queryKey: ['asOf'], queryFn: () => c.asOf() });
}

export function useUnderlyings() {
  const c = useClient();
  return useQuery({ queryKey: ['underlyings'], queryFn: () => c.underlyings() });
}

export function useChain(symbol: string | undefined) {
  const c = useClient();
  return useQuery({
    queryKey: ['chain', symbol],
    queryFn: () => c.chain(symbol as string),
    enabled: Boolean(symbol),
  });
}

export function useSubaccount(id: number | undefined) {
  const c = useClient();
  return useQuery({
    queryKey: ['account', id],
    queryFn: () => c.account(id as number),
    enabled: id !== undefined,
  });
}

export function useScenarioGrid(id: number | undefined, session?: Session) {
  const c = useClient();
  return useQuery({
    queryKey: ['grid', id, session],
    queryFn: () => c.scenarioGrid(id as number, session),
    enabled: id !== undefined,
  });
}

export function useVaults() {
  const c = useClient();
  return useQuery({ queryKey: ['vaults'], queryFn: () => c.vaults() });
}

export function useAgents(id: number | undefined) {
  const c = useClient();
  return useQuery({
    queryKey: ['agents', id],
    queryFn: () => c.agents(id as number),
    enabled: id !== undefined,
  });
}

export interface WhatIfArgs {
  id: number;
  seriesId: number;
  qtyDelta: number;
  premium: number;
  agent?: string;
}

/** The pre-sign what-if. Holds the last quote while a new one computes, so the ticket never blanks. */
export function useWhatIf(args: WhatIfArgs | null) {
  const c = useClient();
  return useQuery({
    queryKey: ['whatIf', args],
    queryFn: () => {
      const a = args as WhatIfArgs;
      return c.whatIf(a.id, a.seriesId, a.qtyDelta, a.premium, a.agent);
    },
    enabled: args !== null,
    placeholderData: keepPreviousData,
  });
}
