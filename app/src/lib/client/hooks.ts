'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useClient } from './context';
import { MockClient } from './mock';
import type { NewGrant, Session, Venue } from './types';

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
    enabled: id !== undefined && id > 0,
  });
}

export function useScenarioGrid(id: number | undefined, session?: Session) {
  const c = useClient();
  return useQuery({
    queryKey: ['grid', id, session],
    queryFn: () => c.scenarioGrid(id as number, session),
    enabled: id !== undefined && id > 0,
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
    enabled: id !== undefined && id > 0,
  });
}

export interface WhatIfArgs {
  id: number;
  seriesId: number;
  qtyDelta: number;
  premium: number;
  agent?: string;
  venue?: Venue;
}

/** The pre-sign what-if. Holds the last quote while a new one computes, so the ticket never blanks. */
export function useWhatIf(args: WhatIfArgs | null) {
  const c = useClient();
  return useQuery({
    queryKey: ['whatIf', args],
    queryFn: () => {
      const a = args as WhatIfArgs;
      return c.whatIf(a.id, a.seriesId, a.qtyDelta, a.premium, { agent: a.agent, venue: a.venue });
    },
    enabled: args !== null,
    placeholderData: keepPreviousData,
  });
}

export function useVault(address: string | undefined) {
  const c = useClient();
  return useQuery({ queryKey: ['vault', address], queryFn: () => c.vault(address as string), enabled: Boolean(address) });
}

export function useWallet(owner: string | undefined) {
  const c = useClient();
  return useQuery({ queryKey: ['wallet', owner], queryFn: () => c.wallet(owner as string), enabled: Boolean(owner) });
}

export function useExpiries(id: number | undefined) {
  const c = useClient();
  return useQuery({ queryKey: ['expiries', id], queryFn: () => c.expiries(id as number), enabled: id !== undefined && id > 0 });
}

export function usePools() {
  const c = useClient();
  return useQuery({ queryKey: ['pools'], queryFn: () => c.pools() });
}

export function useFeeds() {
  const c = useClient();
  return useQuery({ queryKey: ['feeds'], queryFn: () => c.feeds() });
}

export function useAuctions() {
  const c = useClient();
  return useQuery({ queryKey: ['auctions'], queryFn: () => c.auctions() });
}

export function useInsurance() {
  const c = useClient();
  return useQuery({ queryKey: ['insurance'], queryFn: () => c.insurance() });
}

export function useOpenInterest() {
  const c = useClient();
  return useQuery({ queryKey: ['openInterest'], queryFn: () => c.openInterest() });
}

export function useProtocol() {
  const c = useClient();
  return useQuery({ queryKey: ['protocol'], queryFn: () => c.protocol() });
}

export function useRefusals() {
  const c = useClient();
  return useQuery({ queryKey: ['refusals'], queryFn: () => c.refusalsFeed() });
}

/** grantAgent / revokeAgent; the account's grants re-read when either lands. */
export function useAgentActions(id: number) {
  const c = useClient();
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: ['agents', id] });
  const grant = useMutation({ mutationFn: (g: NewGrant) => c.grantAgent(id, g), onSuccess: done });
  const revoke = useMutation({ mutationFn: (agent: string) => c.revokeAgent(id, agent), onSuccess: done });
  return { grant, revoke };
}
